/**
 * MongoDB storage and memory backends for the Strands Agents SDK.
 *
 * @packageDocumentation
 */
export type {
  MongoDBAddResult,
  MongoDBConfig,
  MongoDBMemoryStoreConfig,
  MongoDBSearchQuery,
  MongoDBStorageOptions,
  ResolvedSearchType,
  SearchType,
  VectorSimilarity,
} from './types.js'
export {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MEMORY_COLLECTION,
  DEFAULT_OVERSAMPLING_FACTOR,
  DEFAULT_STORAGE_COLLECTION,
  DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_VECTOR_INDEX_NAME,
  RESERVED_METADATA_KEYS,
  UNSCOPED,
} from './types.js'
export { MongoDBStorage } from './storage.js'
export { DEFAULT_STORAGE_VECTOR_INDEX_NAME, MongoDBVectorSearchStrategy } from './vector-search.js'
export type { MongoDBVectorSearchStrategyOptions } from './vector-search.js'
export { configureLogging } from './telemetry.js'
export { VERSION } from './version.js'
