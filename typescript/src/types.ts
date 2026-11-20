/**
 * Configuration, query and result types for the MongoDB backends, and the constants other modules share.
 *
 * The shapes follow the SDK's `BedrockKnowledgeBaseStore`: one options object extending `MemoryStoreConfig`, the
 * connection settings nested under `config`, the client injected through that config, and an `add` result as
 * a plain object. Config keys are camelCase; the fields written to MongoDB stay snake_case, so a TypeScript
 * store and a Python store can share a collection. This module mirrors `types.py`, plus the constants of
 * `storage.py`, `memory_store.py`, `_indexes.py` and `_pipeline.py` that the on-disk contract fixes.
 *
 * @packageDocumentation
 */
import type { MemoryStoreConfig } from '@strands-agents/sdk'
import type { Embedder, SearchStrategy } from '@strands-agents/sdk/storage/search'
import type { MongoClient, MongoClientOptions } from 'mongodb'

/**
 * Search tiers a caller may ask for.
 *
 * `'auto'` picks the best tier the deployment supports. `'hybrid'` runs one `$rankFusion` over the vector and
 * text pipelines and needs both tiers plus MongoDB 8.0 or later. Under `'auto'`, hybrid is preferred where
 * available, except when `minScore` or `maxScore` is set, because fused scores are on a different scale.
 */
export type SearchType = 'auto' | 'vector' | 'text' | 'hybrid'

/**
 * Distance metrics an Atlas vector index accepts, for the manual-vector path.
 *
 * The value is also checked at runtime against {@link SIMILARITIES}, for configs built from environment
 * variables or settings files.
 */
export type VectorSimilarity = 'cosine' | 'dotProduct' | 'euclidean'

/**
 * Search tier that answered a query, reported in the `_search_type` metadata key.
 *
 * Separate from {@link SearchType} because `'auto'` can be requested but is never the answer.
 */
export type ResolvedSearchType = Exclude<SearchType, 'auto'>

/**
 * Connection and deployment settings, built once per process and shared across stores.
 *
 * Configs with the same connection identity share one `MongoClient` and its pool, so pass the same config to
 * every store rather than one per store.
 */
export interface MongoDBConfig {
  /** Database holding this deployment's collections. The only required key. */
  database: string
  /** An existing client to use. This package never closes it, not even in `close()`. */
  client?: MongoClient
  /** Used only when `client` is absent. Supplying neither throws. */
  connectionString?: string
  /** Extra options for the client this package constructs. Ignored when `client` is supplied. */
  clientOptions?: MongoClientOptions
  /** Whether `initialize()` creates missing indexes. Defaults to `true`. Verification always runs. */
  ensureIndexes?: boolean
  /**
   * Milliseconds to wait for a search index to report `READY`, timed separately for each search tier.
   * Defaults to {@link READY_TIMEOUT_MS}. Raise it on a shared deployment where index builds queue.
   */
  indexReadyTimeoutMs?: number
  /**
   * Tier to search with. Defaults to `'auto'`, which resolves to the best tier the deployment supports. A named
   * tier that cannot be prepared throws `StorageError` instead.
   */
  searchType?: SearchType
  /**
   * Atlas embedding model for the automated-embedding path. Mutually exclusive with the two manual-vector
   * keys. Setting none of the three selects automated embedding with {@link DEFAULT_EMBEDDING_MODEL}.
   */
  embeddingModel?: string
  /** Length of the vectors stored on the documents, for the manual path. Requires `similarity`. */
  embeddingDimensions?: number
  /**
   * Distance metric for the manual path. No default: the right metric depends on your embeddings, and the wrong
   * one returns plausible but wrong neighbours.
   */
  similarity?: VectorSimilarity
  /**
   * Extra document fields to declare filterable in the vector index. The server rejects a filter on an
   * undeclared path, and adding a field later means recreating the index.
   */
  filterFields?: string[]
  /** Name of the Atlas Vector Search index. Defaults to {@link DEFAULT_VECTOR_INDEX_NAME}. */
  vectorIndexName?: string
  /** Name of the Atlas Search full-text index. Defaults to {@link DEFAULT_TEXT_INDEX_NAME}. */
  textIndexName?: string
}

/**
 * Full configuration for a `MongoDBMemoryStore`.
 *
 * Extends the SDK's `MemoryStoreConfig`, so `name`, `description`, `maxSearchResults`, `writable` and
 * `extraction` are all accepted and `name` stays required. `writable` defaults to `false`.
 */
