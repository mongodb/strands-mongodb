# TypeScript parity: design

NODE-7997. Status: **approved**, 2026-11-10. Nothing is implemented yet.

**If you are implementing this, read §12 first.** It holds the ground rules, the build order, the map from each
TS file to the Python source it ports, and the traps that already caught one session out. There is no separate
implementation plan: this document is the plan.

## 1. Verdict

**Parity is achievable.** Every Python surface has a TypeScript home, or a stated reason why it doesn't need one. The Strands TS SDK exposes the
same three extension points the Python package plugs into: `Storage`, `SearchStrategy` and `MemoryStore`.
The Node driver can do everything the package asks of pymongo. What does not carry over is a handful of
Python-specific shapes, which are listed under §4 with what replaces each.

Evidence, all read from installed packages rather than from documentation:

| Read | Version | Where |
|---|---|---|
| `@strands-agents/sdk` | 1.24.0 (latest on npm today) | `dist/src/storage`, `dist/src/memory`, `dist/src/session`, `dist/src/vended-memory-stores`, `dist/src/logging`, `package.json` |
| `mongodb` (Node driver) | 7.8.0 | `mongodb.d.ts`, `package.json` |
| `strands-agents` (Python SDK, for comparison) | 1.64.0 | `strands/storage`, `strands/memory` |
| `strands-mongodb` (this repository) | `main` at `0de7b9f` | `python/src/strands_mongodb`, `python/README.md`, `python/tests` |

## 2. Scope

In: a `typescript/` tree that publishes `strands-mongodb` to npm, `.github/workflows/ci-typescript.yml` for
pull-request gates, a per-language section in `AGENTS.md`, and edits to `README.md` and `CONTRIBUTING.md`
only where something would otherwise be false.

Out:
- Anything under `python/`.
- `.github/workflows/release-python.yml`.
- The TypeScript release pipeline: signing, SBOM, Papertrail and npm publish are a follow-on ticket.
- `.github/dependabot.yml`. `python/tests/test_ci.py::test_nothing_proposes_a_new_dependency_floor` holds that raising a floor is a support-window decision, and an npm entry would propose exactly that.

Both surfaces, storage and memory, ship in one plan, as agreed.

## 3. What the TS SDK offers

| Concept | TypeScript (`@strands-agents/sdk` 1.24.0) | Python (`strands-agents` 1.64.0) |
|---|---|---|
| Storage contract | `interface Storage<ListQuery = string, SearchQuery = string>`. Requires `write(key, Uint8Array)`, `read(key) → Uint8Array \| null`, `delete(key)` and `list(query) → string[]` (sorted). Optional `namespace?(prefix)` and `search?(query) → StorageSearchResult[]` | The same four methods on `bytes`, with `namespace` and `search` optional |
| Search result | `{ key, score, data?: Uint8Array }` | `StorageSearchResult` with the same fields |
| Pluggable search | `SearchStrategy<S, Q>` with `index?(storage, key, data)` and `search(storage, query)`. `S3VectorSearchStrategy` adds `remove(storage, key)`, which `S3Storage.delete` calls | `SearchStrategy` with `index` and `search` |
| Embedder | `abstract class Embedder { embed(text): Promise<number[]> }`, from `./storage` | A protocol with async `embed` |
| Key helpers | `normalizeKey`, `normalizePrefix`, `namespace` and `resolveNamespace` in `storage/storage.js`. **Not exported** from any public subpath. The `NAMESPACED` marker is `Symbol.for('strands.storage.namespaced')`, so it is reachable through the global symbol registry. `resolveNamespace` returns a marked storage as-is, and otherwise calls its `namespace()` | `_normalize_key`, `_normalize_prefix` and `_NAMESPACED`. Private, and imported anyway by this package's `storage.py` |
| Keyword tokenizer | `tokenize`, `STOP_WORDS` in `storage/search/keyword`. **Not re-exported** from `./storage/search` | `tokenize`, documented as compatible with the TS tokenizer |
| Memory store | `interface MemoryStore extends MemoryStoreConfig` with `writable`, `search(query, options?)`, and optional `add?`, `addMessages?`, `initialize?` and `getTools?` | The same as a protocol |
| Memory entry | `{ content, storeName?, metadata?: Record<string, JSONValue> }` | `MemoryEntry` |
| Extraction routing | `resolveExtractionConfig`: a store that implements `addMessages` gets raw messages and must extract itself. A store with only `add` gets model-extracted facts | The same rule |
| Sessions | `SessionManager({ storage })` over any `Storage`, with a snapshot adapter | `SnapshotSessionManager` |
| Agent wiring | `new Agent({ storage })` auto-namespaces each subsystem | The same |
| Errors | `StorageError extends Error` (message, `ErrorOptions` with `cause`), exported. SDK stores also throw plain `Error` for configuration mistakes, prefixed with the class name | `StorageError`. `ValueError` for caller mistakes |
| Logging | A global `Logger` (`debug`, `info`, `warn`, `error` taking `...args: unknown[]`), replaced through `configureLogging()`. The `logger` instance itself is **not exported** | stdlib `logging` |
| Telemetry | `@opentelemetry/api ^1.9.0`, a **required** peer of the SDK | `opentelemetry-api` |
| Module format | ESM only (`"type": "module"`), `engines.node >= 22.0.0` | n/a |

The model to copy is the SDK's own vended stores. Their shapes:
- `S3Storage(bucket, config?: { prefix?, region?, s3Client?, searchStrategy? })`.
- `BedrockKnowledgeBaseStore(options)`. Its options extend `MemoryStoreConfig` with `config`, `scope?`, `filter?`, `minScore?` and `maxScore?`. Its `add` returns `{ documentId }`, and it rejects `maxSearchResults < 1` in its constructor.

Both are camelCase throughout and take one options object.

The Node driver (`mongodb` 7.8.0) supports everything the package needs:
- `$vectorSearch` and `$search` through `aggregate`.
- `createSearchIndexes` and `listSearchIndexes`.
- Partial and TTL indexes.
- `driverInfo` as a `MongoClientOption`, and `client.appendMetadata(driverInfo)` for a client it did not build.
- `Binary` for the payload.

