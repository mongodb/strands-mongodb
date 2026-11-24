/**
 * The public configuration, query and result types, ported from `python/tests/test_types.py`.
 *
 * Python splits these tests by who enforces the property: the interpreter for what it can see, and a real mypy
 * run for required keys and literal types. Here `tsc` enforces both, because `npm run typecheck` covers
 * `test/`. So the type-level half of each test is an `expectTypeOf` assertion or a `@ts-expect-error` line, which
 * fails the typecheck rather than the test run if the type drifts. The runtime half pins the constants.
 */
import type { MemoryStoreConfig } from '@strands-agents/sdk'
import type { MongoClient, MongoClientOptions } from 'mongodb'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as publicSurface from '../../src/index.js'
import {
  DEFAULT_MEMORY_COLLECTION,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_OVERSAMPLING_FACTOR,
  DEFAULT_STORAGE_COLLECTION,
  DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_VECTOR_INDEX_NAME,
  MAX_DIMENSIONS,
  MAX_DOCUMENT_BYTES,
  MAX_KEY_BYTES,
  MAX_NUM_CANDIDATES,
  POLL_INTERVAL_MS,
  RANK_FUSION_MIN_MAJOR,
  RANK_FUSION_PENALTY,
  READY_TIMEOUT_MS,
  RESERVED_METADATA_KEYS,
  SEARCH_UNSUPPORTED_CODES,
  SIMILARITIES,
  TIER_RETRY_MAX_MS,
  TIER_RETRY_MS,
  UNSCOPED,
  type MongoDBAddResult,
  type MongoDBConfig,
  type MongoDBMemoryStoreConfig,
  type MongoDBSearchQuery,
  type MongoDBStorageOptions,
  type ResolvedSearchType,
  type SearchType,
  type VectorSimilarity,
} from '../../src/types.js'

describe('TS-008 — the add result reports what the write did', () => {
  it('TS-008 — it carries exactly ids, inserted and duplicates, all required', () => {
    // Python pins a dataclass's field order. A TypeScript interface has no order, so what is pinned is the set
    // of keys and that none is optional: a result with `duplicates` left out must not typecheck, or a code path
    // that never counted duplicates could report none by omission.
    expectTypeOf<MongoDBAddResult>().toEqualTypeOf<{ ids: string[]; inserted: number; duplicates: number }>()

    // @ts-expect-error -- `duplicates` has no default.
    const missing: MongoDBAddResult = { ids: ['6512'], inserted: 1 }
    expect(missing.ids).toEqual(['6512'])
  })
})

describe("TS-008 — the memory store config is the SDK's config plus MongoDB's fields", () => {
  it('TS-008 — it carries every key the SDK config declares', () => {
    expectTypeOf<MongoDBMemoryStoreConfig>().toExtend<MemoryStoreConfig>()
  })

  it('TS-008 — it adds the eight documented MongoDB fields, camelCased', () => {
    expectTypeOf<Exclude<keyof MongoDBMemoryStoreConfig, keyof MemoryStoreConfig>>().toEqualTypeOf<
      'config' | 'collection' | 'scope' | 'filter' | 'minScore' | 'maxScore' | 'ttlSeconds' | 'embedder'
    >()
  })

  it('TS-008 — name and config are both required', () => {
    const config: MongoDBConfig = { database: 'agents' }

    // @ts-expect-error -- `name` comes from the SDK and stays required.
    const noName: MongoDBMemoryStoreConfig = { config }
    // @ts-expect-error -- a store with no connection cannot do anything.
    const noConfig: MongoDBMemoryStoreConfig = { name: 'facts' }
    const both: MongoDBMemoryStoreConfig = { name: 'facts', config }

    expect([noName, noConfig, both]).toHaveLength(3)
  })

  it("TS-008 — any object with an embed method is an embedder, as the SDK's Embedder class is", () => {
    const store: MongoDBMemoryStoreConfig = {
      name: 'facts',
      config: { database: 'agents' },
      embedder: { embed: (text: string) => Promise.resolve([text.length]) },
    }

    expect(store.embedder).toBeDefined()
  })
})

describe('TS-008 — the connection config', () => {
  it('TS-008 — database is the one required key, and the rest are the camelCased Python keys', () => {
    expectTypeOf<MongoDBConfig>().toEqualTypeOf<{
      database: string
      client?: MongoClient
      connectionString?: string
      clientOptions?: MongoClientOptions
      ensureIndexes?: boolean
      indexReadyTimeoutMs?: number
      searchType?: SearchType
      embeddingModel?: string
      embeddingDimensions?: number
      similarity?: VectorSimilarity
      filterFields?: string[]
      vectorIndexName?: string
      textIndexName?: string
    }>()

    // @ts-expect-error -- no database.
    const empty: MongoDBConfig = {}
    expect(empty).toEqual({})
  })

  it('TS-008 — the four search tiers are accepted, and one that does not run is rejected at the config site', () => {
    expectTypeOf<SearchType>().toEqualTypeOf<'auto' | 'vector' | 'text' | 'hybrid'>()
    // `auto` can be asked for but never answers.
    expectTypeOf<ResolvedSearchType>().toEqualTypeOf<'vector' | 'text' | 'hybrid'>()

    // @ts-expect-error -- `regex` is not a tier.
    const regex: MongoDBConfig = { database: 'agents', searchType: 'regex' }
    expect(regex.database).toBe('agents')
  })

  it('TS-008 — the three similarities an Atlas vector index accepts, and the runtime list agrees', () => {
    expectTypeOf<VectorSimilarity>().toEqualTypeOf<'cosine' | 'dotProduct' | 'euclidean'>()
    expectTypeOf(SIMILARITIES).toEqualTypeOf<readonly VectorSimilarity[]>()

    expect(SIMILARITIES).toEqual(['cosine', 'dotProduct', 'euclidean'])
  })
})

