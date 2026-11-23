/**
 * `MongoDBVectorSearchStrategy`: Atlas Vector Search behind `MongoDBStorage.search`.
 *
 * Ported from `python/src/strands_mongodb/vector_search.py`. Needs a deployment with Atlas Vector Search:
 * Atlas, or an Atlas CLI local deployment.
 *
 * Four differences from Python, each for a reason stated where it happens:
 *
 * - `remove(storage, key)` exists, as on the SDK's `S3VectorSearchStrategy`, and does nothing.
 * - The options are camelCased in one object, as the SDK's vended strategies take theirs, and messages start
 *   `MongoDBVectorSearchStrategy:` (design §5.4). The out-of-range errors are `RangeError`s.
 * - `dimensions`, `maxResults` and `oversamplingFactor` must be integers. Python's `int` annotation is checked
 *   by mypy; a TypeScript `number` admits `1.5`, so the check is made at runtime.
 * - The strategy reaches the store's collection through `storageCollection`, an internal function the class
 *   hands out, where Python calls the store's private `_collection()`.
 *
 * @packageDocumentation
 */
import type { SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary } from 'mongodb'
import type { Document } from 'mongodb'

import { embed, type TextEmbedder } from './index-lifecycle.js'
import { SearchIndexSpec } from './indexes.js'
import { type MongoDBStorage, storageCollection } from './storage.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_OVERSAMPLING_FACTOR,
  MAX_DIMENSIONS,
  MAX_NUM_CANDIDATES,
  SIMILARITIES,
  VECTOR_FIELD,
  type VectorSimilarity,
} from './types.js'

/** Vector index name when none is given. Distinct from the memory store's `vector_index`. */
export const DEFAULT_STORAGE_VECTOR_INDEX_NAME = 'storage_vector_index'

/**
 * Every `/`-terminated ancestor of a document's `_id`, the path `search` pre-filters on.
 *
 * `$vectorSearch` cannot filter on an `_id` range, so a prefix becomes an equality match on this array.
 */
export const PREFIXES_FIELD = 'prefixes'

/** What {@link MongoDBVectorSearchStrategy} is built from. */
export interface MongoDBVectorSearchStrategyOptions {
  /** Any object with an async `embed(text)`, such as an SDK `Embedder`. Embeds stored values and queries. */
  embedder: TextEmbedder
  /** Length of the vectors `embedder` returns. */
  dimensions: number
  /** `'cosine'`, `'dotProduct'` or `'euclidean'`. */
  similarity: VectorSimilarity
  /** Name of the Atlas Vector Search index on the storage's collection. Defaults to {@link DEFAULT_STORAGE_VECTOR_INDEX_NAME}. */
  indexName?: string
  /** Most results one search returns. Defaults to {@link DEFAULT_MAX_SEARCH_RESULTS}. */
  maxResults?: number
  /** Multiplier turning `maxResults` into `numCandidates`. Defaults to {@link DEFAULT_OVERSAMPLING_FACTOR}. */
  oversamplingFactor?: number
}

/**
 * The message for a vector length Atlas would refuse.
 *
 * @param dimensions - The configured length.
 * @returns The message.
 */
const DIMENSIONS_OUT_OF_RANGE = (dimensions: number): string =>
  `MongoDBVectorSearchStrategy: 'dimensions' is ${dimensions} and must be an integer within 1..${MAX_DIMENSIONS}.`

/**
 * The message for a metric Atlas does not know.
 *
 * @param similarity - The configured metric.
 * @returns The message.
 */
const UNKNOWN_SIMILARITY = (similarity: string): string =>
  `MongoDBVectorSearchStrategy: 'similarity' is '${similarity}' and must be one of ${SIMILARITIES.join(', ')}.`

/**
 * The message for a result count or multiplier below 1.
 *
 * @param maxResults - The configured result count.
 * @param oversamplingFactor - The configured multiplier.
 * @returns The message.
 */