Its `engines.node` is `>= 20.19.0`, below the SDK's floor, so the SDK sets the Node floor.

## 4. Surface map

"Faithful" means the TS form carries the same behaviour and the same contract-checklist items. "Changed" means the behaviour holds but its shape is the TypeScript one. "Dropped" means the Python surface exists to solve a problem Node does not have.

| Python | TypeScript | Verdict and reason |
|---|---|---|
| `MongoDBStorage(config, /, *, collection, prefix, ttl_seconds, search_strategy)` | `new MongoDBStorage(config, { collection?, prefix?, ttlSeconds?, searchStrategy? })` | Faithful. Same split as `S3Storage(bucket, config?)`: the connection first, the per-instance options second |
| `write`, `read`, `delete`, `list`, `search`, `namespace` | Same names, on `Uint8Array`. `namespace()` returns a full `MongoDBStorage` marked with `Symbol.for('strands.storage.namespaced')`, as Python's sets `_NAMESPACED` | Faithful |
| `delete_prefix(prefix) → int` | `deletePrefix(prefix): Promise<number>` | Faithful. Not in the TS `Storage` interface either |
| `prefix` (read-only property) | `readonly prefix: string` | Faithful |
| `ensure_indexes()` | `ensureIndexes(): Promise<void>` | Faithful |
| `close()` | `close(): Promise<void>` plus `[Symbol.asyncDispose]` | Changed. `await using storage = new MongoDBStorage(...)` is how TypeScript 5.2+ spells a scoped resource. Same semantics: idempotent, and it never closes an injected client |
| `MongoDBMemoryStore(MongoDBMemoryStoreConfig)` | `new MongoDBMemoryStore({ name, config, collection?, scope?, filter?, minScore?, maxScore?, ttlSeconds?, embedder?, writable?, maxSearchResults?, description?, extraction? })` | Faithful. One options object, exactly as `BedrockKnowledgeBaseStore` takes it |
| `initialize`, `add`, `search`, `delete`, `delete_all`, `get_tools`, `close` | `initialize`, `add`, `search`, `delete`, `deleteAll`, `getTools`, `close` plus `[Symbol.asyncDispose]` | Faithful, camelCased |
| `search(query: str \| MongoDBSearchQuery, options)` | `search(query: string \| MongoDBSearchQuery, options?)` | Faithful. A wider parameter type still satisfies `MemoryStore.search(query: string)` |
| `add_messages`, deliberately absent | Deliberately absent | Faithful, for the same reason. The TS SDK would hand a store that has `addMessages` the raw messages and skip model extraction (`resolve-extraction-config.js`). Python needs a `cast` to express the absence and TypeScript does not, because the member is optional in the interface |
| `MongoDBAddResult` dataclass `(ids, inserted, duplicates)` | `interface MongoDBAddResult { ids: string[]; inserted: number; duplicates: number }` | Changed. A plain object, which is what `BedrockKnowledgeBaseAddResult` is |
| `MongoDBVectorSearchStrategy(*, embedder, dimensions, similarity, index_name, max_results, oversampling_factor)` | `new MongoDBVectorSearchStrategy({ embedder, dimensions, similarity, indexName?, maxResults?, oversamplingFactor? })` | Faithful, plus `remove(storage, key)`. `remove` is a no-op because the vector lives on the stored document and `delete` takes it with it. It exists so code written against `S3VectorSearchStrategy` finds the method it expects |
| `TextEmbedder` protocol | The SDK's `Embedder` type, accepted structurally (`{ embed(text): Promise<number[]> }`) | Changed. The SDK names the contract, so reuse that name rather than minting a second one. Any SDK embedder plugs in |
| `MongoDBConfig` TypedDict, snake_case | `interface MongoDBConfig`, camelCase. See §5.3 | Changed |
| `MongoDBSearchQuery` `(text, vector, filter, limit, oversampling_factor)` | `interface MongoDBSearchQuery { text?, vector?, filter?, limit?, oversamplingFactor? }` | Faithful |
| `SearchType`, `VectorSimilarity`, `ResolvedSearchType` | String-literal union types with the same values: `'auto' \| 'vector' \| 'text' \| 'hybrid'`, and `'cosine' \| 'dotProduct' \| 'euclidean'` | Faithful |
| `RESERVED_METADATA_KEYS`, `DEFAULT_*`, `UNSCOPED` | Exported `const`s with the same values | Faithful |
| `[storage]` and `[memory]` extras, `_extras.missing_extra` | One package, no extras | Dropped. See §5.1 |
| `_client.py`: one registry keyed by connection identity **and by event loop**, with adoption and reaping | One registry keyed by connection identity only | Changed. See §5.2 |
| `pymongo-search-utils` pipeline builders | Built in `src/pipeline.ts` | Changed. There is no npm equivalent. The stages are a few dozen lines, and the index-command comparison test (§6) pins their output |
| `SnapshotSessionManager` in examples | `SessionManager({ storage })` | Changed. That is the TS SDK's name for the same thing |
| `ValueError` | `TypeError`, `RangeError` or `Error`. See §5.4 | Changed |
| stdlib logger `strands_mongodb`, with `extra=` fields | The package's own `Logger`, and a fields object passed first. See §5.5 | Changed |

## 5. Where the two SDKs differ, and the choice made

### 5.1 One package, no extras

The extras exist so that `strands-mongodb[storage]` never installs `pymongo-search-utils`. Node has no such
package, so the two surfaces need the same three peers and an extra would split nothing. **Choice:** one
package with one entry point (§7).

### 5.2 The client registry loses its event-loop dimension

An `AsyncMongoClient` binds to the event loop it was first used on, which is why the Python registry is keyed by loop. It
also adopts a loop-less client and reaps the clients of closed loops. Node has one event loop per isolate, and a
`MongoClient` is not bound to it.

**Choice:** keep the part that is about the user and drop the part that is about asyncio. What stays:
- Configs with the same identity share one `MongoClient`. Identity is the sha256 of the connection string and the serialised client options, or the injected client object itself.
- `close()` on any store closes that shared client.
- An injected client is never closed.
- Driver attribution is `driverInfo: { name: 'Strands-MongoDB', version }` on a client the package builds, and `appendMetadata` on an injected one. These are checklist items 26 and 27.