describe('TS-008 — the search query widens the protocol query', () => {
  it('TS-008 — it declares text, vector, filter and the two dials, every one optional', () => {
    // A query needs `text` or `vector`, and both only on the hybrid tier, which no type here can say. Making
    // either required would forbid the other path, so the search implementation checks it at runtime.
    expectTypeOf<MongoDBSearchQuery>().toEqualTypeOf<{
      text?: string
      vector?: number[]
      filter?: Record<string, unknown>
      limit?: number
      oversamplingFactor?: number
    }>()

    const vectorOnly: MongoDBSearchQuery = { vector: [0.1, 0.2], limit: 5 }
    expect(vectorOnly.limit).toBe(5)
  })
})

describe("TS-008 — the storage options are the Python constructor's keyword arguments", () => {
  it('TS-008 — collection, prefix, ttlSeconds and searchStrategy, every one optional', () => {
    expectTypeOf<keyof MongoDBStorageOptions>().toEqualTypeOf<
      'collection' | 'prefix' | 'ttlSeconds' | 'searchStrategy'
    >()

    const none: MongoDBStorageOptions = {}
    expect(none).toEqual({})
  })
})

describe('TS-009 — the shared constants hold the values the Python package uses', () => {
  it('TS-009 — the four reserved metadata keys', () => {
    expect(RESERVED_METADATA_KEYS).toEqual(new Set(['_relevance_score', '_id', '_search_type', '_scope']))
  })

  it('TS-009 — the result and oversampling defaults match the shipped stores and the stage builder', () => {
    expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(10)
    expect(DEFAULT_OVERSAMPLING_FACTOR).toBe(10)
  })

  it('TS-009 — the collection, scope, model and index-name defaults', () => {
    expect(DEFAULT_MEMORY_COLLECTION).toBe('memory')
    expect(DEFAULT_STORAGE_COLLECTION).toBe('storage')
    expect(UNSCOPED).toBe('__unscoped__')
    expect(DEFAULT_EMBEDDING_MODEL).toBe('voyage-4-lite')
    expect(DEFAULT_VECTOR_INDEX_NAME).toBe('vector_index')
    expect(DEFAULT_TEXT_INDEX_NAME).toBe('text_index')
  })

  it('TS-009 — the size ceilings', () => {
    expect(MAX_KEY_BYTES).toBe(1024)
    expect(MAX_DOCUMENT_BYTES).toBe(16 * 1024 * 1024)
    expect(MAX_DIMENSIONS).toBe(8192)
    expect(MAX_NUM_CANDIDATES).toBe(10_000)
  })

  it('TS-009 — durations are in milliseconds, with the unit in the name', () => {
    // Python states these in seconds: 300, 0.5, 60 and 3600.
    expect(READY_TIMEOUT_MS).toBe(300_000)
    expect(POLL_INTERVAL_MS).toBe(500)
    expect(TIER_RETRY_MS).toBe(60_000)
    expect(TIER_RETRY_MAX_MS).toBe(3_600_000)
  })

  it('TS-009 — the server facts: the fusion penalty, its version floor and the no-search error codes', () => {
    expect(RANK_FUSION_PENALTY).toBe(60)
    expect(RANK_FUSION_MIN_MAJOR).toBe(8)
    expect(SEARCH_UNSUPPORTED_CODES).toEqual(new Set([31082, 115, 6047401]))
  })
})

describe('TS-008 — the entry point exports the types and the public constants', () => {
  it('TS-008 — the DEFAULT_* constants, RESERVED_METADATA_KEYS and UNSCOPED', () => {
    expect(publicSurface).toMatchObject({
      DEFAULT_MAX_SEARCH_RESULTS,
      DEFAULT_OVERSAMPLING_FACTOR,
      DEFAULT_EMBEDDING_MODEL,
      DEFAULT_VECTOR_INDEX_NAME,
      DEFAULT_TEXT_INDEX_NAME,
      DEFAULT_MEMORY_COLLECTION,
      DEFAULT_STORAGE_COLLECTION,
      RESERVED_METADATA_KEYS,
      UNSCOPED,
    })
  })

  it('TS-008 — the internal constants stay internal', () => {
    // Python's are module-private or live in a private module. Exporting one from the entry point would make
    // it a promise.
    expect(Object.keys(publicSurface)).not.toContain('MAX_NUM_CANDIDATES')
    expect(Object.keys(publicSurface)).not.toContain('SEARCH_UNSUPPORTED_CODES')
  })
})