export interface MongoDBMemoryStoreConfig extends MemoryStoreConfig {
  /** Connection to the deployment. Reuse one across stores that differ only by `scope`. */
  config: MongoDBConfig
  /** Collection holding this store's documents. Defaults to {@link DEFAULT_MEMORY_COLLECTION}. */
  collection?: string
  /**
   * Namespace isolating this store's documents, stamped on every write and filtered on by every read. If absent,
   * {@link UNSCOPED} is used, never "unfiltered".
   */
  scope?: string
  /**
   * Extra predicate, ANDed with the scope predicate on `search`, `delete` and `deleteAll`, so it can only narrow
   * what the store reads or deletes. Validated at construction like a per-query filter.
   */
  filter?: Record<string, unknown>
  /**
   * Floor a result must meet. **Fused scores use a different scale:** the hybrid tier scores by reciprocal
   * rank fusion, `sum(weight / (RANK_FUSION_PENALTY + rank))`, so a document first in both tiers scores about
   * 0.033. Under `'auto'`, setting either bound keeps the store off the hybrid tier.
   */
  minScore?: number
  /** Ceiling a result must not exceed. Mutually exclusive with `minScore`. The same scale note applies. */
  maxScore?: number
  /**
   * How long a memory lives, in seconds from its own `created_at`. Absent means no expiry. `0` means "expire at
   * the next TTL sweep". Set on insert only, so re-adding a fact does not extend its expiry.
   */
  ttlSeconds?: number
  /**
   * Manual-vector path only: embeds memories on `add` and string queries on `search`. Any object with an
   * `embed(text)` method fits, as the SDK's `Embedder` class does.
   */
  embedder?: Embedder
}

/**
 * Per-instance options for a `MongoDBStorage`, the second constructor argument.
 *
 * The same split as the SDK's `S3Storage(bucket, config?)`: the connection first, these second.
 */
export interface MongoDBStorageOptions {
  /** Collection holding the documents. Defaults to {@link DEFAULT_STORAGE_COLLECTION}. */
  collection?: string
  /** Key prefix every key is stored under, normalised to end in exactly one `/`. */
  prefix?: string
  /** How long a written value lives, in seconds from the write. Absent means no expiry. */
  ttlSeconds?: number
  /** What `search` runs instead of the default key-only scan. */
  searchStrategy?: SearchStrategy
}

/**
 * A MongoDB-specific search query, for `MongoDBMemoryStore.search` in place of a plain string.
 *
 * Every key is optional because no type here can express the valid combinations. Set `text` or `vector`. Set
 * both only on a manual-vector store that can use the hybrid tier. Anything else throws at search time.
 */
export interface MongoDBSearchQuery {
  /** Natural-language query. Embedded server-side on the automated-embedding path. */
  text?: string
  /** A pre-computed embedding, used directly. */
  vector?: number[]
  /** MQL predicate over declared filterable fields, validated before it reaches the server. */
  filter?: Record<string, unknown>
  /** Result ceiling for this call, overriding the store's own. */
  limit?: number
  /**
   * Multiplier turning `limit` into a vector candidate count. On the vector and hybrid tiers, a
   * `limit * oversamplingFactor` above {@link MAX_NUM_CANDIDATES} throws.
   */
  oversamplingFactor?: number
}

/** Result returned by `MongoDBMemoryStore.add`. */
export interface MongoDBAddResult {
  /** Stringified `_id` of every document the call resolved to, whether inserted now or already present. */
  ids: string[]
  /** How many documents the call created. */
  inserted: number
  /**
   * How many were already present and therefore not created. Required, so no code path can report zero by
   * omission. Extraction writes are at-least-once, so this explains a fact count lower than the write count.
   */
  duplicates: number
}

/** Result ceiling when neither the call nor the store supplies one. Matches the SDK's shipped stores. */
export const DEFAULT_MAX_SEARCH_RESULTS = 10

/** Multiplier turning a result limit into a `$vectorSearch` `numCandidates`. Matches `pymongo_search_utils`. */
export const DEFAULT_OVERSAMPLING_FACTOR = 10

/**
 * Metadata keys this package sets on every returned `MemoryEntry`.
 *
 * `MemoryEntry` has no score field, so relevance, document id, answering tier and scope travel in `metadata`.
 * On a collision with caller metadata the reserved value wins and the collision is logged.
 */
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  '_relevance_score',
  '_id',
  '_search_type',
  '_scope',
])

/**
 * Collection a `MongoDBMemoryStore` uses when the config names none.
 *
 * Different from {@link DEFAULT_STORAGE_COLLECTION} on purpose: a shared default would put session blobs in the
 * collection whose vector index tries to embed them. Python calls it `DEFAULT_COLLECTION`.
 */
export const DEFAULT_MEMORY_COLLECTION = 'memory'

/** Collection a `MongoDBStorage` uses when its options name none. */
export const DEFAULT_STORAGE_COLLECTION = 'storage'