Concurrent first use still has to make exactly one client and one index set (item 22), and in Node the race is
between promises rather than threads. The registry stores the pending promise, not the resolved client, so two
callers that start together await the same one.

### 5.3 Config keys are camelCase; document fields stay snake_case

The TS SDK and the Node driver are camelCase everywhere. A TypeScript user writing `connection_string` would read as a port,
so config keys follow the language. The bytes written to MongoDB follow the Python package exactly, because
the user has asked for a TS store and a Python store to be able to share a collection (§6).

| Python key | TS key | Note |
|---|---|---|
| `database` | `database` | Required |
| `client` | `client` | A `MongoClient` |
| `connection_string` | `connectionString` | |
| `client_args` | `clientOptions` | A `MongoClientOptions`, which is the driver's name for it |
| `ensure_indexes` | `ensureIndexes` | |
| `index_ready_timeout` (seconds) | `indexReadyTimeoutMs` (milliseconds) | Node durations are milliseconds, and the driver's own options say so in their names (`serverSelectionTimeoutMS`). The unit goes in the name so nobody passes 300 and waits 300 ms |
| `search_type` | `searchType` | |
| `embedding_model` | `embeddingModel` | |
| `embedding_dimensions` | `embeddingDimensions` | |
| `similarity` | `similarity` | |
| `filter_fields` | `filterFields` | |
| `vector_index_name` | `vectorIndexName` | |
| `text_index_name` | `textIndexName` | |
| `ttl_seconds` | `ttlSeconds` | Seconds, unlike the timeout. It sets an `expires_at` that MongoDB's TTL monitor reads, and MongoDB states TTLs in seconds (`expireAfterSeconds`) |

### 5.4 Errors

The Python package raises `StorageError` for anything that fails reaching or using the database, and
`ValueError` for a caller mistake. TypeScript has no `ValueError`, and the SDK exports no validation error. Its
own stores throw a plain `Error` whose message starts with the class name.

**Choice:**
- `StorageError` from the SDK, with `cause` set to the driver error, wherever Python raises `StorageError`. Checklist items 2, 14 and 28 depend on this.
- A built-in `RangeError` for a number out of range, such as `maxSearchResults < 1` (item 17), a non-positive `ttlSeconds`, or a `dimensions` above 8192.
- A built-in `TypeError` for a value of the wrong shape: an MQL operator key in a filter (item 24), or a query that is neither a string nor an object.
- A plain `Error` for the rest, such as a filter naming an undeclared field (item 23).
- Every message starts with the class name, as the SDK's do: `MongoDBMemoryStore: ...`.

`RangeError` and `TypeError` are both subclasses of `Error`, so `catch (e) { if (e instanceof Error) }`
keeps working, and a test can assert the precise class. No new error class is exported, because one would be
the only one in the Strands ecosystem.

### 5.5 Logging

The Python package logs to `logging.getLogger("strands_mongodb")` and attaches `strands_mongodb_event`,
`strands_mongodb_namespace` and `strands_mongodb_tier` through `extra=`. The TS SDK's logger is a global set
by `configureLogging()`, but the instance is not exported, so a third-party package cannot write through it.

**Choice:** the package exports its own `configureLogging(logger: Logger)`, where `Logger` is the SDK's
exported type. The default does what the SDK's default does: `debug` and `info` are no-ops, and `warn` and
`error` go to `console`.

Each call passes a fields object first and the formatted message second:

```ts
log.debug({ strands_mongodb_event: 'score_bound_applied', strands_mongodb_namespace, strands_mongodb_tier }, SCORE_BOUND_APPLIED(name, bound, target, kept, total))
```

That is Pino's argument order, which is the logger the SDK's own documentation configures. Pino merges the object into
the record, `console` prints both, and Winston needs a one-line adapter, which the README shows.

The rest of the Python house rule carries over:
- The `strands_mongodb: ` prefix.
- Message bodies are module constants with their own doc comment. In TS they are small functions, because TypeScript has no `%s` formatting that a test could assert on.
- The same event names in a `LogEvent` union.
- A test that fails when a call skips the fields helper.

A user who calls the SDK's `configureLogging` and not this package's will not see this package's debug records. The README says so next to the logging setup.

### 5.6 The tokenizer is reimplemented, and tested against the SDK

`MongoDBStorage.search` scores keys by token overlap so it ranks the way the SDK's `KeywordSearchStrategy`
does. The TS tokenizer is not exported, so `src/tokenize.ts` reimplements `/[^\p{L}\p{N}_]+/u` with the
stop-word list. Importing it by deep path would break on any SDK release, because the `exports` map forbids that path.

A unit test runs `KeywordSearchStrategy` from `@strands-agents/sdk/storage/search` and `MongoDBStorage.search`
over the same keys and asserts the same order. A drift in the SDK then fails a test rather than ranking differently.

### 5.7 Key normalisation is reimplemented, and tested against the SDK

The SDK's `normalizeKey` and `normalizePrefix` behave exactly as the Python package's rules do:
- They reject a backslash, although the TS documentation omits this.
- They collapse runs of `/` and strip the slashes at either end. `normalizePrefix` keeps one trailing slash.
- They reject an empty key and any `..` segment, throwing `StorageError`.

Python imports the SDK's private normalisers. TypeScript cannot, because the `exports` map forbids the deep
path, just as it does for the tokenizer.

**Choice:** reimplement both in `src/keys.ts`. They are about twenty-five lines, copied with their error messages. Add the two
things the SDK does not do: the 1024-byte UTF-8 key limit, and the prefix join.

Two tests hold the copy to the original:
- A unit test drives the SDK's own `InMemoryStorage`, which calls the real normalisers, and `MongoDBStorage`'s key function over the same inputs. It asserts the same keys and the same rejections. A drift in the SDK then fails a test under `compat`.
- The golden-vector test (§6) pins the result against what Python produces.

The namespaced marker is not imported either. It is `Symbol.for('strands.storage.namespaced')`, and `Symbol.for` returns the same symbol everywhere. A test asserts the SDK's `resolveNamespace` behaviour through `new Agent({ storage })`: memory keys land at the same depth as on `InMemoryStorage`.

