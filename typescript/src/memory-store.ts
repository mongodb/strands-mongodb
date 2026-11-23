/**
 * `MongoDBMemoryStore`: the SDK's `MemoryStore` over one MongoDB collection, one document per memory.
 *
 * Ported from `python/src/strands_mongodb/memory_store.py`, and writing the same documents: a memory written
 * by either package is found, deduplicated and deleted by the other. Every read is an Atlas Search pipeline
 * from `src/pipeline.ts`, answered by the first prepared tier, in preference order, that fits the query.
 *
 * Four differences from Python, each for a reason the code states where it happens:
 *
 * - Messages start `MongoDBMemoryStore:` rather than `strands_mongodb:`, as `src/errors.ts` explains, and
 *   name config keys in camelCase. The index messages, from the shared lifecycle module, keep Python's prefix.
 * - Error classes follow the TypeScript convention the other modules use: a limit below 1 is a `RangeError`,
 *   a query with both or neither vector key a `TypeError`, and the rest of Python's `ValueError`s an `Error`.
 * - The setup lock is a promise chain on the connection rather than a per-event-loop `asyncio.Lock`, since
 *   Node has one loop. Waiting for the first ready tier uses `Promise.any`, and nothing is cancelled: a
 *   promise cannot be, so the slower waits run on to their own timeout and their results are dropped.
 * - Retry times are read from `performance.now()`, Node's monotonic clock, in milliseconds.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto'

import { StorageError } from '@strands-agents/sdk'
import type { JSONValue, MemoryEntry, MemoryStore, SearchOptions, Tool } from '@strands-agents/sdk'
import type { ExtractionConfig } from '@strands-agents/sdk'
import { MongoServerError, ObjectId } from 'mongodb'
import type { Collection, Db, Document, Double } from 'mongodb'

import { close, exclusive, resolve, type Capabilities, type Connection } from './client.js'
import { reportingMemory, type MemoryVerb } from './errors.js'
import { compose, validate } from './filter.js'
import {
  embed,
  ensure,
  rankFusionSupport,
  requireBinaryComparison,
  SearchIndexNotReady,
  searchSupport,
  type TextEmbedder,
} from './index-lifecycle.js'
import {
  checkTtl,
  declaredFilterFields,
  memorySearchSpecs,
  memorySpecs,
  repr,
  type SearchIndexSpec,
  vectorMode,
  type VectorMode,
} from './indexes.js'
import { checkQueryKeys, hybridStages, textStages, vectorStages } from './pipeline.js'
import { annotate, logger, eventFields, traced, type Operations } from './telemetry.js'
import type { MongoDBAddResult, MongoDBConfig, MongoDBMemoryStoreConfig, MongoDBSearchQuery } from './types.js'
import type { ResolvedSearchType, SearchType } from './types.js'
import {
  CONTENT_FIELD,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MEMORY_COLLECTION,
  DEFAULT_OVERSAMPLING_FACTOR,
  EXPIRES_FIELD,
  READY_TIMEOUT_MS,
  SCORE_FIELD,
  TIER_RETRY_MAX_MS,
  TIER_RETRY_MS,
  UNSCOPED,
  VECTOR_FIELD,
} from './types.js'

// ---------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------

/**
 * The warning for a deployment that does not run Atlas Search.
 *
 * A warning rather than a throw, because writes still work and a store that only writes is a valid use.
 *
 * @param target - The namespace.
 * @param code - The server error code the probe saw.
 * @returns The message.
 */
const NO_SEARCH_SETUP = (target: string, code: number | undefined): string =>
  `MongoDBMemoryStore: ${target} is on a deployment that does not run Atlas Search, so no search index was ` +
  'created and no query can be answered here. The server reported error code ' +
  `${code === undefined ? 'None' : code} when asked to list its search indexes. Ordinary indexes and writes ` +
  "are unaffected, so this store can hold memories and cannot read them back. Point 'connectionString' at " +
  "MongoDB Atlas, or at a local Atlas deployment started with 'atlas deployments setup --type local', which " +
  'runs the same search process.'

/**
 * The error for a search on a deployment that cannot answer one.
 *
 * @param target - The namespace.
 * @param evidence - What the capability probe came back with.
 * @returns The message.
 */
const NO_SEARCH_QUERY = (target: string, evidence: string): string =>
  `MongoDBMemoryStore: cannot search ${target} because this deployment does not run Atlas Search. Its ` +
  `capability probe came back with ${evidence}, and this package has no tier that answers without a search ` +
  'process, so there is nothing to fall back to. Writes still work, which is why initialize() only warned. ' +
  "Point 'connectionString' at MongoDB Atlas, or at a local Atlas deployment started with 'atlas deployments " +
  "setup --type local'."

/**
 * The record for a tier skipped under `auto`: a warning when it failed, an info record while it builds.
 *
 * @param tier - The tier skipped.
 * @param target - The namespace.
 * @param reason - The server's own reason, from the lifecycle module's error.
 * @returns The message.
 */
const TIER_UNAVAILABLE = (tier: string, target: string, reason: string): string =>
  `MongoDBMemoryStore: the ${tier} search tier is not available on ${target} and 'searchType' is 'auto', so ` +
  "it is skipped rather than fatal and any remaining tier answers queries instead. The '_search_type' key on " +
  `every returned entry reports which one did. The server's own reason: ${reason}`

/**
 * The error when every tier failed under `auto`. The last failure is the `cause`.
 *
 * @param target - The namespace.
 * @returns The message.
 */
