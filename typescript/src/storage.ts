/**
 * `MongoDBStorage`: the SDK's `Storage` over one MongoDB collection, one document per key.
 *
 * Ported from `python/src/strands_mongodb/storage.py`. Each key is one document whose `_id` is the key with
 * the instance's prefix, so every operation is a primary-key lookup or a range scan over the `_id` index.
 *
 * Three differences from Python, each for a reason the code states where it happens:
 *
 * - A key, a prefix and a payload size are validated before the collation check, where Python checks the
 *   collation first. Validation needs no round trip, so a bad key costs nothing and never reaches the
 *   network, which the leak tests rely on.
 * - Messages start `MongoDBStorage:` rather than `strands_mongodb:`, as `src/errors.ts` explains. The index
 *   messages, which come from the shared lifecycle module, keep Python's prefix.
 * - There is no per-event-loop connection. The connection is still resolved per operation, so a store used
 *   after `close()` opens a new one, as Python's does.
 *
 * @packageDocumentation
 */
import { StorageError } from '@strands-agents/sdk'
import type { Storage } from '@strands-agents/sdk'
import type { SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary, MongoError } from 'mongodb'
import type { Collection, Db, Document, Double, Filter } from 'mongodb'

import { close, resolve, type Connection } from './client.js'
import { reportingStorage } from './errors.js'
import { ensure, requireBinaryComparison } from './index-lifecycle.js'
import { checkTtl, type SearchIndexSpec, storageSpecs } from './indexes.js'
import { abbreviate, encodedSize, idFor, instancePrefix, rangeFor } from './keys.js'
import { annotate, traced } from './telemetry.js'
import { tokenize } from './tokenize.js'
import type { MongoDBConfig, MongoDBStorageOptions } from './types.js'
import { DEFAULT_STORAGE_COLLECTION, EXPIRES_FIELD, MAX_DOCUMENT_BYTES, READY_TIMEOUT_MS } from './types.js'

/**
 * The SDK's marker for a storage that is already scoped, by its registered name. The SDK does not export the
 * symbol, and `Symbol.for` returns the one it registered.
 */
const NAMESPACED = Symbol.for('strands.storage.namespaced')

/**
 * A token as the SDK's tokenizer sees one, in the server's regex syntax. Not `\w+`: MongoDB's `\w` is
 * ASCII-only, so `münchen` would split into `m` and `nchen` and `日本語` would vanish. The SDK splits on
 * anything outside letters, digits and `_`, which is exactly this class.
 */
const TOKEN_PATTERN = '[\\p{L}\\p{N}_]+'

/** One stored key, as this package writes it. */
export interface StoredDocument {
  _id: string
  /** Written as a `Uint8Array`; read back as a `Binary`. */
  data: Uint8Array | Binary
  updated_at: Date
  /** Present only when the store has a TTL. */
  expires_at?: Date
  /** The value's vector, set only by `MongoDBVectorSearchStrategy`. */
  embedding?: Double[]
  /** Every `/`-terminated ancestor of `_id`, set only by `MongoDBVectorSearchStrategy`. */
  prefixes?: string[]
}

/**
 * The collection a store's data calls run on, resolved per call as the store's own methods resolve it.
 *
 * For `MongoDBVectorSearchStrategy`, which reads and writes the same documents. Python's strategy calls the
 * store's private `_collection()`; a `#` field cannot be reached from another module, so the class hands this
 * function out from a static block instead. Not exported from the entry point.
 */
export let storageCollection: (storage: MongoDBStorage) => Collection<StoredDocument>

/** A strategy that also declares the search index it needs, such as the vector strategy. Duck-typed, as Python's `getattr`. */
interface WithIndexSpec {
  indexSpec?: () => SearchIndexSpec
}

/**
 * A `Storage` backed by a MongoDB collection.
 *
 * Build the config once per process and reuse it: stores given the same config share one client. Keys are
 * normalised the way the SDK's own backends normalise them, so `a//b` and `/a/b/` are the key `a/b`.
 *
 * Every key operation, and `ensureIndexes`, refuses a collection whose default collation is not binary.
 * Keys must compare byte by byte, or one prefix could read and delete another's documents.
 *
 * `forSandbox` is absent on purpose: the SDK probes for it and falls back, so a stub that threw would break
 * context offloading instead of degrading it.
 *
 * @example
 * ```ts
 * const config: MongoDBConfig = { database: 'agents', connectionString: process.env.MONGODB_URI }
 * const sessions = new MongoDBStorage(config, { collection: 'sessions' })
 * const transcripts = new MongoDBStorage(config, { collection: 'transcripts' }) // same client
 * ```
 */