### 5.8 Test ids live in test titles

The Python gate reads ids from the first paragraph of a docstring. Vitest has no docstrings at runtime, but
it has titles. **Choice:** the id or ids open the title of the `it` or the `describe`, before an em dash:

```ts
it('AT-021 — a read of an absent key returns null rather than throwing', async () => { ... })
```

Only that leading run of ids counts as evidence, which is the same guard as Python's "first paragraph only". The
ids are the Python ones wherever the TS test proves the same behaviour. A behaviour only the TS package has gets
a `TS-` id (for example `TS-001` for `Symbol.asyncDispose`). The gate's id pattern is Python's plus that prefix:
`\b((?:AT|CH|MP|TS)-[0-9]{1,3}[a-z]*)`.

## 6. On-disk compatibility contract

A TS store and a Python store pointed at the same collection must read each other's documents. That means the following, byte for byte:

**Storage documents:**
- `_id` is the prefix joined to the normalised key.
- `data` is BSON binary subtype 0, written as a `Binary` built from the `Uint8Array`.
- `updated_at` is a BSON date.
- `expires_at` is set only when a TTL is configured.
- `prefixes` holds the key's ancestors, and `embedding` holds the vector, both only under `MongoDBVectorSearchStrategy`.

A read accepts subtypes 0, 2 and 0x80, as Python's does. It returns a plain `Uint8Array` copy, not the driver's
`Buffer` view, so `toEqual` against a written `Uint8Array` holds.

**Memory documents:** `scope` (`__unscoped__` when unset), `store_name`, `content`, `content_hash` (lowercase
hex sha256 of the UTF-8 content), `created_at`, `expires_at` (`created_at` plus the TTL), `metadata`, and
`embedding` on the manual-vector path.

**Indexes, by name and definition:**
- `strands_expires_at_ttl`.
- `strands_scope_store_content_hash_unique`, partial on `content_hash` existing.
- `strands_scope_store_created_at`.
- `vector_index`: autoEmbed over `content` with `voyage-4-lite`, or a vector field on `embedding`, with `scope` and `store_name` as filters.
- `text_index`.
- `storage_vector_index`, over `embedding` with `prefixes` filterable.

**Constants:**
- The reserved metadata keys `_relevance_score`, `_id`, `_search_type` and `_scope`.
- RRF penalty 60.
- Default result count 10.
- Oversampling factor 10.
- `numCandidates` ceiling 10 000.
- Document ceiling 16 MiB.
- Dimension ceiling 8192.
- Ready timeout 300 s.
- Tier retry from 60 s, backing off to 3600 s.

How it is enforced:
1. **Index commands against `python/README.md`.** `src/indexes.ts` renders the same six `createIndexes` and
   `createSearchIndexes` commands that Python's `_indexes.py` does. A unit test parses the `<!-- run: mongosh -->`
   block in `python/README.md` and asserts equality. The Python README is already held equal to the Python
   renderer by `python/tests/test_readme.py`, so the two renderers are equal by transitivity. Neither tree has to import the other.
2. **Golden vectors.** `typescript/test/fixtures/golden.json` holds these, and a unit test asserts each against the TS code:
   - key and prefix normalisation cases, including the rejections;
   - `content_hash` for ASCII, multi-byte and empty content;
   - the `_id` for prefixed keys;
   - the storage and memory document shapes for fixed inputs.

   The expected values were produced by the Python package. `typescript/scripts/golden.py` regenerates them, and it is run by hand with `python -I` when Python's behaviour changes, never in CI. A Python change that alters the format then shows up as a diff in a reviewed file.
3. **The release-gate checklist** (§8.3) holds the behavioural half.

`ci-typescript.yml` watches `python/README.md`, so a Python change that would break item 1 runs the TS suite.

## 7. The npm package

**Name:** `strands-mongodb`, unscoped, matching PyPI.

**Entry point:** one, `.`, which exports the following:
- `MongoDBStorage`, `MongoDBMemoryStore` and `MongoDBVectorSearchStrategy`.
- `configureLogging`.
- The types: `MongoDBConfig`, `MongoDBStorageOptions`, `MongoDBMemoryStoreConfig`, `MongoDBSearchQuery`, `MongoDBAddResult`, `SearchType`, `VectorSimilarity` and `ResolvedSearchType`.
- The constants: `DEFAULT_*`, `RESERVED_METADATA_KEYS` and `UNSCOPED`.
- `VERSION`.

Approaches considered:

| | Shape | For | Against |
|---|---|---|---|
| **A (chosen)** | One entry point, `strands-mongodb` | Matches the Python import surface (`from strands_mongodb import ...`). Bundlers tree-shake an ESM barrel, so a storage-only user ships no memory code. Adding a subpath later is not a breaking change | Nothing that matters at this size |
| B | Root plus `./storage` and `./memory` subpaths, like the SDK | Mirrors the SDK's layout | Two ways to import everything. Removing a subpath later is a breaking change, and none of them buys a smaller install |
| C | Separate `strands-mongodb-storage` and `-memory` packages, emulating extras | Mirrors the extras | Two release pipelines and two versions to keep in step, to split an install that has nothing to split |

**Dependencies:**
- `dependencies` is empty, matching the Python rule.
- Three `peerDependencies`: `@strands-agents/sdk`, `mongodb` and `@opentelemetry/api`. The SDK already requires the last.

The floors are not chosen by reading changelogs. The `Dependency floors` job (§9) installs the declared floors and runs the suite, the way Python's does. The first floors come from the lowest versions that pass, found during implementation. The SDK floor is at least the first release that exports `Storage`, `StorageError`, `MemoryStore` and `./storage/search`'s `Embedder` and `KeywordSearchStrategy`. The driver floor is at least the first that has `appendMetadata`.

**Engines:** `node >= 22.0.0`, which is the SDK's own floor.

**Module format:** ESM only, as the SDK is. The package is compiled by `tsc` to `dist/` with `.d.ts` files.

**Files shipped:** `dist/`, `README.md`, `LICENSE` and `package.json`, set by `files` in `package.json`. A
`build`-tier test packs the tarball and asserts nothing else is in it (§8.1).

## 8. The `typescript/` tree