const NO_TIER_PREPARED = (target: string): string =>
  `MongoDBMemoryStore: 'searchType' is 'auto' and no search tier could be prepared on ${target}, so no query ` +
  "can be answered. The last tier's failure is chained to this one and every tier's is logged above, each " +
  "with the server's own reason."

/**
 * The error for a search while every tier is still building.
 *
 * @param target - The namespace.
 * @returns The message.
 */
const NO_TIER_READY = (target: string): string =>
  `MongoDBMemoryStore: 'searchType' is 'auto' and no search tier on ${target} was ready within ` +
  "'indexReadyTimeoutMs', so no query can be answered yet. Each tier's status is logged above. The tiers are " +
  'retried with backoff, and searches throw until one is ready.'

/**
 * The error for an `embedder` on the AutoEmbeddings path, where it would never be called.
 *
 * @returns The message.
 */
const EMBEDDER_ON_AUTO_EMBED = (): string =>
  "MongoDBMemoryStore: 'embedder' is set, but this store is on the Atlas AutoEmbeddings path, where the " +
  "deployment embeds the text. Remove 'embedder', or set 'embeddingDimensions' and 'similarity' in the " +
  'connection config to embed client-side.'

/**
 * The warning, once per store, when `auto` resolves below the vector tier.
 *
 * @param target - The namespace.
 * @param tier - The tier queries resolve to instead.
 * @returns The message.
 */
const BELOW_VECTOR = (target: string, tier: string): string =>
  `MongoDBMemoryStore: 'searchType' is 'auto' and the vector tier is not available on ${target}, so queries ` +
  `resolve to the ${tier} tier. Answers are lexical rather than semantic, which is a difference in what ` +
  'matches rather than only in ranking.'

/**
 * The error for `searchType: 'hybrid'` on a deployment without `$rankFusion`.
 *
 * @param target - The namespace.
 * @returns The message.
 */
const NO_FUSION = (target: string): string =>
  `MongoDBMemoryStore: 'searchType' is 'hybrid' but ${target} cannot run it. The hybrid tier is a ` +
  '$rankFusion over the vector and text pipelines, and that stage needs MongoDB 8.0 or later. Upgrade the ' +
  "deployment, or set 'searchType' to 'auto' to let this store resolve to the tiers it does have."

/**
 * The warning when a score bound keeps `auto` off the hybrid tier.
 *
 * @param target - The namespace.
 * @param bound - `minScore` or `maxScore`.
 * @param value - Its value.
 * @returns The message.
 */
const BOUND_DECLINED_FUSION = (target: string, bound: string, value: number): string =>
  `MongoDBMemoryStore: 'searchType' is 'auto' and ${target} can run the hybrid tier, but '${bound}' is set to ` +
  `${value} and the two are on different scales, so queries resolve to the vector tier as they did before ` +
  'hybrid existed. Reciprocal rank fusion scores sum to about 0.033 at best, while cosine scores land in ' +
  "roughly 0 to 1. Remove the bound to get fused ranking, or set 'searchType' to 'hybrid' to keep the bound " +
  "and have it applied on the fusion's scale."

/**
 * The error for a query with both keys where no hybrid tier is prepared.
 *
 * @param target - The namespace.
 * @param tiers - The prepared tiers, comma-joined, or `none`.
 * @returns The message.
 */
const NO_FUSION_FOR_QUERY = (target: string, tiers: string): string =>
  "MongoDBMemoryStore: this query sets both 'text' and 'vector', which only the hybrid tier reads, and the " +
  `hybrid tier is not available on ${target}. The tiers that are: ${tiers}. Drop one of the two keys to use ` +
  'one of them, or see the initialization log for why the fused tier was not offered.'

/**
 * The error for a query no prepared tier fits.
 *
 * @param target - The namespace.
 * @param tiers - The prepared tiers, comma-joined.
 * @param needed - The key the vector tier needs, quoted.
 * @param because - Why it needs that key.
 * @returns The message.
 */
const NO_TIER_FOR_QUERY = (target: string, tiers: string, needed: string, because: string): string =>
  `MongoDBMemoryStore: this query cannot be answered by any search tier prepared on ${target}, which is: ` +
  `${tiers}. The text tier needs 'text' on the query. The vector tier needs ${needed}, because ${because}. ` +
  "Supply that key, or set 'searchType' to a tier this query fits."

/**
 * The error for a write on a read-only store.
 *
 * @param name - The store's name.
 * @param call - The method refused.
 * @returns The message.
 */
const NOT_WRITABLE = (name: string, call: string): string =>
  `MongoDBMemoryStore: the memory store ${repr(name)} is not writable, so it does not accept ${call}. Set ` +
  "'writable': true in its configuration to enable writes. It defaults to false so that a store built for " +
  'retrieval does not start accepting model-distilled extraction writes, or deletions, that nobody asked for.'

/**
 * The error for a `memoryId` that is not a 24-character hex ObjectId.
 *
 * @param memoryId - What was passed.
 * @returns The message.
 */
const BAD_MEMORY_ID = (memoryId: unknown): string =>
  `MongoDBMemoryStore: 'memoryId' is ${repr(memoryId)}, which is not a 24-character hex ObjectId. Pass the ` +
  "'_id' a search result carries in its metadata, which is where a deletable id comes from."

/**
 * The error for a limit below 1.
 *
 * @param name - `limit` or `maxSearchResults`.
 * @param value - The value.
 * @returns The message.
 */
const LIMIT_TOO_LOW = (name: string, value: number): string =>
  `MongoDBMemoryStore: ${repr(name)} is ${value}, and a search limit must be at least 1. A limit below 1 ` +
  'cannot return anything, so it is rejected here rather than sent to a server that would reject it.'