export class MongoDBStorage implements Storage {
  // Private fields rather than properties, so `inspect` and `JSON.stringify` show nothing of the config,
  // whose connection string may carry a password.
  readonly #config: MongoDBConfig
  readonly #database: string
  readonly #collection: string
  readonly #prefix: string
  readonly #ttlSeconds: number | undefined
  readonly #strategy: SearchStrategy<MongoDBStorage> | undefined
  readonly #indexReadyTimeoutMs: number

  static {
    storageCollection = (storage) => storage.#resolve().collection
  }

  /**
   * Create a store over one collection. No I/O: the first operation connects.
   *
   * @param config - Connection and deployment settings. Pass the same object to a memory store to share the
   *   client.
   * @param options - The collection, a key prefix, a document lifetime and a search strategy. A `ttlSeconds`
   *   only stamps `expires_at`: expiry needs the TTL index, which only {@link MongoDBStorage.ensureIndexes}
   *   creates.
   * @throws RangeError when `ttlSeconds` is negative.
   * @throws StorageError when `prefix` contains a backslash or a `..` segment.
   * @throws TypeError when the config has neither `client` nor `connectionString`.
   * @throws MongoParseError, from the driver, when it refuses the connection string.
   */
  constructor(config: MongoDBConfig, options: MongoDBStorageOptions = {}) {
    // Everything that can throw runs before `resolve`, which registers a client in the process-wide
    // registry. Throwing after that would leave a client no store owns and no `close()` can reach.
    this.#database = config.database
    checkTtl(options.ttlSeconds)
    this.#collection = options.collection ?? DEFAULT_STORAGE_COLLECTION
    this.#prefix = instancePrefix(options.prefix ?? '')
    this.#ttlSeconds = options.ttlSeconds
    this.#strategy = options.searchStrategy
    this.#config = config
    this.#indexReadyTimeoutMs = config.indexReadyTimeoutMs ?? READY_TIMEOUT_MS
    // Only to fail fast on a config with no connection. Each operation resolves its own, so a store used
    // after `close()` reconnects rather than holding a closed client.
    resolve(config, 'MongoDBStorage')
  }

  /** The normalised key prefix, ending in `/`, or `''` when none was configured. */
  get prefix(): string {
    return this.#prefix
  }

  /** The database this store writes to. */
  get databaseName(): string {
    return this.#database
  }

  /** The collection this store writes to. */
  get collectionName(): string {
    return this.#collection
  }

  /** The lifetime of the documents this store writes, or `undefined` when they never expire. */
  get ttlSeconds(): number | undefined {
    return this.#ttlSeconds
  }