```
typescript/
  package.json            name, exports, peers, engines, scripts
  package-lock.json
  tsconfig.json           strict, NodeNext, ES2023
  tsconfig.build.json     src only, emits dist/
  vitest.config.ts        one project per tier
  eslint.config.js
  .prettierrc.json
  .gitignore              node_modules/, coverage/, *.tgz
  README.md               the TS reference, parallel to python/README.md
  LICENSE                 a copy of the root licence, so the tarball carries it
  src/
    index.ts              the public surface, an explicit export list
    types.ts              config, query and result types, and constants
    client.ts             the identity registry, attribution, close
    keys.ts               copies of the SDK normalisers, the byte limit and the prefix join
    tokenize.ts           the keyword tokenizer (§5.6)
    filter.ts             filter validation: declared fields, no operator keys
    pipeline.ts           $vectorSearch, $search, autoEmbed, RRF fusion, score bounds
    indexes.ts            the index specs, the renderer, ensure and probe, and the ready wait
    storage.ts            MongoDBStorage
    vector-search.ts      MongoDBVectorSearchStrategy
    memory-store.ts       MongoDBMemoryStore, including the tier probe and retry
    telemetry.ts          spans, the attribute allow-list, log events, configureLogging
    errors.ts             reporting helpers that wrap driver errors in StorageError
  test/
    unit/                 no deployment
    contract/             MONGODB_URI
    integration/          MONGODB_ATLAS_URI
    autoembed/            MONGODB_AUTOEMBED_URI
    build/                STRANDS_MONGODB_BUILD_TIER
    example/              runs examples/ as subprocesses, under its backend's tier
    gate/                 the release-gate assertion, run last
    fixtures/golden.json
    checklist.ts          the 29 items
    support/              tier gating, the tag collector, polling helpers
  examples/               the Python examples' TS counterparts, with userinfo redacted
  scripts/
    golden.py             regenerates fixtures/golden.json, run by hand (§6)
```

`src/` mirrors Python's modules one for one, except `_extras.py`, which has nothing to do here, so a reviewer can
read a Python module and find its counterpart. Python's 1314-line `_indexes.py` is the one file
worth splitting if it ports at that size. The plan will split it into `indexes.ts` (specs and renderer) and
`index-lifecycle.ts` (ensure, probe and wait) if the port runs past about 500 lines.

### 8.1 Tiers

These are the same tiers with the **same environment variables**. That is a requirement rather than a taste: `python/tests/test_conventions.py`
fails `AGENTS.md` if it names a `MONGODB_*` or `STRANDS_MONGODB_*` variable that no Python gate reads.

| Tier | Gate | Vitest project |
|---|---|---|
| unit | none | `unit` |
| contract | `MONGODB_URI` | `contract` |
| integration | `MONGODB_ATLAS_URI` | `integration` |
| autoembed | `MONGODB_AUTOEMBED_URI` | `autoembed` |
| build | `STRANDS_MONGODB_BUILD_TIER` | `build`: `npm pack`, install the tarball into an empty directory, import it, and assert the tarball's file list |
| compat | none, cron or dispatch only | `unit` and `contract` again, after `npm install @strands-agents/sdk@latest` |
| example | its backend's tier | `example` |
| gate | none | `gate`, run after the others in the same invocation |

A tier whose variable is empty skips with a reason naming the variable, through `describe.skipIf`. Variables
are read from the environment and from `typescript/.env` if present. The root `.gitignore` already ignores
`.env` at any depth.

Vitest has no `--strict-markers`. The equivalent is a unit test asserting every test file sits under one of the
directories above, so a file can't fall outside every tier by accident.

The same cluster facts hold: the first `add()` builds two search indexes and waits for `READY`, and a document
becomes searchable some time after its write returns. Helpers poll to a 180 s ceiling. They never sleep for a fixed time.

### 8.2 Commands

Every command runs from `typescript/`.

| Command | Does | Python counterpart |
|---|---|---|
| `npm test` | The suite. Arguments pass through, so `npm test -- test/unit/storage.test.ts` works | `hatch run test` |
| `npm run lint` | ESLint with typescript-eslint | `hatch run lint` |
| `npm run format` / `npm run format:check` | Prettier, in place or read-only | `format` / `format-check` |
| `npm run typecheck` | `tsc --noEmit` over src, tests, scripts and examples | `hatch run typecheck` |
| `npm run cov` | The suite plus both coverage floors: 90% aggregate and 70% per file | `hatch run cov` |
| `npm run check` | format, lint, typecheck, test, in that order | `hatch run prepare` |

The last one is called `check` rather than `prepare` because `prepare` is an npm lifecycle script that runs on every
`npm install`.

### 8.3 Conventions, and what checks each

These are the Python house conventions, translated. As in Python, each one names what enforces it.

| Convention | Checked by |
|---|---|
| `T \| undefined` through optional properties, never `null` in config types. `null` only where the SDK contract returns it (`read`) | `test/unit/conventions.test.ts` |
| Interfaces and type aliases for structure, with no runtime schema library (no zod), matching "no pydantic" | `conventions.test.ts`, which greps `src/` imports |
| An explicit export list in `src/index.ts`, with no `export *` | ESLint `no-restricted-syntax`, and a test comparing the export list with the README's API table |
| No string concatenation into log messages. Message bodies are named constants | `conventions.test.ts` |
| A `@throws` tag on every exported function and method that throws | `conventions.test.ts`, which walks the exported declarations with the TypeScript compiler API |
| TSDoc on everything exported. camelCase members, and `#private` or a leading underscore for internals | ESLint `naming-convention`, and review for the prose |
| No API above the Node 22 floor without a guard | The matrix's 22 leg |
| Conventional commit subjects | Review, as in Python |
| A test that proves a checklist behaviour opens its title with the id | The gate reporter. Untagged tests are allowed, as in Python, but a leading id that is neither a checklist id nor a `TS-` id fails the gate, so a typo cannot pass as evidence |
| No connection string with userinfo in any file under `typescript/` | `conventions.test.ts`, using the same pattern as AT-114. The root sweep in `python/tests/test_conventions.py` already covers the Markdown here |

