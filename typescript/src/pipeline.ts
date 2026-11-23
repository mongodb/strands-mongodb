/**
 * Aggregation stages for the vector, text and hybrid search tiers.
 *
 * Ported from `python/src/strands_mongodb/_pipeline.py`. Pure functions over plain documents: no client and no
 * I/O, so every shape is testable without a deployment. That matters because the mistakes this module prevents
 * are shape mistakes a live query can answer with wrong results rather than an error.
 *
 * Python takes its search stages from `pymongo-search-utils` 0.3.0. There is no JavaScript counterpart, so the
 * three builders it uses are written here, with the same keys in the same order: `vector_search_stage`,
 * `autoembedding_vector_search_stage` and `text_search_stage`. `test/unit/golden.test.ts` holds them to what
 * Python emits. What this module adds to them is what Python's adds:
 *
 * - **One return type.** Every function returns a fresh array of stages, so the tiers compose the same way.
 * - **Which builder, and which path.** Both follow the {@link VectorMode}. The `autoEmbed` index declares the
 *   text field as its vector field, so the AutoEmbeddings query paths at `content` and the manual query at
 *   `embedding`. Crossing them fails with code 8, but only after a round trip.
 * - **The score projection.** The three `$meta` names (vector, text, fused) are not interchangeable.
 * - **The hybrid tier.** {@link hybridStages} wraps the vector and text pipelines in one server-side
 *   `$rankFusion` (MongoDB 8.0+).
 *
 * A number out of range is a `RangeError`. A query with neither `text` nor `vector`, or with both where nothing
 * reads both, is a `TypeError`, a query of the wrong shape. A well-formed query that contradicts the store's
 * vector path is a plain `Error`, since what is wrong is the pairing of query and config.
 *
 * Internal: not exported from the entry point.
 *
 * @packageDocumentation
 */
import type { Document } from 'mongodb'

import type { VectorMode } from './indexes.js'
import {
  CONTENT_FIELD,
  DEFAULT_OVERSAMPLING_FACTOR,
  FUSION_SCORE_META,
  MAX_NUM_CANDIDATES,
  SCORE_FIELD,
  TEXT_SCORE_META,
  VECTOR_FIELD,
  VECTOR_SCORE_META,
} from './types.js'

/** What {@link vectorStages} takes. */
export interface VectorStagesOptions {
  /** The resolved vector path, which picks the stage shape and the field it searches. */
  readonly mode: VectorMode
  /** The vector search index. */
  readonly indexName: string
  /** How many results the stage returns. */
  readonly limit: number
  /** The text to embed, on the AutoEmbeddings path only. */
  readonly queryText?: string | null | undefined
  /** A pre-computed embedding, on the manual path only. Copied into the stage as given. */
  readonly queryVector?: readonly unknown[] | null | undefined
  /** A pre-filter, applied inside `$vectorSearch`. Omitted when empty. */
  readonly queryFilter?: Document | null | undefined
  /** Multiplier turning `limit` into `numCandidates`. */
  readonly oversamplingFactor?: number | undefined
  /** Whether to project the score. Only the hybrid tier passes `false`. */
  readonly score?: boolean | undefined
}

/** What {@link textStages} takes. */
export interface TextStagesOptions {
  /** The text to search for. */
  readonly queryText: string
  /** The full-text search index. */
  readonly indexName: string
  /** How many results the pipeline returns. */
  readonly limit: number
  /** A post-filter, as its own `$match` before the `$limit`. Omitted when empty. */
  readonly queryFilter?: Document | null | undefined
  /** Whether to project the score. Only the hybrid tier passes `false`. */
  readonly score?: boolean | undefined
}

/** What {@link hybridStages} takes. */
export interface HybridStagesOptions {
  /** The resolved vector path. */
  readonly mode: VectorMode
  /** The vector search index. */
  readonly vectorIndexName: string
  /** The full-text search index. */
  readonly textIndexName: string
  /** The text, for the text branch, and for the vector branch on the AutoEmbeddings path. */
  readonly queryText: string
  /** How many fused results the pipeline returns. */
  readonly limit: number
  /** A pre-computed embedding for the vector branch, on the manual path. */
  readonly queryVector?: readonly unknown[] | null | undefined
  /** Applied as a pre-filter on the vector branch and in a `$match` on the text branch. */
  readonly queryFilter?: Document | null | undefined
  /** Multiplier behind `numCandidates` on the vector branch. */
  readonly oversamplingFactor?: number | undefined
}