/**
 * The error for both score bounds at once.
 *
 * @param minScore - The floor.
 * @param maxScore - The ceiling.
 * @returns The message.
 */
const BOTH_SCORE_BOUNDS = (minScore: number, maxScore: number): string =>
  `MongoDBMemoryStore: 'minScore' is ${minScore} and 'maxScore' is ${maxScore}, and the two are mutually ` +
  'exclusive: a floor and a ceiling on one similarity score describe a band, and this package applies one ' +
  'bound rather than a range. Keep whichever one you meant and remove the other.'

/**
 * The warning for stored metadata keys that a reserved key overwrote on the way out.
 *
 * @param keys - The colliding keys, quoted and comma-joined.
 * @param name - The store's name.
 * @returns The message.
 */
const RESERVED_KEY_COLLISION = (keys: string, name: string): string =>
  `MongoDBMemoryStore: metadata key(s) ${keys} on a document in the memory store ${repr(name)} collide with ` +
  'the keys this package sets on every result, so the stored value(s) were dropped from the returned entry and ' +
  "this package's own value(s) kept. Rename them in whatever wrote them; a stored '_scope' that won would make " +
  'a document report a scope it was not stored in.'

/**
 * The debug record for a score bound that dropped results.
 *
 * @param name - `minScore` or `maxScore`.
 * @param bound - Its value.
 * @param target - The namespace.
 * @param kept - How many results survived.
 * @param total - How many the query returned.
 * @returns The message.
 */
const SCORE_BOUND_APPLIED = (name: string, bound: number, target: string, kept: number, total: number): string =>
  `MongoDBMemoryStore: ${name} ${bound} on ${target} kept ${kept} of ${total} results (applied after the query).`

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** A 24-character hex string, the only text an `ObjectId` is built from here. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/

/**
 * The search limit: the query's, else the options', else the store's, else ten.
 *
 * @param links - Each link of the chain, any of which may be absent.
 * @returns The limit.
 * @throws RangeError when any supplied link is below 1, naming it.
 */
function resolveLimit(links: {
  query?: number | undefined
  options?: number | undefined
  instance?: number | undefined
}): number {
  const named: [string, number | undefined][] = [
    ['limit', links.query],
    ['maxSearchResults', links.options],
    ['maxSearchResults', links.instance],
  ]
  for (const [name, value] of named) {
    if (value !== undefined && value !== null && value < 1) throw new RangeError(LIMIT_TOO_LOW(name, value))
  }
  return links.query ?? links.options ?? links.instance ?? DEFAULT_MAX_SEARCH_RESULTS
}

/**
 * Stored metadata with the reserved keys laid over it, logging any stored key that lost.
 *
 * @param stored - The document's own metadata, if any.
 * @param reserved - The keys this package sets on every result.
 * @param where - The store's name, and its namespace for the record.
 * @returns A new object: the stored keys, then the reserved ones, which win.
 */
function mergeMetadata(
  stored: unknown,
  reserved: Record<string, JSONValue>,
  where: { storeName: string; namespace?: string | undefined },
): Record<string, JSONValue> {
  const merged: Record<string, JSONValue> =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...(stored as Record<string, JSONValue>) }
      : {}
  const collisions = Object.keys(reserved)
    .filter((key) => Object.hasOwn(merged, key))
    .sort()
  if (collisions.length > 0) {
    logger.warn(
      eventFields('reserved_key_collision', where.namespace === undefined ? {} : { namespace: where.namespace }),
      RESERVED_KEY_COLLISION(collisions.map((key) => repr(key)).join(', '), where.storeName),
    )
  }
  return Object.assign(merged, reserved)
}

/** The SHA-256 of `content`'s UTF-8 bytes, in lowercase hex: the dedup key, as Python computes it. */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** An error's message, or its string form. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------------------
// The test seam
// ---------------------------------------------------------------------------------------------------------

/** A store's setup state, as tests read it. */
export interface MemoryState {
  readonly initialized: boolean
  readonly tiers: readonly ResolvedSearchType[]
  readonly tierRetryAt: number | null
  readonly tierRetryDelay: number
  readonly waitedForATier: boolean
  readonly capabilities: Capabilities | null
}

/**
 * The store's internals, for the unit tests: Python's tests reach the same state through underscored
 * attributes, and a `#` field cannot be reached from another module. Assigned from a static block inside the
 * class, as `storageCollection` is. Not exported from the entry point.
 */
export const memoryInternals: {
  resolveLimit: typeof resolveLimit
  mergeMetadata: typeof mergeMetadata
  contentHash: typeof contentHash
  /** The store's setup state. */
  state: (store: MongoDBMemoryStore) => MemoryState
  /** Put a store in the state `initialize()` would leave it in, with `tiers` prepared and search available. */
  prepare: (store: MongoDBMemoryStore, tiers: readonly string[]) => void
  /** Move a store's next tier retry, so a test can make one due without waiting. */
  setRetryAt: (store: MongoDBMemoryStore, at: number | null) => void
  /** The tier a query with these keys would run on. */
  pickTier: (
    store: MongoDBMemoryStore,
    queryText: string | undefined,
    queryVector: readonly unknown[] | undefined,
  ) => ResolvedSearchType
  /** The wait the first search makes when no tier is ready. */
  waitForATier: (store: MongoDBMemoryStore) => Promise<void>
} = {
  resolveLimit,
  mergeMetadata,
  contentHash,
  state: unassigned,
  prepare: unassigned,
  setRetryAt: unassigned,
  pickTier: unassigned,
  waitForATier: unassigned,
}