  /**
   * Store `data` under `key`, replacing whatever was there.
   *
   * One upsert, so two writers racing on one key never meet a duplicate-key error.
   *
   * @param key - The key. Normalised, so `a//b` and `a/b` are one key.
   * @param data - The bytes, round-tripped unchanged, including an empty array.
   * @throws StorageError when the key is empty, contains a backslash or a `..` segment, or exceeds 1024
   *   bytes with the prefix; when the document would exceed the BSON limit; when the collation is not
   *   binary; when the write fails, with the driver's error as the cause; or when the search strategy fails
   *   to index the value, which is stored in that case.
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    return this.#run('write', 'writing', key, async (collection) => {
      const id = idFor(this.#prefix, key, this.#target)
      const expires = this.#ttlSeconds !== undefined
      const size = encodedSize(id, data.length, expires)
      if (size > MAX_DOCUMENT_BYTES) {
        // Checked before sending so the caller sees the sizes, which the driver's own error does not report.
        throw new StorageError(
          `MongoDBStorage: the document for the key '${abbreviate(id)}' would encode to ${size} bytes, over ` +
            `the ${MAX_DOCUMENT_BYTES}-byte BSON limit in ${this.#target}. Store the payload elsewhere and keep ` +
            'a reference here, or split it across keys.',
        )
      }
      await this.#requireBinaryKeys()

      const now = new Date()
      const document: StoredDocument = { _id: id, data, updated_at: now }
      // Only with a TTL. The TTL index never expires a non-date value, so a null would be dead bytes.
      if (this.#ttlSeconds !== undefined) document[EXPIRES_FIELD] = new Date(now.getTime() + this.#ttlSeconds * 1000)
      await collection.replaceOne({ _id: id }, document, { upsert: true })

      const strategy = this.#strategy
      if (strategy?.index === undefined) return
      try {
        await strategy.index(this, id.slice(this.#prefix.length), data)
      } catch (error) {
        throw new StorageError(
          `MongoDBStorage: wrote '${abbreviate(id)}' in ${this.#target} but indexing it for search failed: ` +
            messageOf(error),
          { cause: error },
        )
      }
    })
  }

  /**
   * The bytes stored under `key`, or `null`. A missing key is not an error: the SDK's session manager reads
   * it as "no session yet".
   *
   * @param key - The key.
   * @returns A plain `Uint8Array`, never a `Buffer` or a BSON `Binary`, or `null` when the key is absent.
   * @throws StorageError when the key is invalid, when the collation is not binary, or when the read fails,
   *   with the driver's error as the cause.
   */
  async read(key: string): Promise<Uint8Array | null> {
    return this.#run('read', 'reading', key, async (collection) => {
      const id = idFor(this.#prefix, key, this.#target)
      await this.#requireBinaryKeys()
      const document = await collection.findOne({ _id: id })
      annotate('strands_mongodb.found', document !== null)
      if (document === null) return null
      // The driver decodes binary data, of any subtype, as a `Binary`. Copied out so the caller owns the
      // bytes and gets the type the SDK declares.
      const data = document.data
      return new Uint8Array(data instanceof Binary ? data.value() : data)
    })
  }

  /**
   * Remove `key`. Removing a key that does not exist is not an error.
   *
   * @param key - The key.
   * @throws StorageError when the key is invalid, when the collation is not binary, or when the delete
   *   fails, with the driver's error as the cause.
   */
  async delete(key: string): Promise<void> {
    return this.#run('delete', 'deleting', key, async (collection) => {
      const id = idFor(this.#prefix, key, this.#target)
      await this.#requireBinaryKeys()
      const result = await collection.deleteOne({ _id: id })
      annotate('strands_mongodb.deleted_count', result.deletedCount)
    })
  }

  /**
   * Every key under the prefix `query`, in ascending order. Only keys are fetched, never payloads.
   *
   * @param query - A key prefix. `''` matches everything, which is how the SDK's keyword strategy reads the
   *   whole store.
   * @returns Full keys, without this store's own prefix, so each can be passed straight back to `read`.
   * @throws StorageError when the prefix contains a backslash or a `..` segment, when the collation is not
   *   binary, or when the scan fails at any point, including part way through draining the cursor.
   */
  async list(query: string): Promise<string[]> {
    return this.#run('list', 'listing', query, async (collection) => {
      const range = rangeFor(this.#prefix, query)
      await this.#requireBinaryKeys()
      const offset = this.#prefix.length
      const keys: string[] = []
      for await (const document of collection
        .find(range as Filter<StoredDocument>, { projection: { _id: 1 } })
        .sort({ _id: 1 })) {
        keys.push(String(document._id).slice(offset))
      }
      annotate('strands_mongodb.result_count', keys.length)
      return keys
    })
  }

  /**
   * Rank stored keys by how many of the query's tokens they contain, unless a search strategy is set.
   *
   * Scoring matches the SDK's `KeywordSearchStrategy`, token overlap, but **only keys are scored, not
   * payloads**: a word that appears only inside stored data does not match. In exchange the search is one
   * server-side aggregation that reads no documents. `FileMemoryStore` keeps facts in payloads, so give it a
   * `searchStrategy`.
   *
   * @param query - A natural-language string. One with no tokens returns `[]` without a round trip.
   * @returns Matched keys and scores, highest first, ties in ascending key order, with no `data`. A
   *   strategy's results are returned as it gives them.
   * @throws StorageError when the query has tokens and the collation is not binary, when the aggregation
   *   fails, including part way through draining the cursor, or when the strategy throws, with its error as
   *   the cause.
   */
  async search(query: string): Promise<StorageSearchResult[]> {
    return this.#run('search', 'searching', query, async (collection) => {
      const strategy = this.#strategy
      if (strategy !== undefined) {
        let results: StorageSearchResult[]
        try {
          results = await strategy.search(this, query)
        } catch (error) {
          if (error instanceof StorageError || error instanceof MongoError) throw error
          throw new StorageError(`MongoDBStorage: searching in ${this.#target} failed: ${messageOf(error)}`, {
            cause: error,
          })
        }
        annotate('strands_mongodb.result_count', results.length)
        return results
      }
      const tokens = tokenize(query)
      // The same short circuit as `KeywordSearchStrategy`: scoring every key zero would cost a full scan.
      // Before the collation check, so an empty query costs no round trip at all.
      if (tokens.size === 0) return []
      await this.#requireBinaryKeys()
      const offset = this.#prefix.length
      const results: StorageSearchResult[] = []
      for await (const document of collection.aggregate(this.#searchPipeline(tokens))) {
        results.push({ key: String(document._id).slice(offset), score: Number(document.score) })
      }
      annotate('strands_mongodb.result_count', results.length)
      return results
    })
  }

  /**
   * Remove every key under `prefix` in one call. Not part of `Storage`: it deletes a whole session in one
   * round trip instead of a `list` and one `delete` per key.
   *
   * @param prefix - The key prefix. `''` empties this store's key space.
   * @returns How many documents were removed.
   * @throws StorageError when the prefix contains a backslash or a `..` segment, when the collation is not
   *   binary, or when the delete fails, with the driver's error as the cause.
   */
  async deletePrefix(prefix: string): Promise<number> {
    return this.#run('delete_prefix', 'deleting the prefix', prefix, async (collection) => {
      const range = rangeFor(this.#prefix, prefix)
      await this.#requireBinaryKeys()
      const result = await collection.deleteMany(range as Filter<StoredDocument>)
      annotate('strands_mongodb.deleted_count', result.deletedCount)
      return result.deletedCount
    })
  }

  /**
   * A new store scoped to `prefix` within the same collection.
   *
   * A real `MongoDBStorage` rather than the SDK's wrapper, which exposes only the protocol methods and would
   * turn `list` into a full scan with the prefix stripped client-side. It carries the SDK's marker, so the
   * SDK does not scope it a second time.
   *
   * @param prefix - Appended to any prefix already in force.
   * @returns A store sharing this one's client, collection, TTL and search strategy.
   * @throws StorageError when `prefix` contains a backslash or a `..` segment.
   */
  namespace(prefix: string): MongoDBStorage {
    const scoped = new MongoDBStorage(this.#config, {
      collection: this.#collection,
      // The constructor normalises, so a leading slash here does not produce an empty segment.
      prefix: `${this.#prefix}${prefix}`,
      ...(this.#ttlSeconds === undefined ? {} : { ttlSeconds: this.#ttlSeconds }),
      ...(this.#strategy === undefined ? {} : { searchStrategy: this.#strategy }),
    })
    // Without the marker, memory keys would land one level deeper here than on the SDK's own storage.
    Object.defineProperty(scoped, NAMESPACED, { value: true })
    return scoped
  }

  /**
   * Create the TTL index that makes `ttlSeconds` take effect, or verify it exists, along with the search
   * index of a strategy that declares one.
   *
   * **Nothing in this package calls this method.** An agent builds its storage in code the operator does
   * not see, and index creation there could run without the rights for it. Call it once at startup.
   * Idempotent. With `ensureIndexes: false` in the config it only verifies, and a missing index throws with
   * the `createIndexes` command that would fix it.
   *
   * @throws StorageError when the collation is not binary, when an index over the same keys exists with
   *   different options, when the index is absent and `ensureIndexes` is `false`, when a search build fails,
   *   or when a driver call fails, with the driver's error as the cause.
   * @throws SearchIndexNotReady when a search build does not finish inside `indexReadyTimeoutMs`.
   */
  async ensureIndexes(): Promise<void> {
    // Not wrapped by `reportingStorage`: there is no key for its message, and `ensure` already turns driver
    // errors into `StorageError`.
    return traced('storage', 'ensure_indexes', this.#spanTarget, async () => {
      // The collation does not affect a TTL index, but a collection that cannot hold this key space is not
      // worth provisioning: it would only fail at its first write.
      await this.#requireBinaryKeys()
      const strategy = this.#strategy as (SearchStrategy<MongoDBStorage> & WithIndexSpec) | undefined
      const { db, untyped } = this.#resolve()
      await ensure(db, untyped, {
        ordinary: storageSpecs(),
        search: strategy?.indexSpec === undefined ? [] : [strategy.indexSpec()],
        create: this.#config.ensureIndexes ?? true,
        timeoutMs: this.#indexReadyTimeoutMs,
      })
    })
  }

  /**
   * Release the client, closing it only if this package built it. Idempotent, and leaves an injected client
   * open.
   *
   * **This releases the client for every store built from the same config**, so call it once at shutdown. A
   * store used afterwards opens a new client.
   */
  async close(): Promise<void> {
    await close(this.#config)
  }

  /** {@link MongoDBStorage.close}, for `await using`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** One operation: its span, its error reporting, and the collection it runs on. */
  #run<T>(
    operation: 'write' | 'read' | 'delete' | 'list' | 'search' | 'delete_prefix',
    verb: Parameters<typeof reportingStorage>[0],
    subject: string,
    body: (collection: Collection<StoredDocument>) => Promise<T>,
  ): Promise<T> {
    return traced('storage', operation, this.#spanTarget, () =>
      reportingStorage(verb, subject, this.#target, () => body(this.#resolve().collection)),
    )
  }

  /**
   * Refuse a collection whose collation would not compare this store's keys byte by byte.
   *
   * Before the first operation on a collection, not at construction, which does no I/O, and not only in
   * `ensureIndexes`, which callers may never call. No lock: the check is a read, so two racing first
   * operations each send one `listCollections` and reach the same answer.
   *
   * Only a verified collection is cached, on the connection so a namespace shares it. A refusal is not
   * cached, so a collection fixed while the process runs starts working, and neither is an absent
   * collection, which whoever creates it may give any collation. The check repeats until this store's first
   * write creates it.
   */
  async #requireBinaryKeys(): Promise<void> {
    const { connection, db, untyped } = this.#resolve()
    if (connection.binaryKeys.has(this.#target)) return
    if (await requireBinaryComparison(db, untyped)) connection.binaryKeys.add(this.#target)
  }

  /** The pipeline `search` sends, built from an already-tokenized query. */
  #searchPipeline(tokens: ReadonlySet<string>): Document[] {
    const stages: Document[] = []
    // Bounded by the instance prefix, not the query, which is prose. A covered scan of `_id_` rather than a
    // collection scan.
    const range = rangeFor(this.#prefix, '')
    if (range._id !== undefined) stages.push({ $match: range })
    // Score the key the caller wrote, without the prefix. `$substrCP` counts code points, so the prefix is
    // measured in code points too, not in UTF-16 units as `length` would.
    const key: unknown =
      this.#prefix === '' ? '$_id' : { $substrCP: ['$_id', Array.from(this.#prefix).length, { $strLenCP: '$_id' }] }
    stages.push({
      $project: {
        score: {
          $size: {
            $setIntersection: [
              {
                $map: {
                  input: { $regexFindAll: { input: { $toLower: key }, regex: TOKEN_PATTERN } },
                  in: '$$this.match',
                },
              },
              // Sorted so one question always produces one plan-cache shape.
              [...tokens].sort(),
            ],
          },
        },
      },
    })
    stages.push({ $match: { score: { $gt: 0 } } })
    // A blocking sort, unavoidably, since `score` is computed. `_id` breaks ties, as the SDK's stable sort
    // over an already-sorted listing does.
    stages.push({ $sort: { score: -1, _id: 1 } })
    return stages
  }

  /**
   * The client, database and collection for this operation, resolved each time so `close()` is final. The
   * collection comes twice: typed for the data calls, and untyped for the index and collation helpers,
   * which serve both stores.
   */
  #resolve(): { connection: Connection; db: Db; collection: Collection<StoredDocument>; untyped: Collection } {
    const connection = resolve(this.#config, 'MongoDBStorage')
    const db = connection.client.db(this.#database)
    return {
      connection,
      db,
      collection: db.collection<StoredDocument>(this.#collection),
      untyped: db.collection(this.#collection),
    }
  }

  /** `<database>.<collection>`, for messages and the collation cache. */
  get #target(): string {
    return `${this.#database}.${this.#collection}`
  }

  /** What every storage span names. */
  get #spanTarget(): { database: string; collection: string } {
    return { database: this.#database, collection: this.#collection }
  }
}

/** An error's message, or its string form when something other than an `Error` was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