/**
 * Scope stamped on writes and filtered on by reads when the config names none.
 *
 * A sentinel rather than no scope predicate at all, which would let an unconfigured store read every tenant's
 * documents. The double underscores keep it from colliding with a real scope.
 */
export const UNSCOPED = '__unscoped__'

/** Atlas embedding model used when the config names none. Matches the community `strands-mongodb-store`. */
export const DEFAULT_EMBEDDING_MODEL = 'voyage-4-lite'

/** Default Atlas Vector Search index name. */
export const DEFAULT_VECTOR_INDEX_NAME = 'vector_index'

/** Default Atlas Search index name. */
export const DEFAULT_TEXT_INDEX_NAME = 'text_index'

/**
 * Longest key this package writes, in UTF-8 bytes, including the instance prefix.
 *
 * A package limit, not a server one. A long key makes every `list` range scan pay for a long index entry, and
 * it fails outright on a deployment pinned below FCV 4.2, whose index key limit this is.
 */
export const MAX_KEY_BYTES = 1024

/** The BSON document size limit (16 MiB) that `write` checks before sending. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

/** Distance metrics an Atlas vector index accepts. Mirrors {@link VectorSimilarity} at runtime. */
export const SIMILARITIES: readonly VectorSimilarity[] = ['cosine', 'dotProduct', 'euclidean']

/** Upper bound Atlas enforces on `numDimensions`. Outside `[1..8192]` is server error code 8. */
export const MAX_DIMENSIONS = 8192

/** Upper bound the server enforces on `numCandidates`. Outside `[1..10000]` is server error code 8. */
export const MAX_NUM_CANDIDATES = 10_000

/**
 * Default milliseconds to wait for search-index builds to report `READY`.
 *
 * Builds on cloud Atlas have taken about 105 seconds idle and over 120 seconds on a busy cluster. A longer
 * timeout delays only a failure. Python's `READY_TIMEOUT_SECONDS` is 300.
 */
export const READY_TIMEOUT_MS = 300_000

/** Delay between readiness reads, in milliseconds. */
export const POLL_INTERVAL_MS = 500

/**
 * Delay before a search tier skipped under `'auto'` is tried again, in milliseconds.
 *
 * The retry runs inside the first store call after the delay, and doubles after each retry that still finds the
 * tier missing, up to {@link TIER_RETRY_MAX_MS}.
 */
export const TIER_RETRY_MS = 60_000

/** Ceiling on {@link TIER_RETRY_MS} after doubling, in milliseconds. */
export const TIER_RETRY_MAX_MS = 3_600_000

/** Major version of `mongod` from which `$rankFusion` with `$vectorSearch` inputs exists: 8.0, not 8.1. */
export const RANK_FUSION_MIN_MAJOR = 8

/**
 * Server error codes from listing search indexes that mean "this deployment has no Atlas Search".
 *
 * 31082 on `mongo:8`, 115 (`CommandNotSupported`) on enterprise `mongod` 7.0 with no mongot, and 6047401 on
 * `mongo:6` and `mongo:7`. The number is the stable part: the message and `codeName` differ between deployments.
 */
export const SEARCH_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([31082, 115, 6047401])

/** The one collation locale that compares strings byte by byte. */
export const SIMPLE_LOCALE = 'simple'

/** Document field holding the text a memory is about, indexed for vector and full-text search. */
export const CONTENT_FIELD = 'content'

/** Document field holding a caller-supplied embedding, on the manual-vector path only. */
export const VECTOR_FIELD = 'embedding'

/** Document field the TTL indexes watch. Absent on documents with no expiry. */
export const EXPIRES_FIELD = 'expires_at'

/**
 * Rank constant the server applies inside `$rankFusion`. This package never sends it.
 *
 * It sets the scale of every hybrid score: a document first in one tier scores about `1/61` (0.016), while
 * cosine similarity and BM25 land roughly between 0 and 1.
 */
export const RANK_FUSION_PENALTY = 60

/** `$meta` name for a `$vectorSearch` score. Not interchangeable with the other two. */
export const VECTOR_SCORE_META = 'vectorSearchScore'

/**
 * `$meta` name for a `$rankFusion` score. Not interchangeable with the other two.
 *
 * `$rankFusion` returns documents with no score field, so without a `$set` of this metadata every hybrid result
 * would score `0` and any `minScore` would silently empty the result list.
 */
export const FUSION_SCORE_META = 'score'

/**
 * `$meta` name for a `$search` score. Not interchangeable with the other two.
 *
 * Crossing it with the vector name is not reliably an error: Atlas 8.0 returns no score field, which reads as
 * `0`. So these constants are the guard, not the server.
 */
export const TEXT_SCORE_META = 'searchScore'

/** Field every tier projects its score into, so a reader does not branch on the tier. */
export const SCORE_FIELD = 'score'