/**
 * A limit that is not a positive integer.
 *
 * Python checks only `>= 1`: a fraction there is a caller bug its type hints catch. Measured, the server
 * rejects a non-positive `$vectorSearch` limit with code 7912700 on 8.0 and 65137 on 9.0.
 *
 * @param limit - The limit.
 * @returns The message.
 */
const BAD_LIMIT = (limit: number): string =>
  `strands_mongodb: 'limit' is ${limit} and a search limit must be an integer of at least 1. The server ` +
  'rejects a non-positive limit outright.'

/**
 * A factor that is not a positive integer.
 *
 * @param factor - The factor.
 * @returns The message.
 */
const BAD_FACTOR = (factor: number): string =>
  `strands_mongodb: 'oversamplingFactor' is ${factor} and must be an integer of at least 1. A factor below 1 ` +
  'asks the server to consider fewer candidates than the results it must return, which is rejected as ' +
  'numCandidates below the limit.'

/**
 * A candidate count above the server's ceiling, measured as code 8.
 *
 * @param candidates - The product.
 * @param limit - The limit.
 * @param factor - The factor.
 * @returns The message.
 */
const TOO_MANY_CANDIDATES = (candidates: number, limit: number, factor: number): string =>
  `strands_mongodb: numCandidates would be ${candidates}, and the server requires a value within bounds ` +
  `[1..${MAX_NUM_CANDIDATES}]. It is derived as limit (${limit}) times 'oversamplingFactor' (${factor}), so ` +
  'lower whichever of the two you can afford to: the limit costs you results, the factor costs you recall.'

/**
 * A limit above the candidate count, measured as code 8 with a message of its own.
 *
 * @param limit - The limit.
 * @param numCandidates - The candidate count.
 * @returns The message.
 */
const LIMIT_ABOVE_CANDIDATES = (limit: number, numCandidates: number): string =>
  `strands_mongodb: limit (${limit}) is greater than numCandidates (${numCandidates}), and the server requires ` +
  "limit <= numCandidates. Raise 'oversamplingFactor' or lower the limit."

/** Both query keys, where nothing reads both. */
const BOTH_KEYS =
  "strands_mongodb: the query sets both 'text' and 'vector', and this store has no interpretation that uses " +
  "both. Set 'text' to have the deployment embed it, or 'vector' to supply the embedding yourself. Both " +
  'together are read only by the hybrid tier on a manual-vector store, where each key feeds one half of the ' +
  'fusion.'

/** Neither query key. */
const NEITHER_KEY =
  "strands_mongodb: the query sets neither 'text' nor 'vector'. MongoDBSearchQuery marks every field optional " +
  'because the valid combinations are not expressible as a TypeScript type, so exactly one of the two has to ' +
  'be present.'

/** A vector query against the AutoEmbeddings path. */
const VECTOR_ON_AUTO_EMBED =
  "strands_mongodb: the query supplies 'vector', but this store is on the Atlas AutoEmbeddings path, whose " +
  'index declares the text field as its vector field and holds no caller-supplied embeddings. That path is ' +
  "selected by 'embeddingModel', and also by setting none of the vector keys at all, which is why this can " +
  "surprise a caller who set nothing. Query with 'text' instead, or set 'embeddingDimensions' and " +
  "'similarity' in MongoDBConfig to select the manual path. Switching paths means recreating the vector " +
  'index, since the two index different fields.'

/** A text query against the manual path. */
const TEXT_ON_MANUAL =
  "strands_mongodb: the query supplies 'text', but 'embeddingDimensions' and 'similarity' in MongoDBConfig " +
  'select the manual-vector path, where the deployment does not embed and this package does not either. ' +
  "Supply 'vector' with an embedding you computed, or remove both config keys to use Atlas AutoEmbeddings."