/** The placeholder each accessor holds until the class's static block replaces it. */
function unassigned(): never {
  throw new Error('assigned in MongoDBMemoryStore')
}

// ---------------------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------------------

/**
 * A `MemoryStore` backed by a MongoDB collection and Atlas Search.
 *
 * Every read and write is confined to this store's `scope` and `name`, combined with the configured
 * `filter`. Adding identical content twice in one scope leaves one document. Search answers from the first
 * prepared tier, in preference order, that fits the query: hybrid, then vector, then text.
 *
 * `addMessages` is absent on purpose: the SDK then routes extraction through `add`, where the dedup and
 * scope guarantees live.
 *
 * @example
 * ```ts
 * const memory = new MongoDBMemoryStore({
 *   name: 'facts',
 *   config: { database: 'agents', connectionString: process.env.MONGODB_URI },
 *   scope: userId,
 *   writable: true,
 * })
 * ```
 */
export class MongoDBMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults?: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig
  /** The scope every read and write is confined to. {@link UNSCOPED} when none was configured. */
  readonly scope: string
  /** The filter every read and delete is combined with. */
  readonly filter: Record<string, unknown> | undefined
  readonly minScore: number | undefined
  readonly maxScore: number | undefined
  readonly ttlSeconds: number | undefined

  // Private fields rather than properties, so `inspect` and `JSON.stringify` show nothing of the config,
  // whose connection string may carry a password.
  readonly #config: MongoDBConfig
  readonly #database: string
  readonly #collection: string
  readonly #ensureIndexes: boolean
  readonly #indexReadyTimeoutMs: number
  readonly #searchType: SearchType
  readonly #declaredFields: string[]
  readonly #mode: VectorMode
  readonly #embedder: TextEmbedder | undefined
  readonly #specs: readonly [ResolvedSearchType, SearchIndexSpec][]
  readonly #indexNames: Partial<Record<ResolvedSearchType, string>>
  readonly #fusionPossible: boolean

  #initialized = false
  #tiers: ResolvedSearchType[] = []
  #warnedBelowVector = false
  #tierRetryAt: number | null = null
  #tierRetryDelay = TIER_RETRY_MS
  #waitedForATier = false
  #tierWait: Promise<void> | undefined
  #capabilities: Capabilities | null = null

  static {
    memoryInternals.state = (store) => ({
      initialized: store.#initialized,
      tiers: [...store.#tiers],
      tierRetryAt: store.#tierRetryAt,
      tierRetryDelay: store.#tierRetryDelay,
      waitedForATier: store.#waitedForATier,
      capabilities: store.#capabilities,
    })
    memoryInternals.prepare = (store, tiers) => {
      store.#initialized = true
      store.#tiers = [...tiers] as ResolvedSearchType[]
      store.#capabilities = { search: true, rankFusion: tiers.includes('hybrid') }
    }
    memoryInternals.setRetryAt = (store, at) => {
      store.#tierRetryAt = at
    }
    memoryInternals.pickTier = (store, queryText, queryVector) => store.#pickTier(queryText, queryVector)
    memoryInternals.waitForATier = (store) => store.#waitForATier()
  }

  /**
   * Build a store. Every check runs here, before the connection is registered, and nothing touches the
   * network until the first call.
   *
   * @param config - The store's config, with the connection half under `config`.
   * @throws RangeError when `maxSearchResults` is below 1, `ttlSeconds` is out of range, or a vector key is.
   * @throws TypeError when the configured filter has an operator key or is not a document, or the connection
   *   config names neither a client nor a connection string.
   * @throws Error when both score bounds are set, the filter names an undeclared field, an `embedder` is set
   *   on the AutoEmbeddings path, or the vector keys conflict.
   */
  constructor(config: MongoDBMemoryStoreConfig) {
    const connection = config.config
    this.name = config.name
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    this.writable = config.writable ?? false
    if (config.extraction !== undefined) this.extraction = config.extraction
    this.scope = config.scope || UNSCOPED
    this.filter = config.filter
    this.minScore = config.minScore
    this.maxScore = config.maxScore
    this.ttlSeconds = config.ttlSeconds
    checkTtl(this.ttlSeconds)
    resolveLimit({ instance: this.maxSearchResults })
    if (this.minScore !== undefined && this.maxScore !== undefined) {
      throw new Error(BOTH_SCORE_BOUNDS(this.minScore, this.maxScore))
    }
    this.#config = connection
    this.#database = connection.database
    this.#collection = config.collection ?? DEFAULT_MEMORY_COLLECTION
    this.#ensureIndexes = connection.ensureIndexes ?? true
    this.#indexReadyTimeoutMs = connection.indexReadyTimeoutMs ?? READY_TIMEOUT_MS
    this.#searchType = connection.searchType || 'auto'
    this.#declaredFields = declaredFilterFields(connection.filterFields ?? [])
    if (this.filter) validate(this.filter, { declaredFields: this.#declaredFields })
    this.#mode = vectorMode(connection)
    this.#embedder = config.embedder
    if (this.#embedder !== undefined && this.#mode.autoEmbed) throw new Error(EMBEDDER_ON_AUTO_EMBED())
    const [vectorSpec, textSpec] = memorySearchSpecs(connection)
    const specs: [ResolvedSearchType, SearchIndexSpec][] = [
      ['vector', vectorSpec],
      ['text', textSpec],
    ]
    this.#specs =
      this.#searchType === 'auto' || this.#searchType === 'hybrid'
        ? specs
        : specs.filter(([tier]) => tier === this.#searchType)
    this.#indexNames = Object.fromEntries(this.#specs.map(([tier, spec]) => [tier, spec.name]))
    this.#fusionPossible = !this.#mode.autoEmbed && (this.#searchType === 'auto' || this.#searchType === 'hybrid')
    resolve(connection, 'MongoDBMemoryStore')
  }

  /**
   * Prepare the collection: the collation check, the capability probe, the ordinary indexes and the search
   * tiers. Idempotent, and run by the first call that needs it; concurrent callers share one run per
   * deployment. Under `auto`, a tier still building is retried with backoff on a later call.
   *
   * @throws StorageError when the collection's collation is not binary, an index cannot be prepared, no tier
   *   could be prepared under `auto`, a named tier failed, or a driver call fails.
   */
  async initialize(): Promise<void> {
    if (this.#initialized && !this.#tierRetryDue()) return
    await this.#traced('initialize', 'initializing', () => this.#initialize())
  }

  /**
   * Add a memory, unless identical content is already stored in this scope.
   *
   * @param content - The text to remember.
   * @param metadata - Stored beside it, and returned on every result. Omitted when empty.
   * @returns The id of the document holding the content, and whether it was inserted or already there.
   * @throws Error when the store is not writable, before any round trip.
   * @throws RangeError when an `embedder` returns a vector of the wrong length.
   * @throws StorageError when setup or a driver call fails.
   */
  async add(content: string, metadata?: Record<string, JSONValue>): Promise<MongoDBAddResult> {
    return this.#traced('add', 'adding a memory to', async () => {
      if (!this.writable) throw new Error(NOT_WRITABLE(this.name, 'add()'))
      await this.initialize()
      const vector = this.#embedder !== undefined ? await this.#embed(content) : undefined
      const selector: Document = { scope: this.scope, store_name: this.name, content_hash: contentHash(content) }
      const createdAt = new Date()
      const insert: Document = { [CONTENT_FIELD]: content, created_at: createdAt }
      if (metadata !== undefined && metadata !== null && Object.keys(metadata).length > 0) {
        insert.metadata = { ...metadata }
      }
      if (vector !== undefined) insert[VECTOR_FIELD] = vector
      if (this.ttlSeconds !== undefined) {
        insert[EXPIRES_FIELD] = new Date(createdAt.getTime() + this.ttlSeconds * 1000)
      }
      const collection = this.#resolve().collection
      let upsertedId: unknown
      try {
        const result = await collection.updateOne(selector, { $setOnInsert: insert }, { upsert: true })
        upsertedId = result.upsertedId
      } catch (error) {
        // A writer racing on the same content inserted first. The unique index made that one document.
        if (error instanceof MongoServerError && error.code === 11000) return this.#existing(collection, selector)
        throw error
      }
      if (upsertedId === null || upsertedId === undefined) return this.#existing(collection, selector)
      annotate('strands_mongodb.duplicate', false)
      return { ids: [String(upsertedId)], inserted: 1, duplicates: 0 }
    })
  }

  /**
   * Return the memories that best match a query, most relevant first.
   *
   * Results are always confined to this store's scope and name, combined with the configured and per-query
   * filters; nothing in the query can change the scope. A configured `minScore` or `maxScore` is applied
   * after the query. Input errors are thrown before any network call.
   *
   * @param query - A natural-language string, or a {@link MongoDBSearchQuery}. Never modified.
   * @param options - The SDK's per-call options. Only `maxSearchResults` is read, and a query's `limit` wins.
   * @returns Up to the resolved limit of entries. Each entry's metadata holds what was stored plus the
   *   reserved keys `_id`, `_relevance_score`, `_search_type` and `_scope`, which win over stored keys.
   * @throws RangeError when the limit is below 1, or `oversamplingFactor` is out of range.
   * @throws TypeError when the query sets neither `text` nor `vector` (or both, where no hybrid tier could
   *   answer), or the filter has an operator key or a regex value.
   * @throws Error when the filter names an undeclared field, or no prepared tier fits the query's keys.
   * @throws StorageError when the deployment cannot search, no tier is ready, setup fails, or a driver call
   *   fails.
   */
  async search(query: string | MongoDBSearchQuery, options?: SearchOptions): Promise<MemoryEntry[]> {
    return this.#traced('search', 'searching', async () => {
      annotate('strands_mongodb.search.requested', this.#searchType)
      const parts: MongoDBSearchQuery = typeof query === 'string' ? { text: query } : query
      let queryText = parts.text
      let queryVector: readonly unknown[] | undefined = parts.vector
      const callerFilter = parts.filter
      const limit = resolveLimit({
        query: parts.limit,
        options: options?.maxSearchResults,
        instance: this.maxSearchResults,
      })
      checkQueryKeys({ queryText, queryVector, fusionPossible: this.#fusionPossible })
      if (callerFilter) validate(callerFilter, { declaredFields: this.#declaredFields })
      const queryFilter = compose({ scope: this.scope, storeName: this.name }, this.filter, callerFilter)
      await this.initialize()
      if (this.#tiers.length === 0 && this.#canSearch() && !this.#waitedForATier) await this.#waitForATier()
      if (this.#embedsQuery(queryText, queryVector)) {
        queryVector = await this.#embed(queryText as string)
        if (!this.#tiers.includes('hybrid')) queryText = undefined
      }
      const tier = this.#pickTier(queryText, queryVector)
      annotate('strands_mongodb.search.tier', tier)
      const oversamplingFactor = parts.oversamplingFactor ?? DEFAULT_OVERSAMPLING_FACTOR
      const vectorArgument = queryVector as number[] | undefined
      let stages: Document[]
      if (tier === 'hybrid') {
        stages = hybridStages({
          mode: this.#mode,
          vectorIndexName: this.#indexNames.vector as string,
          textIndexName: this.#indexNames.text as string,
          queryText: queryText as string,
          limit,
          queryVector: vectorArgument,
          queryFilter,
          oversamplingFactor,
        })
      } else if (tier === 'vector') {
        stages = vectorStages({
          mode: this.#mode,
          indexName: this.#indexNames.vector as string,
          limit,
          queryText,
          queryVector: vectorArgument,
          queryFilter,
          oversamplingFactor,
        })
      } else {
        stages = textStages({
          queryText: queryText as string,
          indexName: this.#indexNames.text as string,
          limit,
          queryFilter,
        })
      }
      const scored: [number, MemoryEntry][] = []
      for await (const document of this.#resolve().collection.aggregate(stages)) {
        const score = Number(document[SCORE_FIELD] ?? 0) || 0
        const entry: MemoryEntry = {
          content: String(document[CONTENT_FIELD] ?? ''),
          storeName: this.name,
          metadata: mergeMetadata(
            document.metadata,
            { _id: String(document._id), _relevance_score: score, _search_type: tier, _scope: this.scope },
            { storeName: this.name, namespace: this.#target },
          ),
        }
        scored.push([score, entry])
      }
      const results = this.#withinBounds(scored)
      annotate('strands_mongodb.result_count', results.length)
      return results
    })
  }

  /**
   * Delete one memory this store can see, by the `_id` a search result carries in its metadata.
   *
   * @param memoryId - The 24-character hex id.
   * @returns How many documents the server deleted: 1, or 0 when the id is absent or outside this scope.
   * @throws Error when the store is not writable, or `memoryId` is not a hex ObjectId, before any round trip.
   * @throws StorageError when setup or the driver call fails.
   */
  async delete(memoryId: string): Promise<number> {
    return this.#traced('delete', 'deleting a memory from', async () => {
      if (!this.writable) throw new Error(NOT_WRITABLE(this.name, 'delete()'))
      if (typeof memoryId !== 'string' || !OBJECT_ID.test(memoryId)) throw new Error(BAD_MEMORY_ID(memoryId))
      const id = new ObjectId(memoryId)
      await this.initialize()
      const predicate = compose({ scope: this.scope, storeName: this.name }, this.filter)
      const result = await this.#resolve().collection.deleteOne({ ...predicate, _id: id })
      annotate('strands_mongodb.deleted_count', result.deletedCount)
      return result.deletedCount
    })
  }

  /**
   * Delete every memory this store can see: its scope and name, combined with the configured filter.
   *
   * @returns How many documents the server deleted.
   * @throws Error when the store is not writable, before any round trip.
   * @throws StorageError when setup or the driver call fails.
   */
  async deleteAll(): Promise<number> {
    return this.#traced('delete_all', 'deleting every memory in', async () => {
      if (!this.writable) throw new Error(NOT_WRITABLE(this.name, 'deleteAll()'))
      await this.initialize()
      const predicate = compose({ scope: this.scope, storeName: this.name }, this.filter)
      const result = await this.#resolve().collection.deleteMany(predicate)
      annotate('strands_mongodb.deleted_count', result.deletedCount)
      return result.deletedCount
    })
  }

  /**
   * The store's own tools: none. Present, so the SDK's probe finds it, and empty.
   *
   * @returns An empty array.
   */
  getTools(): Tool[] {
    return []
  }

  /** Release this store's connection, closing the client only if this package built it. */
  async close(): Promise<void> {
    await close(this.#config)
  }

  /** {@link close}, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  // -------------------------------------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------------------------------------

  /** Whether a retry of the missing tiers is due. */
  #tierRetryDue(): boolean {
    return this.#tierRetryAt !== null && performance.now() >= this.#tierRetryAt
  }

  /** The body of {@link initialize}, under the connection's setup lock. */
  async #initialize(): Promise<void> {
    annotate('strands_mongodb.search.requested', this.#searchType)
    const { connection, db, collection } = this.#resolve()
    await exclusive(connection, async () => {
      if (this.#initialized) {
        if (this.#tierRetryDue()) await this.#retrySearchTiers()
        return
      }
      const target = this.#target
      let verified = connection.binaryKeys.has(target)
      if (!verified) {
        verified = await requireBinaryComparison(db, collection)
        if (verified) connection.binaryKeys.add(target)
      }
      let capabilities = connection.capabilities
      if (capabilities === undefined) {
        const support = await searchSupport(collection)
        const fusion = support.available ? await rankFusionSupport(db, collection) : false
        const probed: Capabilities =
          support.code === undefined
            ? { search: support.available, rankFusion: fusion }
            : { search: support.available, noSearchCode: support.code, rankFusion: fusion }
        connection.capabilities = probed
        capabilities = probed
        if (!capabilities.search) {
          logger.warn(eventFields('no_search_setup', { namespace: target }), NO_SEARCH_SETUP(target, support.code))
        }
      }
      await ensure(db, collection, {
        ordinary: memorySpecs(),
        create: this.#ensureIndexes,
        timeoutMs: this.#indexReadyTimeoutMs,
      })
      this.#capabilities = capabilities
      const timeoutMs = this.#searchType === 'auto' ? 0 : this.#indexReadyTimeoutMs
      this.#tiers = capabilities.search ? await this.#ensureSearchTiers(capabilities.rankFusion, timeoutMs) : []
      if (capabilities.search && this.#missingATier(this.#tiers)) {
        this.#tierRetryAt = performance.now() + this.#tierRetryDelay
      }
      // An absent collection reads as unverified; the ordinary indexes have created it, so read it again.
      if (!verified && (await requireBinaryComparison(db, collection))) connection.binaryKeys.add(target)
      annotate('strands_mongodb.search.tiers', this.#tiers.join(','))
      this.#initialized = true
    })
  }

  /**
   * Read the tiers again without waiting, backing off while any is still missing.
   *
   * @param waited - True when {@link waitForATier} already waited the configured budget, so a tier still
   *   building is reported as a warning rather than as progress.
   */
  async #retrySearchTiers(waited = false): Promise<void> {
    const fusion = this.#capabilities?.rankFusion ?? false
    let tiers: ResolvedSearchType[] | null
    try {
      tiers = await this.#ensureSearchTiers(fusion, 0, waited)
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
      tiers = null
    }
    if (tiers !== null) this.#tiers = tiers
    if (tiers === null || this.#missingATier(tiers)) {
      this.#tierRetryDelay = Math.min(this.#tierRetryDelay * 2, TIER_RETRY_MAX_MS)
      this.#tierRetryAt = performance.now() + this.#tierRetryDelay
    } else {
      this.#tierRetryAt = null
    }
    annotate('strands_mongodb.search.tiers', this.#tiers.join(','))
  }

  /** Whether the deployment runs Atlas Search, as far as this store has seen. */
  #canSearch(): boolean {
    return this.#capabilities?.search ?? false
  }

  /** Wait, once per store, for the first tier to become ready. Concurrent searches share the one wait. */
  async #waitForATier(): Promise<void> {
    this.#tierWait ??= this.#waitForTheFirstReadyTier().finally(() => {
      this.#tierWait = undefined
    })
    await this.#tierWait
  }

  /** Wait on every tier at once, up to the configured budget, and stop at the first that is ready. */
  async #waitForTheFirstReadyTier(): Promise<void> {
    const { db, collection } = this.#resolve()
    const waits = this.#specs.map(([, spec]) =>
      ensure(db, collection, { search: [spec], create: this.#ensureIndexes, timeoutMs: this.#indexReadyTimeoutMs }),
    )
    // The waits that lose run on to their own timeout. Their rejections are handled here, so none surfaces.
    for (const wait of waits) wait.catch(() => undefined)
    let ready: boolean
    try {
      await Promise.any(waits)
      ready = true
    } catch (error) {
      const failures = error instanceof AggregateError ? error.errors : [error]
      const unexpected = failures.find((failure) => !(failure instanceof StorageError))
      if (unexpected !== undefined) throw unexpected
      ready = false
    }
    await this.#retrySearchTiers(!ready)
    this.#waitedForATier = true
  }

  /** Whether `auto` is still missing a tier it could have. */
  #missingATier(tiers: readonly ResolvedSearchType[]): boolean {
    return this.#searchType === 'auto' && this.#specs.some(([tier]) => !tiers.includes(tier))
  }

  /**
   * Prepare each search tier, in preference order. Under `auto` a tier that fails is skipped and logged;
   * under a named tier it throws.
   *
   * @param rankFusion - Whether the deployment runs `$rankFusion`.
   * @param timeoutMs - How long to wait for a build. 0 under `auto`, which reads status and returns.
   * @param waited - Whether the configured budget was already spent waiting.
   * @returns The available tiers, hybrid first when it is available.
   * @throws StorageError when a named tier fails, no tier could be prepared, or hybrid was asked for and
   *   cannot run.
   */
  async #ensureSearchTiers(rankFusion: boolean, timeoutMs: number, waited = false): Promise<ResolvedSearchType[]> {
    const { db, collection } = this.#resolve()
    const available: ResolvedSearchType[] = []
    let refused: StorageError | undefined
    let building = false
    for (const [tier, spec] of this.#specs) {
      try {
        await ensure(db, collection, { search: [spec], create: this.#ensureIndexes, timeoutMs })
      } catch (error) {
        if (!(error instanceof StorageError) || this.#searchType !== 'auto') throw error
        this.#logSkippedTier(tier, error, timeoutMs === 0 && !waited)
        refused = error
        building ||= error instanceof SearchIndexNotReady
        continue
      }
      available.push(tier)
    }
    if (available.length === 0 && building) return []
    if (available.length === 0) throw new StorageError(NO_TIER_PREPARED(this.#target), { cause: refused })
    if (this.#hybridIsAvailable(available, rankFusion)) {
      if (this.#searchType === 'hybrid') return ['hybrid']
      available.unshift('hybrid')
    } else if (this.#searchType === 'hybrid') {
      throw new StorageError(NO_FUSION(this.#target))
    }
    const first = available[0] as ResolvedSearchType
    if (this.#searchType === 'auto' && first !== 'hybrid' && first !== 'vector' && !this.#warnedBelowVector) {
      this.#warnedBelowVector = true
      logger.warn(
        eventFields('below_vector', { namespace: this.#target, tier: first }),
        BELOW_VECTOR(this.#target, first),
      )
    }
    return available
  }

  /** Log a skipped tier: progress while it builds on a non-waiting read, a warning otherwise. */
  #logSkippedTier(tier: ResolvedSearchType, error: StorageError, building: boolean): void {
    const message = TIER_UNAVAILABLE(tier, this.#target, messageOf(error))
    if (building && error instanceof SearchIndexNotReady) {
      logger.info(eventFields('tier_building', { namespace: this.#target, tier }), message)
      return
    }
    logger.warn(eventFields('tier_unavailable', { namespace: this.#target, tier }), message)
  }

  /** Whether to offer hybrid: fusion runs, both tiers are ready, and no score bound is on the wrong scale. */
  #hybridIsAvailable(available: readonly ResolvedSearchType[], rankFusion: boolean): boolean {
    if (!rankFusion || !available.includes('vector') || !available.includes('text')) return false
    const bound: ['minScore' | 'maxScore', number] | undefined =
      this.minScore !== undefined
        ? ['minScore', this.minScore]
        : this.maxScore !== undefined
          ? ['maxScore', this.maxScore]
          : undefined
    if (bound === undefined || this.#searchType === 'hybrid') return true
    logger.warn(
      eventFields('bound_declined_fusion', { namespace: this.#target, tier: 'hybrid' }),
      BOUND_DECLINED_FUSION(this.#target, bound[0], bound[1]),
    )
    return false
  }

  // -------------------------------------------------------------------------------------------------------
  // Search helpers
  // -------------------------------------------------------------------------------------------------------

  /** Whether `search` should embed the text: an embedder, no caller vector, and a tier to use it. */
  #embedsQuery(queryText: string | undefined, queryVector: readonly unknown[] | undefined): boolean {
    if (this.#embedder === undefined || queryText === undefined || queryVector !== undefined) return false
    const first = this.#tiers[0]
    return first === 'hybrid' || first === 'vector'
  }

  /** Embed `text` with the configured embedder, checking the length against the index. */
  #embed(text: string): Promise<Double[]> {
    return embed(this.#embedder as TextEmbedder, text, this.#mode.dimensions as number, 'embeddingDimensions')
  }

  /**
   * The first prepared tier, in preference order, that fits the query's keys.
   *
   * @throws Error when the query sets both keys and no hybrid tier is prepared, or no tier fits.
   * @throws StorageError when the deployment cannot search, or no tier is ready.
   */
  #pickTier(queryText: string | undefined, queryVector: readonly unknown[] | undefined): ResolvedSearchType {
    if (queryText !== undefined && queryVector !== undefined && !this.#tiers.includes('hybrid')) {
      throw new Error(NO_FUSION_FOR_QUERY(this.#target, this.#tiers.join(', ') || 'none'))
    }
    if (this.#tiers.length === 0) {
      const capabilities = this.#capabilities
      if (capabilities === null || !capabilities.search) {
        const code = capabilities?.noSearchCode
        const evidence = code !== undefined ? `server error code ${code}` : 'no probe result cached'
        throw new StorageError(NO_SEARCH_QUERY(this.#target, evidence))
      }
      throw new StorageError(NO_TIER_READY(this.#target))
    }
    const vectorKey = this.#mode.autoEmbed ? queryText : queryVector
    for (const tier of this.#tiers) {
      if (tier === 'hybrid' && queryText !== undefined && vectorKey !== undefined) return 'hybrid'
      if (tier === 'text' && queryText !== undefined) return 'text'
      if (tier === 'vector' && vectorKey !== undefined) return 'vector'
    }
    const [needed, because] = this.#mode.autoEmbed
      ? ["'text'", 'the deployment embeds it on the Atlas AutoEmbeddings path']
      : ["'vector'", "'embeddingDimensions' and 'similarity' select the manual-vector path"]
    throw new Error(NO_TIER_FOR_QUERY(this.#target, this.#tiers.join(', '), needed, because))
  }

  /** The entries a configured bound keeps, both bounds inclusive, logging when it dropped any. */
  #withinBounds(scored: readonly [number, MemoryEntry][]): MemoryEntry[] {
    let name: 'minScore' | 'maxScore'
    let bound: number
    let kept: MemoryEntry[]
    if (this.minScore !== undefined) {
      name = 'minScore'
      bound = this.minScore
      kept = scored.filter(([score]) => score >= bound).map(([, entry]) => entry)
    } else if (this.maxScore !== undefined) {
      name = 'maxScore'
      bound = this.maxScore
      kept = scored.filter(([score]) => score <= bound).map(([, entry]) => entry)
    } else {
      return scored.map(([, entry]) => entry)
    }
    if (kept.length !== scored.length) {
      logger.debug(
        eventFields('score_bound_applied', { namespace: this.#target }),
        SCORE_BOUND_APPLIED(name, bound, this.#target, kept.length, scored.length),
      )
    }
    return kept
  }

  // -------------------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------------------

  /** The document holding `selector`'s content, which another add stored first. */
  async #existing(collection: Collection, selector: Document): Promise<MongoDBAddResult> {
    const document = await collection.findOne(selector, { projection: { _id: 1 } })
    annotate('strands_mongodb.duplicate', true)
    return { ids: document === null ? [] : [String(document._id)], inserted: 0, duplicates: 1 }
  }

  /** Open the operation's span, and turn a driver error into a `StorageError` naming the namespace. */
  #traced<T>(operation: Operations['memory'], verb: MemoryVerb, body: () => Promise<T>): Promise<T> {
    const target = { database: this.#database, collection: this.#collection, storeName: this.name }
    return traced('memory', operation, target, () => reportingMemory(verb, this.#target, body))
  }

  /** The client, database and collection, resolved per call so `close()` is final. */
  #resolve(): { connection: Connection; db: Db; collection: Collection } {
    const connection = resolve(this.#config, 'MongoDBMemoryStore')
    const db = connection.client.db(this.#database)
    return { connection, db, collection: db.collection(this.#collection) }
  }

  /** `<database>.<collection>`, for messages and the collation cache. */
  get #target(): string {
    return `${this.#database}.${this.#collection}`
  }
}