**The release gate.** `test/checklist.ts` holds the 29 items with their numbers, gate flags and ids. The behaviour
text is phrased for TypeScript, so item 1 reads "a read of an absent key returns null", and item 17 reads "below 1 throws a
RangeError". A unit test reads `python/tests/test_gate.py` as text and asserts that the item numbers, gate flags and
ids match, so the two checklists cannot drift apart without a test noticing.

A custom Vitest reporter in `test/support/` collects each test's leading ids and its outcome. The `gate` project fails if any gate item (1 to 9 and 16 to 19) lacks a passing test, and it reports a skipped item as unverified rather than as passed, exactly as `ChecklistGate` does.

### 8.4 Telemetry

The package uses the same span names (`strands_mongodb.storage.write`, `strands_mongodb.memory.search`,
`strands_mongodb.indexes.ensure` and the rest), the same attribute allow-list and the same 14 log events, from
`trace.getTracer('strands-mongodb', VERSION)`. The rule that no attribute carries caller data holds unchanged.
`typescript/README.md`'s observability section lists every span, attribute and event, and a test fails until
a new one appears there, mirroring `test_readme.py`.

## 9. CI: `.github/workflows/ci-typescript.yml`

Runs on `pull_request` only. The workflow sets `permissions: contents: read`, pins every action by SHA as `ci-python.yml` does, and runs every job in `typescript/`.

`paths:` covers the following:
- `typescript/**` and `.github/workflows/ci-typescript.yml`.
- `python/README.md`, because of the index-command comparison.
- `python/tests/test_gate.py`, because of the checklist comparison.
- `AGENTS.md`, `CONTRIBUTING.md` and `README.md`.

| Job | Does |
|---|---|
| `Lint and format` | `npm ci`, `format:check`, `lint` |
| `Typecheck` | `npm run typecheck` |
| `Unit (Node ${{ matrix.node }})` | `npm run cov`, with Node 22, 24 and 26. The legs are checked against the Node release schedule at implementation, and the list holds only lines in active or maintenance LTS plus the current line |
| `Contract tier (<deployment>)` | A matrix copied from `ci-python.yml`'s `contract` job (read its lines 206–297). One leg runs `mongo:8`, which has no search process. The other runs `mongodb/mongodb-atlas-local:8`, which has `mongot`. Both run the contract tier, and the Atlas-local leg also runs the integration tier with `MONGODB_ATLAS_URI` set to the service URI. No secret is needed |
| `Dependency floors` | Installs exactly the declared peer floors and runs `unit` and `contract` |
| `Build` | The build tier: pack, install into an empty directory, import |
| `Release gate` | Runs every tier available to a pull request, then `gate` |

**Deferred:** the `autoembed` tier in CI. Automated embedding needs a real Atlas cluster, and Python's `Atlas tiers` job
gets one from a secret and `python/scripts/atlas_ci_cluster.py`. Wiring TS to that needs the same secret and a decision
on who pays for the cluster's minutes, so the first pass leaves it out. Before the branch is offered for review, the
tier is run by hand against a cluster with `MONGODB_AUTOEMBED_URI` set.

## 10. Shared files, in the final commit

All of these go in one `docs:` commit after the `typescript/` work, as the brief asks. Before that commit is made, `cd python && hatch run test tests/test_ci.py tests/test_conventions.py` has to pass.

- **`AGENTS.md`** gains a per-language section rather than a second file. AT-112 requires one copy of each document at the root. Its Layout table gains `typescript/` and `ci-typescript.yml`, and the sentence "Everything with a version number lives under `python/`" becomes true of both trees. The TS section holds the commands, tiers and conventions tables from §8. Hazards that `python/tests/test_conventions.py` turns into failures:
  - Any `3.N` in the text is read as a Python version and must be a supported one. "Vitest 3.2" fails, so the section names no tool versions.
  - Every backticked path ending `.md`, `.yml`, `.toml`, `.lock` and similar must exist, so the paths are written after the files exist.
  - Any `-m` on a line mentioning `pytest` or `hatch run test` must be a registered marker.
  - Every `MONGODB_*` and `STRANDS_MONGODB_*` variable must be a Python gate. The TS tiers reuse those exact names for this reason.
  - Any `TODO(...)` fails unless it is declared open. The section has none.
- **`CONTRIBUTING.md`** gains TypeScript setup and the `ci-typescript.yml` job table. `test_the_documented_gates_are_the_workflow_jobs` reads every table row in that file whose first cell is a backticked name starting with a capital as a claimed `ci-python.yml` job, so the TS job names in that table would fail it. **Choice:** the TS job table goes in `typescript/README.md`, and CONTRIBUTING gets a paragraph that points there. The test sees no new row, and the process document still says where the gates are.
- **`README.md`** changes its layout table to list `typescript/`, and the sentence "A `typescript/` sibling publishing the same name to npm may follow" becomes a link.
- **`.gitignore`** at the root is not touched. `typescript/.gitignore` carries `node_modules/`, and the root already ignores `dist/` and `.env`. `node_modules` is already outside the Python Markdown sweep.

Each of those three Markdown files is in `ci-python.yml`'s `paths`, so the final commit also runs the Python suite in CI. That is intended.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The TS SDK changes its key normalisation or the tokenizer in a minor release | The `InMemoryStorage` and `KeywordSearchStrategy` comparison tests fail under `compat` before users see it |
| The Python index commands change and the TS renderer does not | The test against the `python/README.md` block fails, and `ci-typescript.yml` watches that file |
| The real SDK floor is lower than the first version that passes on today's code | Accepted. The floors job finds the lowest that passes, and claiming lower would be a guess about somebody's install |
| Logging through a second `configureLogging` surprises users | Documented in the README next to the SDK's own call, with the two-line Pino setup that configures both |
| The autoembed tier is not in CI on the first pass | Run by hand before review, and named in §9 as deferred with the reason |

## 12. Implementation handoff

This section is for the session that builds what §1–§11 describe. It assumes you have read nothing else yet.

### 12.1 Ground rules

These come from the ticket brief (`.claude/NODE-7997-brief.md`, untracked), the owner's global instructions,
and `AGENTS.md`. Breaking any of them is a defect, however good the code.

