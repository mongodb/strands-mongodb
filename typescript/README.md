# strands-mongodb

MongoDB storage and memory backends for the [Strands Agents](https://strandsagents.com) TypeScript SDK.

This is the TypeScript half of the [strands-mongodb](https://github.com/mongodb/strands-mongodb/blob/main/README.md) repository, and the
[Python package](https://github.com/mongodb/strands-mongodb/blob/main/python/README.md) of the same name is the other.
The two write the same documents, create the same indexes and name their spans and log events the same way, so one
deployment can serve agents in both languages. [Sharing a collection with Python](#sharing-a-collection-with-python)
covers the one difference you can see in the data.

One MongoDB deployment sits behind both of the SDK's persistence extension points:

| Surface | Class                | SDK interface | Serves                                                                         |
| ------- | -------------------- | ------------- | ------------------------------------------------------------------------------ |
| Storage | `MongoDBStorage`     | `Storage`     | Sessions, context offloading, memory persistence, context history, transcripts |
| Memory  | `MongoDBMemoryStore` | `MemoryStore` | Semantic recall over Atlas Vector Search, extraction writes                    |

Both come from the package root, which is the only entry point:

<!-- run: unit -->

```ts
import { MongoDBMemoryStore, MongoDBStorage, VERSION } from 'strands-mongodb'

console.assert(typeof MongoDBStorage === 'function' && typeof MongoDBMemoryStore === 'function', VERSION)
```

The SDK's `Storage` interface is what makes one backend serve five subsystems: `Agent` takes a single top-level
`storage`, and session management and context offloading both inherit it. Each is still turned on with the SDK's own
objects (`SessionManager`, and `contextManager: 'auto'`), and neither needs a MongoDB-specific class.

![strands-mongodb in a Strands agent: the SDK's session manager, context manager and memory manager use MongoDBStorage and MongoDBMemoryStore, which store to MongoDB](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/architecture.png)

## Install

<!-- skip: installs from npm, which no test tier reaches -->

```bash
npm install strands-mongodb mongodb @strands-agents/sdk @opentelemetry/api
```

The package has no dependencies of its own. The driver, the SDK and the OpenTelemetry API are peer dependencies, so
your application owns one copy of each and this package uses it: a second `mongodb` would mean a second connection
pool, and a second `@opentelemetry/api` a tracer provider that never sees your spans. npm 7 and later install missing
peers for you, but naming them keeps their versions in your own `package.json`.

## Quickstart

The test suite runs both snippets below directly from this file. Each reads its connection string from `MONGODB_URI`
and its database from `MONGODB_DATABASE`, defaulting to `agents`.

### Storage

<!-- run: contract -->

```ts
import { MongoDBStorage } from 'strands-mongodb'
import type { MongoDBConfig } from 'strands-mongodb'

const uri = process.env.MONGODB_URI
if (uri === undefined) throw new Error('Set MONGODB_URI to a MongoDB deployment.')
const connection: MongoDBConfig = { connectionString: uri, database: process.env.MONGODB_DATABASE ?? 'agents' }

const storage = new MongoDBStorage(connection, { collection: 'storage' })
try {
  await storage.write('notes/deployment', new TextEncoder().encode('the cluster is in us-east-1'))
  console.log(new TextDecoder().decode((await storage.read('notes/deployment')) ?? new Uint8Array()))
  console.log(await storage.list('notes/'))
  await storage.delete('notes/deployment')
} finally {
  await storage.close()
}
```

Nothing has to be provisioned first. Storage needs no index the server does not already create, which is the reason
keys are stored as `_id`.

### Memory

This one needs an Atlas cluster with a registered embedding model, because it takes the default path where the
deployment embeds the text and you never handle a vector.

<!-- run: autoembed -->

```ts
import type { MemoryEntry } from '@strands-agents/sdk'
import { MongoDBMemoryStore } from 'strands-mongodb'
import type { MongoDBConfig } from 'strands-mongodb'

const uri = process.env.MONGODB_URI
if (uri === undefined) throw new Error('Set MONGODB_URI to an Atlas cluster with an embedding model.')
const connection: MongoDBConfig = { connectionString: uri, database: process.env.MONGODB_DATABASE ?? 'agents' }

const store = new MongoDBMemoryStore({ name: 'preferences', config: connection, scope: 'user-abc', writable: true })
try {
  await store.initialize() // creates the indexes; every other operation calls it too
  await store.add('Prefers metric units and a 24-hour clock.')

  // Atlas embeds a new document asynchronously, after the write is acknowledged, and on a new collection the
  // text index can finish before the vector one. Until the vector tier is ready a search answers lexically, so
  // this query finds nothing for a few minutes rather than failing.
  let found: MemoryEntry[] = []
  for (let attempt = 0; attempt < 90 && found.length === 0; attempt++) {
    found = await store.search('how should times be displayed for this person?')
    if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  if (found.length === 0) throw new Error('The vector index or the embedding is not ready yet. Run this again.')

  for (const entry of found) console.log(entry.metadata?._relevance_score, entry.content)
} finally {
  await store.close()
}
```

The query shares no word with the stored fact. That is the point of the vector tier, and it is also why the first run
of this snippet is slower. The first `search` waits for the first index to be ready, and when that is the text index,
searches answer lexically until a retry finds the vector index ready: 60 s later, then at doubling intervals up to
3600 s. On an existing collection both indexes are ready at once.

To give an agent both surfaces, pass one config to both and let the SDK wire them:

<!-- skip: needs a model provider and its credentials, which no test tier configures -->

```ts
import { Agent, MemoryManager, SessionManager } from '@strands-agents/sdk'

const store = new MongoDBMemoryStore({ name: 'preferences', config: connection, scope: 'user-abc', writable: true })
const agent = new Agent({
  model: yourModel,
  storage: new MongoDBStorage(connection),
  sessionManager: new SessionManager({ sessionId: 'support-ticket-4127' }),
  memoryManager: new MemoryManager({ stores: [store], addToolConfig: true }),
})
```

The two `true`s are what let the agent save anything. `MemoryManager` always gives the model a `search_memory` tool,
but it adds `add_memory` only when `addToolConfig` is set, and the SDK defaults it to `false`. The store must also be
writable, and this package defaults `writable` to `false`. With neither set, the agent can recall memories but has no
way to save new ones. If you would rather the SDK pick facts out of the conversation than leave it to the model, set
`extraction: true` on the writable store instead of, or as well as, `addToolConfig`.

One `storage` on `Agent` serves five subsystems, but it doesn't turn them on. The `sessionManager` line above is what
persists the conversation under its session id. To offload context as well, pass `contextManager: 'auto'`.

## Connecting to a deployment

`MongoDBConfig` takes either a client you built or a connection string, and it needs one of the two. In preference
order:

| How                                               | Key                | What it costs you                                                                        |
| ------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Inject a client                                   | `client`           | Nothing. The credential stays inside an object you own, and you get every driver option. |
| A connection string with a passwordless mechanism | `connectionString` | Your deployment has to be set up for X.509, AWS IAM, OIDC or Kerberos.                   |
| A connection string with a password               | `connectionString` | The password is now a value in a plain object.                                           |

That order is a security order, not a style one. A config is a plain object, and a plain object ends up in error
reports, log records and debugger views. An injected client keeps the credential out of it:

<!-- run: contract -->

```ts
import { MongoClient } from 'mongodb'
import { MongoDBStorage } from 'strands-mongodb'

const uri = process.env.MONGODB_URI
if (uri === undefined) throw new Error('Set MONGODB_URI to a MongoDB deployment.')
const client = new MongoClient(uri)

const storage = new MongoDBStorage({ client, database: process.env.MONGODB_DATABASE ?? 'agents' })
try {
  await storage.write('notes/injected', new TextEncoder().encode('the credential never entered the config'))
  await storage.delete('notes/injected')
} finally {
  // `storage.close()` deliberately does nothing to an injected client. It is yours, and something else in the
  // process may still be using it.
  await client.close()
}
```

`clientOptions` covers the middle ground: this package passes it to the `MongoClient` it builds from your connection
string, so TLS settings, timeouts and read preferences all reach the driver without an injected client.

<!-- driver-info -->

Every client this package uses identifies the package in its connection handshake, the way MongoDB's handshake
specification asks a library that wraps the driver to: it adds `Strands-MongoDB` and the installed version to the
driver name and version the server records. Server logs and `$currentOp` show this as `clientMetadata.driver`. A
client this package builds gets it at construction, through the driver's `driverInfo` option; an injected `client`
gets it through the driver's `appendMetadata`, once. `appName` stays yours: the package never sets, defaults or
changes it.

### Authentication mechanisms

The driver decides what is available here, not this package. `mongodb` 7 declares `MONGODB-AWS`, `MONGODB-OIDC`,
`MONGODB-X509`, `GSSAPI`, `PLAIN`, `SCRAM-SHA-1` and `SCRAM-SHA-256`, and any of them works through either route
above: as `authMechanism` in the connection string, or as an option to the client you inject. Whether your
deployment accepts one is a question for the deployment.

Two need a package you install yourself, because the driver declares them as optional peers:
`@aws-sdk/credential-providers` for `MONGODB-AWS`, and `kerberos` for `GSSAPI`. Without one, the failure arrives on the
first connection, not at startup, so a misconfigured process starts cleanly and fails on its first operation.

## Configuration reference

Every key of every configuration type is listed here. A test compares these tables against the declarations, so a key
added to the package and not to this file fails the build.

### `MongoDBConfig`

The connection half. Build one per process and share it: stores whose configs have the same connection identity
share one client and its pool.

<!-- keys: MongoDBConfig -->

| Key                   | Type                                       | Required | Default         | What it does                                                                                                                                                             |
| --------------------- | ------------------------------------------ | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database`            | `string`                                   | yes      |                 | Database holding every collection this config reaches.                                                                                                                   |
| `client`              | `MongoClient`                              | no       |                 | A client you built. Preferred over `connectionString`, and this package never closes it.                                                                                 |
| `connectionString`    | `string`                                   | no       |                 | A MongoDB URI. Required unless `client` is set; supplying neither throws `TypeError`.                                                                                    |
| `clientOptions`       | `MongoClientOptions`                       | no       | `{}`            | Extra options for the client this package builds. Ignored when `client` is set.                                                                                          |
| `ensureIndexes`       | `boolean`                                  | no       | `true`          | Whether to create missing indexes. `false` verifies and reports instead. See [Ensure versus verify](#ensure-versus-verify).                                              |
| `indexReadyTimeoutMs` | `number`                                   | no       | `300000`        | Milliseconds to wait for each search index to become queryable, timed separately per index. Raise it on a shared deployment where a build queues behind somebody else's. |
| `searchType`          | `'auto' \| 'vector' \| 'text' \| 'hybrid'` | no       | `'auto'`        | Which memory search tiers to prepare and query.                                                                                                                          |
| `embeddingModel`      | `string`                                   | no       | `voyage-4-lite` | Atlas embedding model, on the automated-embedding path where the deployment embeds your text.                                                                            |
| `embeddingDimensions` | `number`                                   | no       |                 | Vector length, on the manual path where you supply the vectors. Mutually exclusive with `embeddingModel`, and requires `similarity`.                                     |
| `similarity`          | `'cosine' \| 'dotProduct' \| 'euclidean'`  | no       |                 | Distance metric, on the manual path. Requires `embeddingDimensions`. No default: the right metric is a property of your embeddings.                                      |
| `filterFields`        | `string[]`                                 | no       | `[]`            | Extra document paths a caller may filter on. `scope` and `store_name` are always declared.                                                                               |
| `vectorIndexName`     | `string`                                   | no       | `vector_index`  | Name of the Atlas Vector Search index.                                                                                                                                   |
| `textIndexName`       | `string`                                   | no       | `text_index`    | Name of the Atlas Search full-text index.                                                                                                                                |

### `MongoDBMemoryStoreConfig`

The one argument of `new MongoDBMemoryStore(config)`. The first five keys come from the SDK's `MemoryStoreConfig` and
behave as they do for any store, with one exception noted below.

<!-- keys: MongoDBMemoryStoreConfig -->

| Key                | Type                          | Required | Default        | What it does                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------- | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `string`                      | yes      |                | Identifies the store. Stamped on every document as `store_name` and part of every read predicate.                                                                                                                                                                                                                                      |
| `description`      | `string`                      | no       |                | Passed to the SDK, which shows it to the model when it chooses a store.                                                                                                                                                                                                                                                                |
| `maxSearchResults` | `number`                      | no       | `10`           | Default result count, not a ceiling. A per-call `limit` overrides it, and so does the SDK `search_memory` tool's own argument, which the model chooses. Below 1 throws `RangeError`.                                                                                                                                                   |
| `writable`         | `boolean`                     | no       | `false`        | Gates `add`, `delete` and `deleteAll`. `false` here, unlike `FileMemoryStore`: the cost of the wrong default is a retrieval store that starts accepting model-written memories.                                                                                                                                                        |
| `extraction`       | `ExtractionConfig \| boolean` | no       |                | Passed to the SDK's extractor. This package never extracts anything itself.                                                                                                                                                                                                                                                            |
| `config`           | `MongoDBConfig`               | yes      |                | The connection, nested. Share one across stores.                                                                                                                                                                                                                                                                                       |
| `collection`       | `string`                      | no       | `memory`       | Collection holding this store's documents.                                                                                                                                                                                                                                                                                             |
| `scope`            | `string`                      | no       | `__unscoped__` | Tenant boundary. Stamped on writes and applied to reads by this package, never by the caller. Absence is a distinct scope, never "everything".                                                                                                                                                                                         |
| `filter`           | `Record<string, unknown>`     | no       |                | Extra search predicate, composed as a narrowing conjunction. It cannot widen what this store can read. Paths must appear in `filterFields`.                                                                                                                                                                                            |
| `minScore`         | `number`                      | no       |                | Relevance floor. Applied after the search, so it drops results without changing their order.                                                                                                                                                                                                                                           |
| `maxScore`         | `number`                      | no       |                | Relevance ceiling. Mutually exclusive with `minScore`.                                                                                                                                                                                                                                                                                 |
| `ttlSeconds`       | `number`                      | no       |                | How long a memory lives, measured from its own `created_at`. Absent means it never expires and stamps no field; `0` means "at the next sweep" and is a real value, not a disabled one; a negative value throws `RangeError`. Set on insert, so re-remembering a fact does not extend it. `initialize()` already creates the TTL index. |
| `embedder`         | `Embedder`                    | no       |                | Manual-vector path only: embeds on `add()` and string `search()`. See [Supplying your own vectors](#supplying-your-own-vectors).                                                                                                                                                                                                       |

### `MongoDBSearchQuery`

Passed to `search()` instead of a plain string, when a per-query filter, limit or embedding is needed. Every key is
optional, but at least one of `text` and `vector` has to be set. Setting both is valid only on a manual-vector store
whose `searchType` is `'auto'` or `'hybrid'`, where the hybrid tier reads one key in each of its two pipelines;
anywhere else it throws.

<!-- keys: MongoDBSearchQuery -->

| Key                  | Type                      | Required | Default | What it does                                                                                          |
| -------------------- | ------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `text`               | `string`                  | no       |         | The query text. What `search('...')` fills in.                                                        |
| `vector`             | `number[]`                | no       |         | A query embedding, on the manual-vector path. Combined with `text` only by the hybrid tier, as above. |
| `filter`             | `Record<string, unknown>` | no       |         | Narrows this query only. Same rules as the store's `filter`.                                          |
| `limit`              | `number`                  | no       | `10`    | Result ceiling for this query. Outranks both `maxSearchResults` settings.                             |
| `oversamplingFactor` | `number`                  | no       | `10`    | Multiplier turning the limit into a `$vectorSearch` candidate count.                                  |

### `MongoDBStorageOptions`

The second argument of `new MongoDBStorage(config, options)`, the same split as the SDK's `S3Storage`. The config can
be the same object a memory store holds.

<!-- keys: MongoDBStorageOptions -->

| Key              | Type             | Required | Default   | What it does                                                                                                                      |
| ---------------- | ---------------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `collection`     | `string`         | no       | `storage` | Collection holding this instance's documents.                                                                                     |
| `prefix`         | `string`         | no       | `''`      | Prepended to every key, scoping this instance inside the collection. Normalized to end in one `/`.                                |
| `ttlSeconds`     | `number`         | no       |           | Lifetime of the documents this instance writes. Needs the TTL index; see [Limits](#limits). A negative value throws `RangeError`. |
| `searchStrategy` | `SearchStrategy` | no       |           | What `search()` runs instead of the default key-only scan. Shared by `namespace()` views.                                         |

#### Searching storage

By default `search()` scores keys only, in one server-side query that reads no values. A word that is only inside a
value doesn't match, and `FileMemoryStore` keeps its facts there, under keys named after their topic. For
`FileMemoryStore`, pass a strategy that reads values: the SDK's `KeywordSearchStrategy` matches shared words, and the
vector strategy below matches by meaning.

#### Vector search over storage

`MongoDBVectorSearchStrategy` is the MongoDB counterpart of the SDK's `S3VectorSearchStrategy`. It stores each value's
vector on the value's own document. Empty and non-UTF-8 values aren't indexed. Each value is embedded whole, so it must
fit the embedding model's input; a longer one makes `write()` throw after the value is stored. Values written before
the strategy was configured have no vector, so vector search can't find them until they're rewritten.

Every write through the storage is embedded, so give the strategy only to the storage you search, in its own
collection. On `new Agent({ storage })` it would also embed session snapshots on every turn.

<!-- skip: it needs an embedding model and Atlas Vector Search -->

```ts
import { BedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { MongoDBStorage, MongoDBVectorSearchStrategy } from 'strands-mongodb'

const memoryStorage = new MongoDBStorage(connection, {
  collection: 'memory_files',
  searchStrategy: new MongoDBVectorSearchStrategy({
    embedder: new BedrockEmbedder(),
    dimensions: 1024,
    similarity: 'cosine',
  }),
})
await memoryStorage.ensureIndexes() // also creates the vector index
const knowledge = new FileMemoryStore({ name: 'facts', storage: memoryStorage })
```

<!-- keys: MongoDBVectorSearchStrategyOptions -->

| Key                  | Type                                      | Required | Default                | What it does                                                               |
| -------------------- | ----------------------------------------- | -------- | ---------------------- | -------------------------------------------------------------------------- |
| `embedder`           | `Embedder`                                | yes      |                        | Anything with an async `embed(text)`, such as the SDK's `BedrockEmbedder`. |
| `dimensions`         | `number`                                  | yes      |                        | The embedder's vector length, from 1 to 8192.                              |
| `similarity`         | `'cosine' \| 'dotProduct' \| 'euclidean'` | yes      |                        | The distance metric the index compares with.                               |
| `indexName`          | `string`                                  | no       | `storage_vector_index` | Name of the vector index on the storage's collection.                      |
| `maxResults`         | `number`                                  | no       | `10`                   | Most results one search returns.                                           |
| `oversamplingFactor` | `number`                                  | no       | `10`                   | Multiplier turning `maxResults` into a candidate count.                    |

### What the methods return

| Method                                                  | Returns                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MongoDBStorage.read(key)`                              | `Uint8Array`, or `null` when the key is absent                                                                                      |
| `MongoDBStorage.list(prefix)`                           | `string[]` of keys                                                                                                                  |
| `MongoDBStorage.search(query)`                          | `StorageSearchResult[]`, the SDK's type                                                                                             |
| `MongoDBStorage.deletePrefix(prefix)`                   | `number`, the documents removed                                                                                                     |
| `MongoDBStorage.namespace(prefix)`                      | A second `MongoDBStorage` over the same collection, scoped under `prefix`                                                           |
| `MongoDBMemoryStore.add(content, metadata)`             | `MongoDBAddResult`, with `ids`, `inserted` and `duplicates`. A fact already stored counts as a duplicate rather than a second write |
| `MongoDBMemoryStore.search(query, options)`             | `MemoryEntry[]`, the SDK's type, carrying the reserved metadata keys below                                                          |
| `MongoDBMemoryStore.delete(memoryId)` and `deleteAll()` | `number`, the documents removed                                                                                                     |

Both stores also implement `Symbol.asyncDispose`, so `await using storage = new MongoDBStorage(...)` closes it at the
end of the block.

### Errors

Failures from the database come back as the SDK's `StorageError`, with the namespace in the message and the driver's
error as its `cause`. A caller mistake that no round trip could fix is thrown before anything is sent: a `RangeError`
for a number out of range, a `TypeError` for a value of the wrong shape, and a plain `Error` for a combination the
configuration does not allow, such as both score bounds or a write to a read-only store. Every message starts with the
class that threw it, `MongoDBStorage:` or `MongoDBMemoryStore:`, and never includes a key, content or a credential.

### Everything the package exports

<!-- api -->

| Name                                 | Kind     | What it is                                                                |
| ------------------------------------ | -------- | ------------------------------------------------------------------------- |
| `MongoDBStorage`                     | class    | The SDK's `Storage` over one collection                                   |
| `MongoDBMemoryStore`                 | class    | The SDK's `MemoryStore` over Atlas Search and Vector Search               |
| `MongoDBVectorSearchStrategy`        | class    | A `SearchStrategy` for `MongoDBStorage`, over Atlas Vector Search         |
| `MongoDBConfig`                      | type     | The connection and deployment settings                                    |
| `MongoDBMemoryStoreConfig`           | type     | The memory store's one constructor argument                               |
| `MongoDBStorageOptions`              | type     | The storage's second constructor argument                                 |
| `MongoDBVectorSearchStrategyOptions` | type     | The vector strategy's constructor argument                                |
| `MongoDBSearchQuery`                 | type     | A query for `MongoDBMemoryStore.search()` in place of a string            |
| `MongoDBAddResult`                   | type     | What `MongoDBMemoryStore.add()` resolves to                               |
| `SearchType`                         | type     | The values `searchType` accepts: `auto`, `vector`, `text`, `hybrid`       |
| `ResolvedSearchType`                 | type     | The tiers that can answer, as `_search_type` reports them                 |
| `VectorSimilarity`                   | type     | The metrics `similarity` accepts                                          |
| `configureLogging`                   | function | Sends this package's log records to a logger of your choosing             |
| `RESERVED_METADATA_KEYS`             | constant | The four metadata keys this package owns                                  |
| `UNSCOPED`                           | constant | The scope stamped and filtered on when a store names none, `__unscoped__` |
| `DEFAULT_MEMORY_COLLECTION`          | constant | `memory`                                                                  |
| `DEFAULT_STORAGE_COLLECTION`         | constant | `storage`                                                                 |
| `DEFAULT_EMBEDDING_MODEL`            | constant | `voyage-4-lite`                                                           |
| `DEFAULT_VECTOR_INDEX_NAME`          | constant | `vector_index`                                                            |
| `DEFAULT_TEXT_INDEX_NAME`            | constant | `text_index`                                                              |
| `DEFAULT_STORAGE_VECTOR_INDEX_NAME`  | constant | `storage_vector_index`                                                    |
| `DEFAULT_MAX_SEARCH_RESULTS`         | constant | `10`                                                                      |
| `DEFAULT_OVERSAMPLING_FACTOR`        | constant | `10`                                                                      |
| `VERSION`                            | constant | The installed version                                                     |

## Search: what answers a query

`search()` picks a tier from the query's **shape**, not from what you asked for, and reports which one ran in the
`_search_type` metadata key. Three tiers exist:

<!-- tiers -->

| Tier     | Runs                                           | Needs                                                                                                      |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `hybrid` | one `$rankFusion` over the two pipelines below | MongoDB 8.0 or later, **and** both of the other tiers available                                            |
| `vector` | `$vectorSearch` against `vector_index`         | Atlas, or an Atlas CLI local deployment, plus a registered embedding model on the automated-embedding path |
| `text`   | `$search` against `text_index`                 | Atlas Search, and no embedding model                                                                       |

`searchType` decides which of them `initialize()` prepares. `'auto'` prepares every tier the deployment offers and
prefers the highest one it got; naming one prepares only that one, so a `text` store never builds a vector index it
will never query, and a `vector` store fails rather than quietly answering a query lexically. Naming `hybrid` prepares
both underlying indexes and fails at `initialize()` if the deployment cannot fuse, rather than falling back to half of
what you asked for.

Preparation can come up short without failing. A deployment with no search process at all gets its ordinary indexes
and a warning, and the search call is what throws. A cluster with Atlas Search but no registered embedding model
rejects the `autoEmbed` index at creation, and a store configured for `'auto'` falls back to the text tier and says so
in a warning. Both of those are visible only in your logs, which is worth knowing before you conclude that recall is
bad.

![How searchType auto picks a tier: hybrid if it is ready, then vector, then text, otherwise StorageError](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/search-tiers.png)

### Hybrid scores are on a different scale

<!-- rrf -->

Fused results are **not** similarity scores, and a `minScore` or `maxScore` chosen against the vector tier will not
mean what you meant on this one. `$rankFusion` scores by reciprocal rank fusion:

```
RRFscore(d) = sum over tiers of  weight / (60 + rank of d in that tier)
```

The `60` is MongoDB's rank constant, and this package does not change it. With the two tiers weighted equally, a
document ranked first by both scores about `0.033`; one ranked first by a single tier scores about `0.016`; everything
else is smaller. So a `minScore` of `0.7`, a perfectly ordinary cosine floor, removes every result.

Because that failure is silent (an empty array is also what "no matches" looks like), a store on `'auto'` with either
bound configured stays on the vector tier and logs that it did. Asking for `searchType: 'hybrid'` by name overrides
that: the bound is applied to the fused score, on the scale above, because you asked for this tier specifically.

### Supplying your own vectors

Setting `embeddingDimensions` and `similarity` selects the manual path, where the vector index covers an `embedding`
field on each document instead of asking Atlas to embed `content`.

<!-- manual-vectors -->

The package indexes and queries `embedding` but never fills it on its own. Pass an `embedder` and `add()` and string
`search()` embed for you, so `MemoryManager` works unchanged. Any SDK `Embedder` works, including `BedrockEmbedder`,
and so does any object with an async `embed(text)` method, such as this one for Voyage AI:

<!-- skip: it needs a Voyage AI API key -->

```ts
class VoyageEmbedder {
  constructor(private readonly model = 'voyage-4-lite') {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: [text], model: this.model }),
    })
    const body = (await response.json()) as { data: { embedding: number[] }[] }
    return body.data[0]!.embedding
  }
}

const store = new MongoDBMemoryStore({
  name: 'facts',
  config: { ...connection, embeddingDimensions: 1024, similarity: 'cosine' },
  embedder: new VoyageEmbedder(),
  writable: true,
})
```

Without one, memories get no `embedding` and only a `MongoDBSearchQuery` with a precomputed `vector` can use the vector
tier. Automated embedding needs no `embedder` and rejects one.

### Reserved metadata keys

Every returned entry carries four keys this package owns in its `metadata`, because the SDK's `MemoryEntry` has
nowhere else to put them:

| Key                | Holds                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| `_relevance_score` | The score from whichever tier answered                                                |
| `_id`              | The document id, which is also the `memoryId` that `delete()` takes                   |
| `_search_type`     | `hybrid`, `vector` or `text`, whichever ran                                           |
| `_scope`           | The scope of the store that answered, read from the store and never from the document |

Your own metadata merges underneath these. On a name collision the reserved value wins and the collision is logged, so
a key of yours is never silently dropped without a record.

## Tenancy

Three boundaries are available, and they are not equivalent. The difference that matters is who enforces them:

| Boundary                    | Configure                                               | Enforced by                                              |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Database per tenant         | `database`                                              | MongoDB, if the tenant's user is scoped to that database |
| Collection per tenant       | `collection`                                            | MongoDB, if privileges are per collection                |
| Scope inside one collection | `scope` on memory, `prefix` or `namespace()` on storage | This package                                             |

The third one is the cheapest and the one to understand before choosing it. MongoDB applies no server-side row
filter, so a memory lands in the right scope because `add` put it there, and comes back because `search` asked for
it. The package holds that line in four places: it stamps `scope` itself and a caller cannot set it through `filter`
or `metadata`; an absent scope resolves to a distinct sentinel rather than to no predicate; a caller `filter` composes
as a narrowing conjunction and cannot widen the read; and `delete()` reaches exactly as far as `search()` does. The
tests for these run two stores in one collection and check isolation in both directions.

![What every memory write and read goes through: a write is stamped with scope and store name and deduplicated by content hash; a read passes the filter guard and is limited to the store's scope](https://raw.githubusercontent.com/mongodb/strands-mongodb/main/docs/images/memory-guards.png)

If a tenant boundary is a compliance boundary, use one of the first two rows.

## Where your text goes

<!-- data-flow -->

What leaves the process depends on the embedding path, and on neither of them does this package send text anywhere
except the deployment you connected it to.

- **Automated embedding, the default.** The deployment's search process sends the `content` of every memory, and the
  text of every query that reaches the vector tier (including the vector half of a `hybrid` search), to the embedding
  model named by `embeddingModel`, `voyage-4-lite` unless you set it. That is a call the deployment makes, not this
  package; the package only names the model in the index definition. The `text` tier sends nothing to a model.
- **The manual path.** The deployment sends your text to no model. Your `embedder`, if any, sees each memory and
  string query.

On both paths `content` is stored in the deployment as written, and `MongoDBStorage` payloads are stored the same
way. Processing region, storage location and retention, for the text and for any vectors, are governed by your Atlas
deployment and not by this package, which can neither see nor change them. This package makes no confidentiality or
isolation claim for text sent to the managed embedding model. Text that must not leave your boundary belongs on the
manual path, embedded by a model you choose.

## Erasing memories

`MongoDBMemoryStore` deletes as well as writes, which is what an erasure request against stored facts needs from a
memory backend. The SDK's `MemoryStore` interface has no deletion member, so these are the package's own surface.

| Call                           | Removes                                                  | Returns    |
| ------------------------------ | -------------------------------------------------------- | ---------- |
| `await store.delete(memoryId)` | The one memory with that `_id`, if this store can see it | `1` or `0` |
| `await store.deleteAll()`      | Every memory this store can see                          | The count  |

`memoryId` is the `_id` string a search result carries in its `metadata`, so the id you delete by is the id you were
handed. Anything that is not a 24-character hex ObjectId is rejected before a network call.

Both calls require `writable: true`, and both reach exactly as far as `search()` does: one scope, this store's name,
narrowed by any configured `filter`. A store cannot delete what it cannot read. Two consequences are worth stating
rather than leaving to be discovered:

- **Erasing a scope takes one call per store in it.** `deleteAll()` empties one store's view, not the whole scope,
  because `store_name` is part of the predicate.
- **`0` does not mean "no such memory."** A well-formed id gets `0` whether it names a memory already deleted, one in
  another scope, or one in another store in this scope. Telling those apart would answer whether an id exists
  somewhere the caller cannot read.

<!-- erasure-reach -->

Erasure reaches the live deployment and nothing else. `delete()` and `deleteAll()` remove documents from the
collection, and the search indexes built from them follow; they do not reach backups, snapshots or the oplog, which
keep what they hold for as long as the deployment's own retention says.

## Indexes and privileges

`initialize()` creates what it needs by default, which is convenient in development and often the wrong thing in
production, where index creation is a DBA's call and the application's credential is not supposed to hold
`createIndex`. Set `ensureIndexes: false` and this section is the handoff.

### What gets created

Six indexes across two collections, and a seventh when you give a storage a vector strategy. Names are prefixed
`strands_` where they are ours alone, and they are stable: renaming one would be a breaking change. They are the same
names the Python package uses, so either package finds the other's indexes and creates nothing twice.

<!-- indexes -->

| Collection        | Index                                     | Keys                                                          | Why                                                                                                                    |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `storage`         | `strands_expires_at_ttl`                  | `expires_at`                                                  | Expires `ttlSeconds` documents. `MongoDBStorage` never creates it as a side effect of a write: call `ensureIndexes()`. |
| `memory`          | `strands_scope_store_content_hash_unique` | `scope`, `store_name`, `content_hash`                         | Makes a duplicate `add` a no-op instead of a second copy. Partial, so documents with no hash are unaffected.           |
| `memory`          | `strands_scope_store_created_at`          | `scope`, `store_name`, `created_at` desc                      | Every non-search read is scope plus store plus recency.                                                                |
| `memory`          | `strands_expires_at_ttl`                  | `expires_at`                                                  | Expires memories whose store sets `ttlSeconds`. `initialize()` creates it whether or not any store sets a TTL.         |
| `memory`          | `vector_index`                            | `content` as `autoEmbed`, `scope` and `store_name` as filters | The vector tier. Atlas only. Name from `vectorIndexName`.                                                              |
| `memory`          | `text_index`                              | `content` as a string field                                   | The text tier. Atlas Search only. Name from `textIndexName`.                                                           |
| the storage's own | `storage_vector_index`                    | `embedding` as a vector, `prefixes` as a filter               | `MongoDBVectorSearchStrategy`. Created by `ensureIndexes()`. Name from `indexName`.                                    |

The two memory search indexes shown are the zero-configuration shape, where Atlas embeds your text. Setting
`embeddingDimensions` and `similarity` instead swaps the `autoEmbed` field for a `vector` field of that width, and
adding `filterFields` appends one filter entry per path.

### Creating them by hand

Paste into `mongosh`, connected to the database in your `MongoDBConfig`. This block is generated from the same code
that runs at `initialize()` and a test asserts they are identical line for line, so it is worth pasting rather than
retyping:

<!-- prettier-ignore-start -->
<!-- run: mongosh -->
```javascript
db.runCommand({"createIndexes": "storage", "indexes": [{"key": {"expires_at": 1}, "name": "strands_expires_at_ttl", "expireAfterSeconds": 0}]})
db.runCommand({"createIndexes": "memory", "indexes": [{"key": {"scope": 1, "store_name": 1, "content_hash": 1}, "name": "strands_scope_store_content_hash_unique", "unique": true, "partialFilterExpression": {"content_hash": {"$exists": true}}}]})
db.runCommand({"createIndexes": "memory", "indexes": [{"key": {"scope": 1, "store_name": 1, "created_at": -1}, "name": "strands_scope_store_created_at"}]})
db.runCommand({"createIndexes": "memory", "indexes": [{"key": {"expires_at": 1}, "name": "strands_expires_at_ttl", "expireAfterSeconds": 0}]})
db.runCommand({"createSearchIndexes": "memory", "indexes": [{"name": "vector_index", "type": "vectorSearch", "definition": {"fields": [{"type": "autoEmbed", "path": "content", "model": "voyage-4-lite", "modality": "text"}, {"type": "filter", "path": "scope"}, {"type": "filter", "path": "store_name"}]}}]})
db.runCommand({"createSearchIndexes": "memory", "indexes": [{"name": "text_index", "type": "search", "definition": {"mappings": {"dynamic": false, "fields": {"content": [{"type": "string"}]}}}}]})
```
<!-- prettier-ignore-end -->

Substitute your collection names if you set `collection`. The first four are ordinary indexes and any MongoDB accepts
them; the last two need Atlas Search, and the vector one additionally needs an embedding model registered on the
cluster.

### Ensure versus verify

`ensureIndexes: false` is verify-only rather than skip. A credential with no DDL rights still needs to know whether the
indexes are there, and what happens when one is absent depends on which index it is:

<!-- verify -->

| Index kind                                                             | `true` (default) does                                            | `false`, and it is missing                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary and TTL                                                       | Creates what is missing, one `createIndexes` call per collection | Throws. The message is the list of `createIndexes` commands that fix it, one line each                                                                                             |
| Search, under `searchType: 'auto'`                                     | Creates it, then polls until it is queryable                     | A warning naming the index, and that tier is skipped. The store starts and answers from the tier that is left, and tries the skipped one again later; if neither is left it throws |
| Search, under a named `searchType`: `'vector'`, `'text'` or `'hybrid'` | Creates it, then polls until it is queryable                     | Throws. There is no second tier to fall back to, and answering from one you did not ask for changes what matches                                                                   |

So verify mode is not a quiet mode. A missing ordinary index stops startup with a work order, because the alternative
is worse than a late start: the uniqueness index behind `add`'s deduplication is one of them, and an application that
runs without it writes duplicates silently and surfaces the problem in the data weeks later.

`MongoDBStorage` follows the same rule through `ensureIndexes()`, which is explicit rather than part of any operation:
its collection has one ordinary index, and a search index only with a vector strategy, so `ensureIndexes: false` there
throws with the command for what is missing and creates nothing.

Waiting is bounded. Under a named `searchType`, `initialize()` waits up to 300000 ms (300 s) per index, then throws
`StorageError`. Under `'auto'` it doesn't wait: building tiers are skipped, and the first `search` waits up to the same
bound for the first of them to be ready. Later searches don't wait, and throw `StorageError` until a tier is ready.
Skipped tiers are retried with backoff from 60 s up to 3600 s.

### Privileges

The two packages send the same commands, so they need the same privileges. The [Python package's
table](https://github.com/mongodb/strands-mongodb/blob/main/python/README.md#privileges) is the reference, and its
contract tier rechecks it against a live deployment's `rolesInfo`. In short:

<!-- privileges -->

| Action                | This package needs it for                                   | `read` | `readWrite` |
| --------------------- | ----------------------------------------------------------- | ------ | ----------- |
| `find`                | Every read, on both surfaces                                | yes    | yes         |
| `insert`              | `write`, `add`                                              | no     | yes         |
| `update`              | `write` overwriting an existing key, and storing a vector   | no     | yes         |
| `remove`              | `delete`, `deletePrefix`, `deleteAll`                       | no     | yes         |
| `listCollections`     | The collation preflight, before any index, on both surfaces | yes    | yes         |
| `listIndexes`         | Verify mode, ordinary indexes                               | yes    | yes         |
| `listSearchIndexes`   | Verify mode, search indexes                                 | yes    | yes         |
| `createIndex`         | Ensure mode, ordinary indexes                               | no     | yes         |
| `createCollection`    | Ensure mode, the namespace a search index needs             | no     | yes         |
| `createSearchIndexes` | Ensure mode, search indexes                                 | no     | yes         |

An application that writes memories but must not create indexes needs a custom role granting the four data actions and
the three metadata reads, and `ensureIndexes: false`. Keep `insert` in that role even though this package never sends
an `insert` command: every write it makes is an upsert, and a role holding `update` without `insert` is refused one.

## Limits

Everything a caller runs into that this package does not remove. Each row says what you can do about it, and the last
column names the method, type or constant it concerns. A constant named there may be internal to the package: it is
named so the value can be traced, not so it can be imported.

<!-- limits -->

| Limit                                                                       | Where it bites, and what you can do                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Source                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| One pool per connection identity                                            | Configs share a client when they inject the same `client`, or give the same connection string and equal `clientOptions`. Plain option values compare by value, but an object such as a TLS secure context compares by identity, so building one per request builds a pool per request. Build the config once and reuse it.                                                                                                                                                                           | `MongoDBConfig`                  |
| The connection resolves per operation                                       | An operation after `close()` opens a fresh pool rather than throwing, so a mistaken `close()` costs a connection instead of an error. Call `close()` once, at process shutdown.                                                                                                                                                                                                                                                                                                                      | `MongoDBStorage.close()`         |
| `close()` is scoped to the connection                                       | Closing one store's connection closes the pool that every store with the same connection identity is sharing. Siblings with an operation in flight are the ones that notice.                                                                                                                                                                                                                                                                                                                         | `MongoDBMemoryStore.close()`     |
| A memory is not searchable when `add()` returns                             | Atlas embeds and indexes asynchronously, after the write is acknowledged. Poll for the memory rather than reading straight back.                                                                                                                                                                                                                                                                                                                                                                     | `MongoDBMemoryStore.add()`       |
| An empty search result is ambiguous                                         | `MemoryManager` turns a failed store into a warning and returns what survived, so zero hits can mean zero matches or a search that failed. Watch for `store search failed` in the SDK's logs.                                                                                                                                                                                                                                                                                                        | `MongoDBMemoryStore.search()`    |
| Embedding throughput on the default path                                    | On the automated-embedding path the deployment embeds every query that reaches the vector tier, the vector half of a `hybrid` search included, and Atlas limits how fast it will: about 2,000 embedding requests a minute on an M30 in load testing of the Python package, which sends the same queries. Above that, searches fail with "Embedding provider rate limit exceeded". `searchType: 'text'` embeds nothing and is not affected, and the manual-vector path embeds in your own `embedder`. | `MongoDBMemoryStore.search()`    |
| Default storage search examines every key                                   | `search()` with no `searchStrategy` scores each key under the instance's prefix, in one server-side query that reads no values. Cost grows with the number of keys examined: about 30 ms at 1,000 keys and 1.5 s at 100,000 on an M30, measured with the Python package, which sends the same query. Search a narrower key space with `namespace()` or a `prefix`, or give ephemeral keys their own instance with `ttlSeconds`.                                                                      | `MongoDBStorage.search()`        |
| Document size                                                               | 16 MB, the server's BSON ceiling. Checked before the write, so you get the SDK's `StorageError` naming the size instead of a driver error. Chunk, or store a pointer.                                                                                                                                                                                                                                                                                                                                | `MAX_DOCUMENT_BYTES`             |
| Storage key length                                                          | 1024 bytes, which keeps a key inside an index entry. Same early `StorageError`.                                                                                                                                                                                                                                                                                                                                                                                                                      | `MAX_KEY_BYTES`                  |
| `list()` is unpaginated                                                     | The SDK's interface takes a prefix and no cursor, so a prefix matching a million keys returns a million keys. Use narrower prefixes, or `namespace()`.                                                                                                                                                                                                                                                                                                                                               | `Storage.list()`                 |
| On `MongoDBStorage`, `ttlSeconds` needs an index nothing creates implicitly | `write` stamps `expires_at`, and the documents stay until the storage collection has its TTL index. Call `await storage.ensureIndexes()` once at startup, or run the command above. The memory store's `initialize()` creates its TTL index unconditionally.                                                                                                                                                                                                                                         | `MongoDBStorage.ensureIndexes()` |
| Vector dimensions                                                           | 8192 on the manual vector path, rejected at configuration time rather than by the server.                                                                                                                                                                                                                                                                                                                                                                                                            | `MAX_DIMENSIONS`                 |
| Results per search                                                          | 10 by default. Raise `maxSearchResults` on the store, or `limit` on a single query.                                                                                                                                                                                                                                                                                                                                                                                                                  | `DEFAULT_MAX_SEARCH_RESULTS`     |
| Vector candidates considered                                                | 10 per result requested. Raise `oversamplingFactor` for recall, lower it for latency.                                                                                                                                                                                                                                                                                                                                                                                                                | `DEFAULT_OVERSAMPLING_FACTOR`    |
| Vector candidates per query                                                 | 10000, the server's `numCandidates` ceiling. A `limit` times `oversamplingFactor` above it throws `RangeError` before the query is sent.                                                                                                                                                                                                                                                                                                                                                             | `MAX_NUM_CANDIDATES`             |
| Waiting for a search index                                                  | 300000 ms per index. Set `indexReadyTimeoutMs` to change it.                                                                                                                                                                                                                                                                                                                                                                                                                                         | `READY_TIMEOUT_MS`               |

## Observability

<!-- observability -->

Both stores record an OpenTelemetry span for every public operation, on the tracer provider your application already
has. The package configures nothing: no provider, no processor, no exporter, no sampling. With no provider installed,
OpenTelemetry's no-op tracer answers. Spans join whatever trace is current, so in an agent traced by Strands each
memory search shows up inside the model turn or tool call that made it. In Node that needs a context manager, which a
provider set up through the OpenTelemetry Node SDK registers for you; set up by hand, it looks like this:

<!-- run: unit -->

```ts
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new BatchSpanProcessor(new ConsoleSpanExporter())] }),
)
```

The tracer is looked up on every call, so it does not matter whether that happens before or after this package is
imported.

<!-- spans -->

| Span                                     | Recorded by                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strands_mongodb.storage.write`          | `MongoDBStorage.write()`                                                                                                                                                    |
| `strands_mongodb.storage.read`           | `MongoDBStorage.read()`                                                                                                                                                     |
| `strands_mongodb.storage.delete`         | `MongoDBStorage.delete()`                                                                                                                                                   |
| `strands_mongodb.storage.list`           | `MongoDBStorage.list()`                                                                                                                                                     |
| `strands_mongodb.storage.search`         | `MongoDBStorage.search()`                                                                                                                                                   |
| `strands_mongodb.storage.delete_prefix`  | `MongoDBStorage.deletePrefix()`                                                                                                                                             |
| `strands_mongodb.storage.ensure_indexes` | `MongoDBStorage.ensureIndexes()`                                                                                                                                            |
| `strands_mongodb.memory.initialize`      | `MongoDBMemoryStore.initialize()`, only on the call that does the setup and any that wait on it. Every operation calls it, and once setup is done the calls record nothing. |
| `strands_mongodb.memory.add`             | `MongoDBMemoryStore.add()`                                                                                                                                                  |
| `strands_mongodb.memory.search`          | `MongoDBMemoryStore.search()`                                                                                                                                               |
| `strands_mongodb.memory.delete`          | `MongoDBMemoryStore.delete()`                                                                                                                                               |
| `strands_mongodb.memory.delete_all`      | `MongoDBMemoryStore.deleteAll()`                                                                                                                                            |
| `strands_mongodb.indexes.ensure`         | Creating or checking indexes, inside `memory.initialize` or `storage.ensure_indexes`                                                                                        |
| `strands_mongodb.indexes.probe`          | Asking the deployment what it supports: Atlas Search, `$rankFusion`, or the collection's collation                                                                          |
| `strands_mongodb.indexes.wait`           | Waiting for a search index to finish building. One span per index waited on, not one per poll.                                                                              |

Span names keep Python's spelling, `delete_prefix` rather than `deletePrefix`, so one backend groups both packages'
spans together. The three `indexes.*` spans are children of the operation that needed them, so a slow first `search()`
shows where its time went.

Every span is `INTERNAL`. It carries the attributes below that apply to it, and none of OpenTelemetry's `db.*`
attributes: those describe one database command, and an operation here can be several. For a span per command, use
the driver's command monitoring or an OpenTelemetry instrumentation for `mongodb`.

<!-- attributes -->

| Attribute                          | On                                                                              | Value                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `strands_mongodb.database`         | every span                                                                      | The database name                                                                                         |
| `strands_mongodb.collection`       | every span                                                                      | The collection name                                                                                       |
| `strands_mongodb.store_name`       | every `memory.*` span                                                           | The store's configured `name`                                                                             |
| `strands_mongodb.search.requested` | `memory.search`, `memory.initialize`                                            | The configured `searchType`: `auto`, `vector`, `text` or `hybrid`                                         |
| `strands_mongodb.search.tier`      | `memory.search`                                                                 | The tier that answered. Alert on it differing from `search.requested` to catch a store that has degraded. |
| `strands_mongodb.search.tiers`     | `memory.initialize`                                                             | The tiers that came up, comma-separated                                                                   |
| `strands_mongodb.result_count`     | `memory.search`, `storage.search`, `storage.list`                               | Entries or keys returned                                                                                  |
| `strands_mongodb.deleted_count`    | `memory.delete`, `memory.delete_all`, `storage.delete`, `storage.delete_prefix` | Documents removed, as the server reported them                                                            |
| `strands_mongodb.found`            | `storage.read`                                                                  | Whether the key existed                                                                                   |
| `strands_mongodb.duplicate`        | `memory.add`                                                                    | Whether the fact was already stored, so nothing was written                                               |
| `strands_mongodb.indexes.mode`     | `indexes.ensure`                                                                | `ensure`, or `verify` when `ensureIndexes` is `false`                                                     |
| `strands_mongodb.indexes.created`  | `indexes.ensure`                                                                | Indexes this call created, `0` when they were all there                                                   |
| `strands_mongodb.indexes.outcome`  | `indexes.wait`                                                                  | `ready`, or `timed_out` when `indexReadyTimeoutMs` ran out                                                |
| `strands_mongodb.indexes.probe`    | `indexes.probe`                                                                 | `search`, `rank_fusion` or `collation`                                                                    |
| `strands_mongodb.client.injected`  | the `client.acquired` event                                                     | Whether you supplied the `client`                                                                         |
| `error.type`                       | a failed span                                                                   | The error's class name                                                                                    |

A span whose operation threw has status `ERROR`, with the error's class name as the description and `error.type` set.
The error's message is never recorded, and neither is its stack: this package's messages name the key or namespace on
purpose, so you can act on them, and a span is exported to a third party where a thrown error is not.

Never recorded, on any span or in any log record: a storage key or prefix, stored content or payload, metadata you
supplied, query text, filter values, a scope, a memory id, a connection string, a username or a password. A scope is
usually a tenant or user id, which is why it is on that list. The store name is configuration you chose, so it is
recorded.

`strands_mongodb.client.acquired` is a span event, recorded once for each client this package creates or registers,
on the span that is current at that moment.

### Logging

**The SDK's `configureLogging` alone does not show this package's records.** It sets the SDK's own logger, which the
SDK does not export, so a library cannot write through it. This package has a `configureLogging` of its own with the
same contract: any object with `debug`, `info`, `warn` and `error`. Until you call it, `warn` and `error` reach the
console and `debug` and `info` are dropped, as the SDK's default does. To see both packages' records, call both with
one logger. With [Pino](https://getpino.io):

<!-- skip: it needs pino, which this package neither depends on nor installs for its tests -->

```ts
import { configureLogging as configureSdkLogging } from '@strands-agents/sdk'
import pino from 'pino'
import { configureLogging } from 'strands-mongodb'

const log = pino({ level: 'debug' })
configureSdkLogging(log)
configureLogging(log)
```

Each call passes a fields object first and the message second, which is Pino's order, so Pino indexes the fields with
no adapter. A logger that takes the message first, such as [Winston](https://github.com/winstonjs/winston), needs one
line:

<!-- skip: it needs winston, which this package neither depends on nor installs for its tests -->

```ts
const adapt = (level: string) => (fields: unknown, message: unknown) => winston.log(level, String(message), fields)
configureLogging({ debug: adapt('debug'), info: adapt('info'), warn: adapt('warn'), error: adapt('error') })
```

Every record's fields carry `strands_mongodb_event`, always, and `strands_mongodb_namespace`
(`<database>.<collection>`) and `strands_mongodb_tier` where the record is about one: the same field names the Python
package puts on its records, so one log pipeline reads both. Every message starts `strands_mongodb: `. The event names
are stable:

<!-- log-events -->

| Event                    | Level   | Logged when                                                                                      |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `retry_writes_disabled`  | `warn`  | The client has retryable writes turned off                                                       |
| `reserved_key_collision` | `warn`  | A stored document's metadata uses a key the store sets on every result                           |
| `no_search_setup`        | `warn`  | The deployment has no Atlas Search, so no search index is set up                                 |
| `tier_unavailable`       | `warn`  | Under `auto`, a search tier could not be prepared and was skipped                                |
| `tier_building`          | `info`  | Under `auto`, a search index was still building, so its tier was skipped until a search needs it |
| `below_vector`           | `warn`  | Under `auto`, vector search is unavailable and queries use the text tier                         |
| `bound_declined_fusion`  | `warn`  | A score bound kept `auto` off the hybrid tier                                                    |
| `score_bound_applied`    | `debug` | `minScore` or `maxScore` dropped results                                                         |
| `creating_indexes`       | `info`  | Ordinary indexes are being created                                                               |
| `creating_search_index`  | `info`  | A search index is being created                                                                  |
| `search_index_status`    | `info`  | A search index changed status while being waited for                                             |
| `attribute_dropped`      | `debug` | A span attribute was not on the allow-list and was dropped                                       |

Two of the Python package's events never occur here, because both are about a client bound to an event loop and a
Node process has one: `attribution_not_visible` and `closed_loop_client_dropped`.

## Sharing a collection with Python

A TypeScript store and a Python store pointed at the same collection read each other's documents. Keys, document ids,
content hashes, index names and query pipelines are the same in both, and a test holds this package to values computed
by the Python one, so a memory added from one language is found, deduplicated and deleted by the other.

The difference you can see is in numbers. JavaScript has one number type, and the driver stores a `number` that
happens to be an integer as a BSON `Int32`, where Python stores a `float` as a double whatever its value. So metadata
`{ rating: 4 }` written from TypeScript reads back in Python as the `int` `4`, not the `float` `4.0`, and a query on
`$type: 'double'` misses it. Equality is unaffected: MongoDB compares numbers by value across types, so a filter on
`rating: 4` matches either. Vectors are unaffected too, because this package writes every component as a double.

When the type matters to a reader in the other language, wrap the value in the driver's `Double`:

<!-- run: unit -->

```ts
import { Double } from 'mongodb'

const metadata = { rating: new Double(4) } // a double in BSON, so Python reads 4.0
console.assert(metadata.rating.valueOf() === 4)
```

## Examples

Two runnable scripts in [`examples/`](https://github.com/mongodb/strands-mongodb/blob/main/typescript/examples/), each
split into two commands you run as two processes, so the only thing crossing between them is MongoDB. They import the
package by its published name, so build it first:

<!-- skip: the examples are run by their own tests, which supply the second command and the backend -->

```bash
npm run build
node examples/memory-recall.ts write     # then: recall
node examples/unified-storage.ts run     # then: resume
```

`memory-recall.ts` stores a fact in one process and recalls it in the next from a query that shares no word with it,
over server-side embeddings. `unified-storage.ts` has three SDK subsystems writing to one collection under three key
prefixes, then restores the session in a fresh process.

`MONGODB_URI` is the only variable either one needs, and `--dry-run` prints what a step would do without connecting to
anything. They are TypeScript run directly by Node, which strips the types: Node 22.18 or later does that with no flag.

## Requirements

|                       |                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js               | >= 22                                                                                                                                                                                                                                                                                                        |
| `@strands-agents/sdk` | ^1.24.0                                                                                                                                                                                                                                                                                                      |
| `mongodb`             | ^7.8.0, the driver both stores run on                                                                                                                                                                                                                                                                        |
| `@opentelemetry/api`  | ^1.9.0. The API only: this package installs no SDK, provider or exporter                                                                                                                                                                                                                                     |
| MongoDB               | Any deployment serves storage. The text tier needs Atlas Search; the vector tier needs Atlas or an Atlas CLI local deployment. The default embedding path also needs an embedding model registered on the deployment. An Atlas CLI local deployment has none, so use the manual path or the text tier there. |

## Development

Every command runs from `typescript/`.

<!-- skip: running this would install into the checkout the test suite is running from -->

```bash
npm ci

npm test -- --project unit   # unit tier, no MongoDB needed
npm run lint
npm run typecheck
npm run check                # format check, lint, typecheck, unit
npm run cov                  # release gate: 90% aggregate, 70% per file
```

The test suite is tiered by what infrastructure it needs. A tier whose variable is unset or empty is skipped with a
title naming the variable, never silently passed:

| Tier          | Backend                                           | Gate                                               |
| ------------- | ------------------------------------------------- | -------------------------------------------------- |
| `unit`        | None                                              | Always runs                                        |
| `contract`    | Any real MongoDB                                  | `MONGODB_URI`                                      |
| `integration` | Atlas or Atlas CLI local, with `mongot`           | `MONGODB_ATLAS_URI`                                |
| `autoembed`   | A cluster with a registered Atlas embedding model | `MONGODB_AUTOEMBED_URI`                            |
| `build`       | Network, to pack and install the tarball          | `STRANDS_MONGODB_BUILD_TIER`                       |
| `example`     | The backend of the example it runs                | That backend's variable                            |
| `gate`        | None                                              | Always runs, last, over every other tier's results |

Those variables are also read from a `.env` file in `typescript/`, which is `.gitignore`d. A value already set in the
environment is never replaced, so opting out of a configured backend means setting its variable to empty, not unsetting
it:

<!-- skip: each line is a whole test run, and one of them is the run reading this line -->

```bash
MONGODB_URI=mongodb://localhost:27017 npm test
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= npm test
```

Each test writes to a database named `strands_mongodb_test_<random>` and drops it at the end, so pointing
`MONGODB_URI` at a deployment you care about keeps the tests out of its existing databases, but is still not
recommended.

### Continuous integration

`.github/workflows/ci-typescript.yml` runs on every pull request that touches `typescript/`, or one of the files
outside it the suite reads, and on demand. No job holds a secret: the deployments are service containers. Each job
installs npm 11.21.3 before `npm ci`, because older npm 11 releases leave out Vitest's native binding on a clean
install and the suite cannot start. Use that version or newer locally too.

<!-- ci-jobs -->

| Job                            | Runs                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Lint`                         | `npm run format:check`, `npm run lint`, `npm run typecheck`, on Node 22                                                                                                                                                                                      |
| `Test - Node <version>`        | `npm test` on Node 22 and 24, with no deployment: the unit and gate tiers, and the examples' refusal and dry-run checks                                                                                                                                      |
| `Contract tier (<deployment>)` | The `contract` and `example` tiers against a `mongo:8` service container and against a `mongodb/mongodb-atlas-local:8` one that carries a search process. The second leg also runs `integration`, then both check that the tiers left the working tree clean |
| `Coverage floors`              | `npm run cov` with `STRANDS_MONGODB_BUILD_TIER=1`: 90% aggregate and 70% per file, and the build tier's pack, install and import                                                                                                                             |

The `autoembed` tier is not run by this workflow, because it needs a real Atlas cluster and a credential to create
one. Run it locally with `MONGODB_AUTOEMBED_URI` set.

## License

Apache-2.0. See [LICENSE](https://github.com/mongodb/strands-mongodb/blob/main/typescript/LICENSE).