const COUNTS_OUT_OF_RANGE = (maxResults: number, oversamplingFactor: number): string =>
  `MongoDBVectorSearchStrategy: 'maxResults' (${maxResults}) and 'oversamplingFactor' (${oversamplingFactor}) ` +
  'must both be integers of at least 1.'

/**
 * The message for a `numCandidates` the server would refuse.
 *
 * @param candidates - `maxResults * oversamplingFactor`.
 * @returns The message.
 */
const TOO_MANY_CANDIDATES = (candidates: number): string =>
  `MongoDBVectorSearchStrategy: numCandidates would be ${candidates}, over the server's bound of ` +
  `${MAX_NUM_CANDIDATES}. Lower 'maxResults' or 'oversamplingFactor'.`

/** Whether `value` is an integer of at least 1. */
const isCount = (value: number): boolean => Number.isInteger(value) && value >= 1

/**
 * Vector search for {@link MongoDBStorage}, backed by Atlas Vector Search.
 *
 * The vector lives on the key's own document, so `write` and `delete` keep the index in step. Call
 * `MongoDBStorage.ensureIndexes()` once to create the index. Empty and non-UTF-8 values aren't indexed. Every
 * write is embedded, so use it on a storage of its own rather than the agent's. Each value is embedded whole
 * and must fit the embedding model's input; a longer one makes `write` throw after the value is stored.
 *
 * @example
 * ```ts
 * const storage = new MongoDBStorage(config, {
 *   collection: 'memory_files',
 *   searchStrategy: new MongoDBVectorSearchStrategy({ embedder, dimensions: 1024, similarity: 'cosine' }),
 * })
 * await storage.ensureIndexes()
 * ```
 */
export class MongoDBVectorSearchStrategy implements SearchStrategy<MongoDBStorage> {
  readonly #embedder: TextEmbedder
  readonly #dimensions: number
  readonly #similarity: VectorSimilarity
  readonly #indexName: string
  readonly #maxResults: number
  readonly #numCandidates: number

  /**
   * Configure the strategy. Nothing connects until the first write or search.
   *
   * @param options - The embedder, the vector length and metric, and the search's bounds.
   * @throws RangeError when an option is out of range, or `maxResults * oversamplingFactor` exceeds the
   *   server's bound on `numCandidates`.
   */
  constructor(options: MongoDBVectorSearchStrategyOptions) {
    const {
      embedder,
      dimensions,
      similarity,
      indexName = DEFAULT_STORAGE_VECTOR_INDEX_NAME,
      maxResults = DEFAULT_MAX_SEARCH_RESULTS,
      oversamplingFactor = DEFAULT_OVERSAMPLING_FACTOR,
    } = options
    if (!isCount(dimensions) || dimensions > MAX_DIMENSIONS) throw new RangeError(DIMENSIONS_OUT_OF_RANGE(dimensions))
    // A config read from the environment can carry any string, whatever the type says.
    if (!SIMILARITIES.includes(similarity)) throw new RangeError(UNKNOWN_SIMILARITY(similarity))
    if (!isCount(maxResults) || !isCount(oversamplingFactor)) {
      throw new RangeError(COUNTS_OUT_OF_RANGE(maxResults, oversamplingFactor))
    }
    if (maxResults * oversamplingFactor > MAX_NUM_CANDIDATES) {
      throw new RangeError(TOO_MANY_CANDIDATES(maxResults * oversamplingFactor))
    }
    this.#embedder = embedder
    this.#dimensions = dimensions
    this.#similarity = similarity
    this.#indexName = indexName
    this.#maxResults = maxResults
    this.#numCandidates = maxResults * oversamplingFactor
  }