- Work in `~/src/strands-mongodb-ts` on branch `NODE-7997-typescript`. Never touch the sibling directory `~/src/strands-mongodb` or its branch `INTPYTHON-1170-SSDLC`.
- **Never `git push` and never open a pull request.** Ask the owner.
- Sign off every commit with `git commit -s`. Never add a `Co-authored-by` trailer for the agent.
- Use conventional commit subjects: `feat:`, `fix:`, `test:`, `refactor:`, `chore:`, `docs:`, `ci:`. Commit often, after each milestone in §12.4 at the latest.
- Do not modify anything under `python/`, or `.github/workflows/release-python.yml`, or `.github/dependabot.yml`. Reading them is fine and necessary.
- The TS release pipeline is out of scope: no signing, no SBOM, no Papertrail, no `npm publish`.
- Edits to `AGENTS.md`, `CONTRIBUTING.md`, `README.md` and `docs/` go in **one separate, final commit**, after all the `typescript/` work (§10, milestone M11).
- Tests first. A behaviour change comes with the test that proves it, written before the code, and every test that proves a checklist behaviour opens its title with the id (§5.8).
- Never put a connection string with userinfo in a file. A local `mongodb://localhost:27017` has none and is fine. Anything with a user or password is written `mongodb+srv://<redacted>@cluster.example.net`, which is the only userinfo the repository's sweep allows.
- Never infer an SDK or driver API. Read the installed package under `typescript/node_modules`.
- `dependencies` stays empty, and everything goes in `peerDependencies` or `devDependencies`.
- Never skip a test to get to green. Never silence a warning to make a run quiet.
- Never write a bare `TODO`. A `TODO(...)` names the thing that has to be settled.
- If you are blocked on a decision only the owner can make, stop and ask. Don't guess. This document already settles every design question it raises.

### 12.2 Read first

1. `AGENTS.md` and `CONTRIBUTING.md`: the rules and the process this repository runs on.
2. `python/README.md`: the reference for every behaviour. The TS README is its counterpart.
3. The Python module you are about to port (§12.3) and its test file. **The Python tests are the specification.** Each docstring names the id it proves, and `grep -n "AT-021" python/tests/*.py` finds the test that defines an id.
4. The installed SDK, for every type you import. Run `npm install` first, then read `typescript/node_modules/@strands-agents/sdk/dist/src`, starting with `storage/storage.d.ts`, `memory/types.d.ts` and `index.d.ts`.

These import paths are verified against 1.24.0:

```ts
import { Agent, MemoryManager, SessionManager, StorageError, Tool } from '@strands-agents/sdk'
import type { JSONValue, Logger, MemoryEntry, MemoryStore, MemoryStoreConfig, SearchOptions, Storage } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import { Embedder, KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
import type { SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
```

Nothing else is public. In particular, `normalizeKey`, `normalizePrefix`, `namespace`, `resolveNamespace`, `NAMESPACED`
and `tokenize` are **not** exported. Their source is in `dist/src/storage/storage.js` and
`dist/src/storage/search/keyword.js`, and §5.6 and §5.7 say how to handle each.

`pymongo-search-utils`, which Python's `_pipeline.py` calls, is not installed anywhere you may touch. To read
the stages it builds, install it into a throwaway virtualenv in your scratch directory:
`python3 -m venv <scratch>/psu && <scratch>/psu/bin/pip install pymongo-search-utils==0.3.0`.

### 12.3 Port map

Line numbers are as of `main` at `0de7b9f`.

| TS file | Ports | Behaviour and ids from |
|---|---|---|
| `src/types.ts` | `types.py` (all of it). The constants in `storage.py:49-69`, `memory_store.py:61-84`, `_indexes.py:82-170` and `_pipeline.py:54-91` | `test_types.py` |
| `src/keys.ts` | The SDK's `normalizeKey` and `normalizePrefix`, copied. The prefix normalisation in `storage.py:236-250`, `_encoded_size`, `_successor` and `_abbreviate` in `storage.py:75-125`, and `_id_for` and `_range_for` at `storage.py:636-690` | `test_storage.py`: AT-018, AT-019 |
| `src/tokenize.ts` | `dist/src/storage/search/keyword.js` in the SDK: `tokenize` and `STOP_WORDS` | `test_storage.py`'s search tests |
| `src/telemetry.ts` | `_telemetry.py`: `SpanName`, `Attribute` (the allow-list), `LogEvent`, `traced`, `span`, `event_extra`, `annotate`, `event`. Plus `configureLogging` (§5.5) | `test_telemetry.py` |
| `src/errors.ts` | `_reporting` in `storage.py:126-170` and `memory_store.py:344-378`, and the `StorageError` wrapping | `test_storage.py`: AT-022, AT-036 |
| `src/client.ts` | `_client.py`, **except** the event-loop parts (`_running_loop`, `_reap_closed_loops` and the loop keying in `_register`) | `test_client.py`: AT-010 to AT-013b |
| `src/filter.ts` | `_filter.py` | `test_filter.py`: AT-049, AT-050a to AT-050c |
| `src/pipeline.ts` | `_pipeline.py`, plus the `$vectorSearch` and `$search` stages it gets from `pymongo-search-utils` | `test_pipeline.py` |
| `src/indexes.ts` | `_indexes.py:82-560`: the specs, the definitions and the command renderer | `test_indexes.py`, and the `<!-- run: mongosh -->` block in `python/README.md` |
| `src/index-lifecycle.ts` | `_indexes.py:564-1314`: the search-support probe, the collation check, `ensure`, the ready wait, `embed` | `test_indexes.py` |
| `src/storage.ts` | `storage.py` | `test_storage.py`, `test_construction.py`. Gate items 1–9 |
| `src/vector-search.ts` | `vector_search.py`, plus `remove()` (§4) | `test_vector_search.py` |
| `src/memory-store.ts` | `memory_store.py` | `test_memory_store.py`. Gate items 16–19 |
| `src/index.ts` | `__init__.py`'s export list, eagerly. Python's lazy `__getattr__` exists for the extras and is dropped | `test_init.py` |
| `README.md` | `python/README.md`, translated | `test_readme.py` |
| `examples/` | `python/examples/unified_storage.py` and `memory_recall.py` | `test_examples.py` |
| `test/build/` | n/a | `test_packaging.py` |

