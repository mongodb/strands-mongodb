# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) SDK.

This is the Python half of the [strands-mongodb](../README.md) repository. One MongoDB deployment
sits behind both of the SDK's persistence extension points:

| Surface | Class | Module | Extra | SDK protocol | Serves |
|---|---|---|---|---|---|
| Storage | `MongoDBStorage` | `strands_mongodb.storage` | `[storage]` | `strands.storage.Storage` | Sessions, context offloading, memory persistence, context history, transcripts |
| Memory | `MongoDBMemoryStore` | `strands_mongodb.memory_store` | `[memory]` | `strands.memory` `MemoryStore` | Semantic recall over Atlas Vector Search, extraction writes |

Note that the memory module and its extra are spelled differently: `strands_mongodb.memory_store` is
installed by `strands-mongodb[memory]`.

Either class can be imported from the package root or from its own module:

```python
from strands_mongodb import MongoDBStorage          # resolved on first access
from strands_mongodb.storage import MongoDBStorage  # identical class
```

The root import resolves the class lazily, so it imports only the module you name. On a
`[storage]`-only install, `import strands_mongodb` followed by `MongoDBStorage` never touches the
memory module and never needs `pymongo-search-utils`. The one exception is
`from strands_mongodb import *`, which walks `__all__` and therefore loads both.

The `Storage` protocol is the leverage point: the SDK accepts a single top-level `storage` on
`Agent`, and five subsystems inherit it. One correct `MongoDBStorage` therefore delivers session
management and context offloading without a separate session-manager class.

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
| `strands-agents` | >= 1.48.0, the release that introduced the unified `Storage` interface |
| MongoDB | Atlas, or a self-managed deployment. Vector search requires Atlas or an Atlas CLI local deployment. |

## Development

```bash
pip install -e '.[all,dev]'

hatch run test          # unit tier, no MongoDB needed
hatch run lint
hatch run typecheck
hatch run prepare       # format, lint, typecheck, test
```

The test suite is tiered by what infrastructure it needs. Tiers whose backend is absent are
skipped with a reason, never silently passed:

| Tier | Marker | Backend | Gate |
|---|---|---|---|
| Unit | none | Mocked `AsyncMongoClient` | Always runs |
| Contract | `contract` | Any real MongoDB | `MONGODB_URI` |
| Integration | `integration` | Atlas or Atlas CLI local, with `mongot` | `MONGODB_ATLAS_URI` |
| AutoEmbeddings | `autoembed` | Cluster with a registered Atlas embedding model | `MONGODB_AUTOEMBED_URI` |
| Compatibility | `compat` | Latest published `strands-agents`, not the pinned one | CI cron only |

Two markers mean two requirements, not either one: an `autoembed` test also carries `integration`
and needs both variables set.

```bash
hatch run test                                  # unit only
MONGODB_URI=mongodb://localhost:27017 hatch run test
hatch run cov                                   # release gate: 90% aggregate, 70% per module
```

Each test session writes to a database named `strands_mongodb_test_<random>` and drops it at the
end, so pointing `MONGODB_URI` at a deployment you care about is survivable but still not advised.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
