# Examples

Two scripts, each in two steps, each run as two processes on purpose. Splitting them that way is the
point: the only thing that crosses between the first process and the second is MongoDB. Nothing is
cached in a variable, nothing is passed on a queue, and if the second step prints what the first one
stored then the storage worked.

| Script | What it proves | Needs |
|---|---|---|
| `memory_recall.py` | A fact learned in one process comes back in the next, from a query with no word in common with it | Atlas with an embedding model registered on the cluster, so `$vectorSearch` can embed server-side. A deployment without one has no vector tier, and the recall step finds nothing |
| `unified_storage.py` | Three SDK subsystems write to one collection under three key prefixes, and a session survives the process that made it | Any deployment, including a plain local `mongod` |

## Setup

```bash
pip install "strands-mongodb[all]"
export MONGODB_URI="mongodb+srv://..."
```

`[all]` because `memory_recall.py` needs the memory surface and `unified_storage.py` needs the storage
one. `[storage]` alone is enough for `unified_storage.py` if that is all you want to run.

Nothing is on PyPI yet, so that `pip install` resolves to nothing for now. Until it does, install from
the repository over SSH, as the package README's
[Before the package reaches PyPI](../README.md#before-the-package-reaches-pypi) section describes.

`MONGODB_URI` is the only variable either script requires. Both refuse to run without it and name it in
the message. Where a script prints the URI it prints it redacted, with everything between `://` and
the last `@` replaced by `<redacted>`, on every path including failures.

Keep the URI in a file you do not commit and load it at the shell:

```bash
set -a; . .env; set +a
```

Run from the `python/` directory. The scripts import a sibling `_support.py`, so `python
examples/memory_recall.py` works and `cd examples && python memory_recall.py` does not.

## Look before you connect

Every step takes `--dry-run`, which prints what the step would do and the command for the next one, then
returns before the first client is constructed. No variable needs to be set:

```bash
python examples/memory_recall.py write --dry-run
```

Use it to read the plan against your own cluster's contents before pointing anything at it. Both scripts
write to `strands_examples.example` by default, and both take `--database` and `--collection`.

## memory_recall.py

```bash
python examples/memory_recall.py write
python examples/memory_recall.py recall
```

`write` runs one agent turn. The turn contains a durable fact and some small talk. An extraction trigger
fires when the turn settles, an extractor keeps the fact and drops the rest, and the fact goes into
MongoDB. Then the process exits, taking every Python object and the connection pool with it.

`recall` starts cold and asks a question that shares no word with what was stored:

```
stored:  the guest prefers a window table for two on thursday evenings
query:   where should we seat them
```

A keyword scan answers that with nothing. What answers it is a vector search over embeddings the Atlas
cluster generated server-side, which is this package's default: no embedding code, no API key, no model
of your own. The script checks the two strings are word-disjoint at runtime and stops if an edit ever
made them overlap, because a query sharing one content word with the answer would prove nothing.

Two stores share one collection and differ by `scope`. The assistant writes to the guest's own notes and
reads a curated policy store it is not allowed to write to (`writable=False`). Every result prints the
store that produced it, so you can see the search fan out across both and come back attributed.

`--scope` gives a run its own namespace, which is worth using if you share a cluster.

## unified_storage.py

```bash
python examples/unified_storage.py run
python examples/unified_storage.py resume
```

`Agent(storage=...)` takes one backend and hands it to every subsystem that does not bring its own. So
one `MongoDBStorage` ends up serving three writers at once:

```
session/    conversation snapshots, from SnapshotSessionManager
context/    the turn's messages, stashed by the context manager
memory/     a knowledge file, from FileMemoryStore(storage=...)
```

`run` produces all three in one turn, then prints a census of the collection: every top-level prefix
with a document count and a byte total. The census is read back from MongoDB with a plain
`AsyncMongoClient`, not assembled from a list in the script, because these are ordinary documents.
`mongosh` would give the same answer.

`resume` starts a new interpreter, restores the session from `session/` alone, and prints how many
messages came back.

One thing the key names invite you to get wrong: the `memory/` documents are **not** vector memory.
`Storage` moves opaque bytes under a string key, and `FileMemoryStore`'s recall is token overlap over the
key space, so it matches file names rather than the text inside them. `MongoDBMemoryStore` is a different
collection with typed fields and a vector index on it. That is what `memory_recall.py` shows.

`--session-id` gives a run its own session.

## The model

Both scripts run their turn against a scripted model that reads its replies from a list in
`_support.py`. So the turn costs nothing, reads the same on every run, and works for a reader with no
Bedrock access. Every MongoDB call is real either way. Each script says which model it used in its
output rather than leaving you to guess whether a plausible-looking reply came from a provider.

Pass `--model bedrock` to run the same script against the SDK's default provider, using whatever region
and credentials your environment already has.

## Reading the output as a test

Every line is numbered, which makes a step that printed nothing between line 4 and line 5 visible.
`--summary-json` adds one machine-readable line at the end, off by default so a reader sees prose only.
The acceptance tests in `tests/test_examples.py` run these files as subprocesses and assert on that JSON
line rather than on the prose, which is what lets the prose be rewritten without breaking them.

## `_support.py`

Shared scaffolding: the `MONGODB_URI` lookup with the redacted echo, the argument parser both scripts
use, the scripted model, and the prefix census. Not part of the installed package and not API. The names
in it are stable only for the two scripts beside it.
