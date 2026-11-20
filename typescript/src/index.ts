/**
 * MongoDB storage and memory backends for the Strands Agents SDK.
 *
 * @packageDocumentation
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as { version: string }

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

/** The package version, read from `package.json`. */
export const VERSION: string = manifest.version
