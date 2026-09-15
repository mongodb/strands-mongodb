# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) SDK.

One MongoDB deployment behind the SDK's two extension points:

| Surface | Class | SDK protocol | Serves |
|---|---|---|---|
| Storage | `MongoDBStorage` | `strands.storage.Storage` | Sessions, context offloading, memory persistence, context history, transcripts |
| Memory | `MongoDBMemoryStore` | `strands.memory` `MemoryStore` | Semantic recall over Atlas Vector Search, extraction writes |

The `Storage` protocol is the leverage point: the SDK accepts a single top-level `storage` on
`Agent`, and **five** subsystems inherit it. One correct `MongoDBStorage` therefore delivers
session management and context offloading without a separate session-manager class.

## Status

> **Under construction. Not usable as a backend yet.** The metadata, the extras, the module paths and
> the public class names are final and installable, and `MongoDBStorage` resolves a connection pool
> that every instance sharing a config object reuses. What is missing is what an `Agent` actually
> calls: the five `Storage` contract methods, `namespace()`, `delete_prefix()`, and the memory store's
> operations. They are absent rather than stubbed, so reaching for one raises `AttributeError`.
>
> | Version | Contains |
> |---|---|
> | `0.0.1` | Package metadata, extras, import paths, public names |
> | `0.1.0` | `MongoDBStorage` + `MongoDBMemoryStore`, vector search, docs, tests |
>
> Landed on the way there, with all three test tiers green against MongoDB 8.3.8: the configuration
> types, connection resolution and teardown, the metadata filter guard, and index management, meaning
> the vector and full-text search indexes, an idempotent verify-or-create, and readiness polling.
>
> Tracked under [PENGINT-151](https://jira.mongodb.org/browse/PENGINT-151).

## Install

Pick the surface you need. Each extra pulls only its own dependencies.

```bash
pip install 'strands-mongodb[storage]'   # MongoDBStorage
pip install 'strands-mongodb[memory]'    # MongoDBMemoryStore
pip install 'strands-mongodb[all]'       # both
```

> **Quote the brackets.** In `zsh` (the default macOS shell) and `fish`, an unquoted
> `pip install strands-mongodb[storage]` fails with `no matches found` because the shell tries to
> glob the brackets. `bash` is unaffected. The quoted form above works in every shell.

A bare `pip install strands-mongodb` installs no runtime dependencies and gives you no working
backend. It is metadata only. The extra you choose is what selects the dependency set, so
`[storage]` never drags in vector-search machinery you are not using.

## Requirements

| | |
|---|---|
| Python | >= 3.10 |
| `strands-agents` | >= 1.48.0, the release that introduced the unified `Storage` interface and `StorageError` |
| MongoDB | Atlas, or a self-managed deployment. Vector search requires Atlas or an Atlas CLI local deployment. |

## Repository layout

| Directory | Package | Publishes to |
|---|---|---|
| `python/` | `strands-mongodb` | PyPI |

A `typescript/` sibling publishing the same name to npm is deferred pending the parity spike
(`TS-1`); the layout above reserves the shape so it can be added without moving files.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