These Python test files have no TS counterpart:
- `test_extras.py` and `test_lazy_exports.py`: there are no extras.
- `test_migration.py`: it covers `python/MIGRATION.md`.
- `test_ci.py`, `test_release_ci.py` and `test_atlas_ci_cluster.py`: they cover Python's workflows.

The TS suite gets one CI test of its own instead. It asserts that `ci-typescript.yml`'s `paths` cover every file outside `typescript/` that a TS test reads: today `python/README.md` and `python/tests/test_gate.py`.

A Python test about something Python-only, such as event loops, the `cast` around `add_messages` or mypy, gets no TS
copy. Don't reuse its id for something else.

### 12.4 Build order

Each milestone ends green and committed. Run the verification in §12.5 before each commit.

| | Milestone | Commit subject, roughly |
|---|---|---|
| M0 | Scaffold `typescript/`: `package.json` (name, `"type": "module"`, `engines`, empty `dependencies`, the three peers also as dev dependencies at their latest versions), `tsconfig*.json`, `vitest.config.ts` with one project per tier, ESLint, Prettier, `.gitignore`, a copy of the root `LICENSE`, `src/index.ts` exporting `VERSION`, `test/support/tiers.ts` (the `.env` reading and `describe.skipIf` gating), and one tagged smoke test | `chore: scaffold the TypeScript package` |
| M1 | The gate: `test/checklist.ts`, the comparison test against `python/tests/test_gate.py`, the id reporter, and the `gate` project. Build it first so that every later test is counted | `test: add the release-gate checklist and reporter` |
| M2 | `types.ts`, `keys.ts` with its `InMemoryStorage` comparison test, `tokenize.ts` with its `KeywordSearchStrategy` comparison test, `scripts/golden.py` and `test/fixtures/golden.json` | `feat: add types, key normalisation and the tokenizer` |
| M3 | `telemetry.ts`, `errors.ts` | `feat: add telemetry and error reporting` |
| M4 | `client.ts` | `feat: add the shared client registry` |
| M5 | `indexes.ts` with the `python/README.md` comparison test, then `index-lifecycle.ts` | `feat: add index specs and lifecycle` |
| M6 | `storage.ts`, unit tier then contract tier. Gate items 1–9 pass | `feat: add MongoDBStorage` |
| M7 | `vector-search.ts` | `feat: add MongoDBVectorSearchStrategy` |
| M8 | `filter.ts`, `pipeline.ts` | `feat: add filter validation and search pipelines` |
| M9 | `memory-store.ts`, unit, contract and integration tiers. Gate items 16–19 pass | `feat: add MongoDBMemoryStore` |
| M10 | `typescript/README.md`, `examples/`, the conventions test, the README-coverage tests, the build tier, and `.github/workflows/ci-typescript.yml` | `docs:` for the README and `ci:` for the workflow, as separate commits |
| M11 | The shared-file commit (§10): `AGENTS.md`, `CONTRIBUTING.md`, `README.md`. Run the Python checks in §12.5 first | `docs: describe the TypeScript package in the shared documents` |
| M12 | Run the autoembed tier by hand (§9). Then stop and report to the owner: what is done, the verification output, and what was deferred. **Do not push.** | none |

Unit tests may use small hand-written fakes of the driver's `Collection` where Python uses `AsyncMock`. Anything that depends on real server behaviour belongs in the contract tier. That includes ordering, collation, TTL fields, unique-index races and aggregation results.

### 12.5 Verification

From `typescript/`, before every commit:

```bash
npm run check                          # format, lint, typecheck, unit tier
MONGODB_URI=mongodb://localhost:27017 npm test -- --project contract
```

For the contract and integration tiers locally, start a deployment with Docker. `mongo:8` covers contract. `mongodb/mongodb-atlas-local:8` covers integration, with `MONGODB_ATLAS_URI=mongodb://localhost:27017/?directConnection=true`.

From `python/`, before the M11 commit and before any commit that touches a file outside `typescript/`:

```bash
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= hatch run test tests/test_ci.py tests/test_conventions.py
```

**Known local failure:** while `.claude/NODE-7997-brief.md` contains an unredacted connection string,
`test_no_swept_document_carries_a_credential` fails on that file and on no other. The file is untracked, so CI never
sees it. Any *other* file in that failure is yours to fix. Don't edit the brief.

The work is done when all of these hold:
- `npm run cov` passes both coverage floors.
- The contract, integration and gate projects pass against local deployments.
- The build tier passes with `STRANDS_MONGODB_BUILD_TIER=1`.
- The Python checks above pass, apart from the known failure.
- `git status` shows nothing but `.claude/`.

### 12.6 Traps

- **The SDK's internals are not public** (§12.2). An import from a deep `dist/` path typechecks in some setups and fails at runtime because of the `exports` map. Copy the code, and test the copy against the public behaviour.
- **`AGENTS.md` is read by Python tests** (§10):
  - No `3.N` version strings anywhere in it.
  - Backticked file paths only once the files exist.
  - Tier variables reuse the Python names.
  - No `-m` next to `pytest` or `hatch run test` unless it names a registered marker.

  Write it last.
- **`CONTRIBUTING.md` tables:** a table row whose first cell is a backticked name starting with a capital is read as a `ci-python.yml` job. Keep the TS job table in `typescript/README.md`.
- **`npm run prepare` runs on every install.** The aggregate command is `npm run check`.
- **`Buffer` is not `Uint8Array` for `toEqual`.** Copy driver `Binary` payloads into a fresh `Uint8Array` (§6).
- **Search indexes are slow and eventually consistent.** A first `add()` waits minutes for `READY`, and a write is not immediately searchable. Poll to a 180 s ceiling. Never sleep for a fixed time.
- **`addMessages` must stay absent** from `MongoDBMemoryStore`. If it is present, the SDK sends raw messages and skips extraction (§4, checklist item 20).
- **The release gate reads only the leading ids of a title.** `it('AT-021 — ...')` counts, and `it('reads ... (AT-021)')` does not.
- **The `paths` filter of `ci-typescript.yml`** must list every file outside `typescript/` that a TS test reads. A test enforces this, so adding such a read means extending the filter.