/**
 * Derive `numCandidates` from a limit and an oversampling factor.
 *
 * @param limit - How many results the stage returns.
 * @param oversamplingFactor - The multiplier.
 * @returns `limit * oversamplingFactor`.
 * @throws RangeError when either is not a positive integer, or the product is above
 *   {@link MAX_NUM_CANDIDATES}.
 */
export function candidateCount(limit: number, oversamplingFactor: number = DEFAULT_OVERSAMPLING_FACTOR): number {
  checkLimit(limit)
  if (!isCount(oversamplingFactor)) throw new RangeError(BAD_FACTOR(oversamplingFactor))
  const candidates = limit * oversamplingFactor
  if (candidates > MAX_NUM_CANDIDATES) {
    throw new RangeError(TOO_MANY_CANDIDATES(candidates, limit, oversamplingFactor))
  }
  return candidates
}

/**
 * Check the server's second bound, `limit <= numCandidates`, where the two numbers meet.
 *
 * Unreachable through {@link candidateCount} for any factor of 1 or more, which is why it is checked where the
 * stage is built rather than inside the derivation.
 *
 * @param counts - The limit and the candidate count.
 * @throws RangeError when the limit is greater.
 */
export function checkCandidateCount(counts: { readonly limit: number; readonly numCandidates: number }): void {
  if (counts.limit > counts.numCandidates) {
    throw new RangeError(LIMIT_ABOVE_CANDIDATES(counts.limit, counts.numCandidates))
  }
}

/**
 * Build the vector tier: one `$vectorSearch`, then the score projection.
 *
 * `$vectorSearch`'s `filter` is applied during the search, so its `limit` counts documents that passed it, and
 * this tier needs no `$limit` stage of its own.
 *
 * @param options - The query and the store's settings.
 * @returns The stages.
 * @throws TypeError when the query sets neither `text` nor `vector`, or both.
 * @throws Error when the key it sets belongs to the other vector path.
 * @throws RangeError from {@link candidateCount} or {@link checkCandidateCount}.
 */
export function vectorStages(options: VectorStagesOptions): Document[] {
  const { mode, indexName, limit, queryText, queryVector, queryFilter } = options
  const { oversamplingFactor = DEFAULT_OVERSAMPLING_FACTOR, score = true } = options
  checkQueryShape(mode, queryText, queryVector)
  const numCandidates = candidateCount(limit, oversamplingFactor)
  checkCandidateCount({ limit, numCandidates })

  // Key order as `pymongo-search-utils` 0.3.0 writes it, which `golden.test.ts` asserts.
  const stage: Document = mode.autoEmbed
    ? { index: indexName, path: CONTENT_FIELD, query: { text: queryText }, numCandidates, limit, model: mode.model }
    : { index: indexName, path: VECTOR_FIELD, queryVector: [...(queryVector ?? [])], numCandidates, limit }
  if (isNonEmpty(queryFilter)) stage.filter = { ...queryFilter }
  return score ? [{ $vectorSearch: stage }, scoreStage(VECTOR_SCORE_META)] : [{ $vectorSearch: stage }]
}

/**
 * Build the full-text tier, ordered so a filtered query still returns its full count.
 *
 * `$search` filtering here is a post-filter, so the `$match` comes before the `$limit`. Over 200 matching
 * documents with 10 in scope, asking for 5, this order returns 5 and an early `$limit: 5` returns 0. No fixed
 * over-fetch ahead of the `$match` is safe either: when the filter anti-correlates with relevance, every
 * multiplier up to 38x returned nothing.
 *
 * Leaving the stream unbounded until the `$match` does not fetch the whole corpus. The aggregation pulls from
 * mongot in batches that start near 100 and grow by half, and stops once `$limit` is satisfied, so cost
 * tracks how many documents survive the filter.
 *
 * @param options - The query and the index.
 * @returns `$search`, then `$match` when there is a filter, then `$set` unless `score` is false, then `$limit`.
 * @throws RangeError when the limit is not a positive integer.
 */