  /**
   * The vector index this strategy searches, for `MongoDBStorage.ensureIndexes`.
   *
   * @returns A `vectorSearch` index over `embedding` with `prefixes` declared filterable.
   */
  indexSpec(): SearchIndexSpec {
    return new SearchIndexSpec(
      this.#indexName,
      {
        fields: [
          { type: 'vector', path: VECTOR_FIELD, numDimensions: this.#dimensions, similarity: this.#similarity },
          { type: 'filter', path: PREFIXES_FIELD },
        ],
      },
      'vectorSearch',
    )
  }

  /**
   * Embed `data` and store the vector on the document `storage.write` just replaced.
   *
   * The update matches only while the document still holds `data`, so a slower write's vector never lands on
   * a newer value.
   *
   * @param storage - The storage the value was written to.
   * @param key - The normalised key, relative to `storage`.
   * @param data - The bytes written.
   * @throws RangeError when the embedder returns a vector whose length is not `dimensions`.
   */
  async index(storage: MongoDBStorage, key: string, data: Uint8Array): Promise<void> {
    const text = decodeText(data)
    if (!text) return
    const vector = await this.#embed(text)
    const id = `${storage.prefix}${key}`
    await storageCollection(storage).updateOne(
      { _id: id, data },
      { $set: { [VECTOR_FIELD]: vector, [PREFIXES_FIELD]: ancestors(id) } },
    )
  }

  /**
   * Does nothing. The vector lives on the stored document, so `delete` removes it with the value. Present so
   * code written against the SDK's `S3VectorSearchStrategy`, which `S3Storage.delete` calls, finds the method.
   *
   * @param storage - The storage the value was deleted from.
   * @param key - The deleted key.
   */
  async remove(storage: MongoDBStorage, key: string): Promise<void> {
    void storage
    void key
  }

  /**
   * The stored values nearest the query, under `storage`'s prefix only.
   *
   * @param storage - The storage to search.
   * @param query - A natural-language string. A blank one returns `[]` without embedding.
   * @returns Up to `maxResults` results, best first, with the stored bytes as `data`.
   * @throws RangeError when the embedder returns a vector whose length is not `dimensions`.
   */
  async search(storage: MongoDBStorage, query: string): Promise<StorageSearchResult[]> {
    if (query.trim() === '') return []
    const stage: Document = {
      index: this.#indexName,
      path: VECTOR_FIELD,
      queryVector: await this.#embed(query),
      numCandidates: this.#numCandidates,
      limit: this.#maxResults,
    }
    const prefix = storage.prefix
    if (prefix !== '') stage.filter = { [PREFIXES_FIELD]: { $eq: prefix } }
    const pipeline = [{ $vectorSearch: stage }, { $project: { data: 1, score: { $meta: 'vectorSearchScore' } } }]
    const results: StorageSearchResult[] = []
    for await (const document of storageCollection(storage).aggregate(pipeline)) {
      const data: unknown = document.data
      results.push({
        key: String(document._id).slice(prefix.length),
        score: Number(document.score ?? 0),
        // Copied out of the driver's `Binary`, as `read` does, so the caller gets a plain `Uint8Array`.
        data: new Uint8Array(data instanceof Binary ? data.value() : (data as Uint8Array)),
      })
    }
    return results
  }

  #embed(text: string): ReturnType<typeof embed> {
    return embed(this.#embedder, text, this.#dimensions, 'dimensions')
  }
}

/**
 * Every `/`-terminated prefix of `id`, shortest first: `a/b/c` gives `a/`, `a/b/`.
 *
 * @param id - A document `_id`.
 * @returns The ancestors.
 */
export function ancestors(id: string): string[] {
  const parts = id.split('/').slice(0, -1)
  return parts.map((_, depth) => `${parts.slice(0, depth + 1).join('/')}/`)
}

/** The bytes as UTF-8 text, or `undefined` for empty or non-UTF-8 input. A byte-order mark is kept, as Python keeps it. */
function decodeText(data: Uint8Array): string | undefined {
  if (data.length === 0) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    return undefined
  }
}