export function textStages(options: TextStagesOptions): Document[] {
  const { queryText, indexName, limit, queryFilter, score = true } = options
  checkLimit(limit)
  const stages: Document[] = [{ $search: { index: indexName, text: { query: queryText, path: CONTENT_FIELD } } }]
  if (isNonEmpty(queryFilter)) stages.push({ $match: { ...queryFilter } })
  if (score) stages.push(scoreStage(TEXT_SCORE_META))
  stages.push({ $limit: limit })
  return stages
}

/**
 * Build the hybrid tier: the vector and text pipelines fused by one server-side `$rankFusion`.
 *
 * Each input pipeline is the single-tier builder called with `score: false`, so the filter placement and the
 * candidate arithmetic are the same here as on those tiers. `$rankFusion` ranks by position within each input
 * and rejects a `$set` there, so the fused score is projected outside it, under its own `$meta` name. The
 * fusion returns the union of both branches, up to twice `limit`, hence the final `$limit`.
 *
 * @param options - The query and the store's settings.
 * @returns The `$rankFusion`, the `$set` projecting its fused score, and the `$limit`.
 * @throws TypeError, Error or RangeError: whatever {@link vectorStages} or {@link textStages} throws.
 */
export function hybridStages(options: HybridStagesOptions): Document[] {
  const { mode, vectorIndexName, textIndexName, queryText, limit, queryVector, queryFilter } = options
  const vector = vectorStages({
    mode,
    indexName: vectorIndexName,
    limit,
    queryText: mode.autoEmbed ? queryText : undefined,
    queryVector,
    queryFilter,
    oversamplingFactor: options.oversamplingFactor,
    score: false,
  })
  const text = textStages({ queryText, indexName: textIndexName, limit, queryFilter, score: false })
  return [{ $rankFusion: { input: { pipelines: { vector, text } } } }, scoreStage(FUSION_SCORE_META), { $limit: limit }]
}

/**
 * Reject the two query shapes no tier can answer. Needs no vector mode, so the memory store runs it before
 * choosing a tier: on a manual-vector store, a `text` query is wrong for the vector tier but right for text.
 *
 * @param query - What the caller put in `text` and `vector`, and `fusionPossible`: whether the store's config
 *   could read both, which is the manual-vector path with `searchType` at `auto` or `hybrid`.
 * @throws TypeError when both are set and fusion is not possible, or when neither is set.
 */
export function checkQueryKeys(query: {
  readonly queryText?: string | null | undefined
  readonly queryVector?: readonly unknown[] | null | undefined
  readonly fusionPossible?: boolean | undefined
}): void {
  const hasText = query.queryText !== undefined && query.queryText !== null
  const hasVector = query.queryVector !== undefined && query.queryVector !== null
  if (hasText && hasVector && query.fusionPossible !== true) throw new TypeError(BOTH_KEYS)
  if (!hasText && !hasVector) throw new TypeError(NEITHER_KEY)
}

/**
 * Reject a query whose keys contradict the store's vector path, naming the config key that chose the path.
 *
 * An AutoEmbeddings-shaped stage against a manual index fails with code 8, `queryVector must be present`. The
 * reverse needs a registered embedding model to measure. Both are rejected here, before the round trip.
 */
function checkQueryShape(
  mode: VectorMode,
  queryText: string | null | undefined,
  queryVector: readonly unknown[] | null | undefined,
): void {
  checkQueryKeys({ queryText, queryVector })
  if (mode.autoEmbed && queryVector !== undefined && queryVector !== null) throw new Error(VECTOR_ON_AUTO_EMBED)
  if (!mode.autoEmbed && queryText !== undefined && queryText !== null) throw new Error(TEXT_ON_MANUAL)
}

/** Throw unless `limit` is a positive integer. */
function checkLimit(limit: number): void {
  if (!isCount(limit)) throw new RangeError(BAD_LIMIT(limit))
}

/** Whether `value` is an integer of at least 1. */
function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1
}

/** Whether a filter has any field. `{}` is no predicate, and a different query shape for the same intent. */
function isNonEmpty(filter: Document | null | undefined): filter is Document {
  return filter !== undefined && filter !== null && Object.keys(filter).length > 0
}

/** The `$set` writing a tier's score into {@link SCORE_FIELD}. */
function scoreStage(meta: string): Document {
  return { $set: { [SCORE_FIELD]: { $meta: meta } } }
}
