/**
 * Search stage construction: the vector, full-text and hybrid pipelines this package sends.
 *
 * Ports the unit classes of `python/tests/test_pipeline.py`. The unit tier can only check that a document has
 * the shape somebody claimed; what mongot does with it is `test/integration/pipeline.test.ts`.
 *
 * None of Python's ids here is a checklist item, so each leads with a `TS-` id: AT-070 is TS-100, AT-070a
 * TS-101, AT-070b TS-102, AT-070c TS-103, AT-072 and AT-072a TS-104, AT-073a TS-105, the unnumbered filter
 * placement class TS-106, AT-144 and AT-225 with the score keyword TS-107, and AT-074a TS-108.
 *
 * Two Python tests have no port, because each patches a module attribute that ESM does not let a test
 * replace: the copy of `text_search_stage`'s list, and `vector_stages` calling `check_candidate_count`. The
 * first guards a library this package does not use, since every stage here is built locally. The second is
 * wiring: `vectorStages` calls `checkCandidateCount`, which a reviewer can read but this tier cannot observe,
 * because no positive limit and factor can produce a pair it rejects.
 */
import { describe, expect, it } from 'vitest'

import { vectorIndexDefinition, vectorMode } from '../../src/indexes.js'
import {
  candidateCount,
  checkCandidateCount,
  checkQueryKeys,
  hybridStages,
  textStages,
  vectorStages,
  type HybridStagesOptions,
} from '../../src/pipeline.js'
import {
  CONTENT_FIELD,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OVERSAMPLING_FACTOR,
  MAX_NUM_CANDIDATES,
  VECTOR_FIELD,
} from '../../src/types.js'

/** The zero-configuration mode: no vector keys at all resolves to AutoEmbeddings. */
const AUTO_EMBED_MODE = vectorMode({})

/** The mode a local deployment can build an index for: an `autoEmbed` index needs a registered model. */
const MANUAL_MODE = vectorMode({ embeddingDimensions: 4, similarity: 'cosine' })

const VECTOR = [1, 0, 0, 0]

type Stage = Record<string, unknown>

/** Stage names in order, which is the property the full-text stage order is about. */
const names = (stages: readonly Stage[]): string[] => stages.map((stage) => Object.keys(stage)[0] as string)

/** The `$vectorSearch` body of the first stage. */
const vectorSearch = (stages: readonly Stage[]): Record<string, unknown> =>
  (stages[0] as { $vectorSearch: Record<string, unknown> }).$vectorSearch

/** The error `build` throws, or a failure if it throws nothing. */
function thrownBy(build: () => unknown): Error {
  try {
    build()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

describe('TS-100 — the AutoEmbeddings $vectorSearch stage, pinned exactly', () => {
  it('TS-100 — the stage equals the whole expected document, key order included', () => {
    const stages = vectorStages({ mode: AUTO_EMBED_MODE, indexName: 'vector_index', limit: 5, queryText: 'dark mode' })
    const expected = {
      $vectorSearch: {
        index: 'vector_index',
        path: CONTENT_FIELD,
        query: { text: 'dark mode' },
        numCandidates: 50,
        limit: 5,
        model: DEFAULT_EMBEDDING_MODEL,
      },
    }

    expect(stages[0]).toEqual(expected)
    expect(JSON.stringify(stages[0])).toBe(JSON.stringify(expected))
  })

  it('TS-100 — the query is a nested document and not a bare string', () => {
    // The one difference between the two candidate shapes. The community package sends a bare string.
    const stage = vectorSearch(vectorStages({ mode: AUTO_EMBED_MODE, indexName: 'i', limit: 1, queryText: 'q' }))

    expect(stage.query).toEqual({ text: 'q' })
    expect(stage).not.toHaveProperty('queryVector')
    expect(stage.model).toBe(DEFAULT_EMBEDDING_MODEL)
  })

  it('TS-100 — a configured model reaches the stage', () => {
    const mode = vectorMode({ embeddingModel: 'voyage-3-large' })

    expect(vectorSearch(vectorStages({ mode, indexName: 'i', limit: 1, queryText: 'q' })).model).toBe('voyage-3-large')
  })
})

describe('TS-101 — the builder and the path follow the mode', () => {
  it('TS-101 — the manual path sends a query vector over the vector field', () => {
    const stages = vectorStages({ mode: MANUAL_MODE, indexName: 'vector_index', limit: 5, queryVector: VECTOR })
    const expected = {
      $vectorSearch: { index: 'vector_index', path: VECTOR_FIELD, queryVector: VECTOR, numCandidates: 50, limit: 5 },
    }

    expect(stages[0]).toEqual(expected)
    expect(JSON.stringify(stages[0])).toBe(JSON.stringify(expected))
  })

  it('TS-101 — the manual stage carries no model and no text query', () => {
    const stage = vectorSearch(vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR }))

    expect(stage).not.toHaveProperty('model')
    expect(stage).not.toHaveProperty('query')
  })

  it('TS-101 — the query vector is copied, so a caller reusing its array cannot change a built stage', () => {
    const vector = [...VECTOR]
    const stage = vectorSearch(vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: vector }))

    vector[0] = 9

    expect(stage.queryVector).toEqual(VECTOR)
  })

  it('TS-101 — on each path the query path is the field the index definition declared', () => {
    const autoEmbed = vectorSearch(vectorStages({ mode: AUTO_EMBED_MODE, indexName: 'i', limit: 1, queryText: 'q' }))
    const manual = vectorSearch(vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR }))

    expect(autoEmbed.path).toBe(CONTENT_FIELD)
    expect(autoEmbed.path).toBe(vectorIndexDefinition(AUTO_EMBED_MODE).fields[0]?.path)
    expect(manual.path).toBe(VECTOR_FIELD)
    expect(manual.path).toBe(vectorIndexDefinition(MANUAL_MODE).fields[0]?.path)
  })
})

describe('TS-102 — every builder returns a fresh array of stages', () => {
  it('TS-102 — the vector and text tiers both return arrays of documents', () => {
    const vector = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })
    const text = textStages({ queryText: 'q', indexName: 'i', limit: 1 })

    for (const stages of [vector, text]) {
      expect(Array.isArray(stages)).toBe(true)
      expect(stages.every((stage) => typeof stage === 'object' && !Array.isArray(stage))).toBe(true)
    }
  })

  it('TS-102 — mutating one result, at any depth, does not affect the next', () => {
    const first = textStages({ queryText: 'q', indexName: 'i', limit: 1 })
    first.push({ $count: 'n' })
    ;(first[1] as { $set: { score: { $meta: string } } }).$set.score.$meta = 'changed'

    const second = textStages({ queryText: 'q', indexName: 'i', limit: 1 })

    expect(names(second)).toEqual(['$search', '$set', '$limit'])
    expect(second[1]).toEqual({ $set: { score: { $meta: 'searchScore' } } })
  })
})

describe('TS-103 — each tier projects its own score name', () => {
  it('TS-103 — the vector tier projects vectorSearchScore', () => {
    const stages = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })

    expect(stages[1]).toEqual({ $set: { score: { $meta: 'vectorSearchScore' } } })
  })

  it('TS-103 — the text tier projects searchScore', () => {
    expect(textStages({ queryText: 'q', indexName: 'i', limit: 1 })).toContainEqual({
      $set: { score: { $meta: 'searchScore' } },
    })
  })

  it("TS-103 — neither tier projects the other tier's score name", () => {
    const vector = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })
    const text = textStages({ queryText: 'q', indexName: 'i', limit: 1 })

    expect(vector).not.toContainEqual({ $set: { score: { $meta: 'searchScore' } } })
    expect(text).not.toContainEqual({ $set: { score: { $meta: 'vectorSearchScore' } } })
  })
})

/** Limit, factor and the product the server is sent. */
const PRODUCTS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 10, 10],
  [5, 10, 50],
  [10, 10, 100],
  [10, 1, 10],
  [100, 100, 10_000],
]

/** Limit and factor whose product is above the server's ceiling. */
const ABOVE_THE_CEILING: ReadonlyArray<readonly [number, number]> = [
  [1001, 10],
  [10_001, 1],
  [100, 101],
  [1, 10_001],
]

/** Limits that are not a positive integer, which the server would refuse or which mean nothing. */
const BAD_LIMITS: readonly number[] = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]

/** Factors that are not a positive integer. */
const BAD_FACTORS: readonly number[] = [0, -1, 1.5, Number.NaN]

describe('TS-104 — the candidate count and its two server bounds', () => {
  it.each(PRODUCTS)('TS-104 — limit %d at factor %d gives %d', (limit, factor, expected) => {
    expect(candidateCount(limit, factor)).toBe(expected)
  })

  it('TS-104 — the count scales with the limit', () => {
    expect(candidateCount(20, 10)).toBe(2 * candidateCount(10, 10))
  })

  it('TS-104 — the default factor is the documented one, and it reaches the stage', () => {
    expect(candidateCount(7)).toBe(7 * DEFAULT_OVERSAMPLING_FACTOR)
    const stage = vectorSearch(vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 7, queryVector: VECTOR }))

    expect(stage.numCandidates).toBe(7 * DEFAULT_OVERSAMPLING_FACTOR)
  })

  it('TS-104 — a configured factor reaches the stage', () => {
    const stage = vectorSearch(
      vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 7, queryVector: VECTOR, oversamplingFactor: 3 }),
    )

    expect(stage.numCandidates).toBe(21)
  })

  it.each(ABOVE_THE_CEILING)('TS-104 — limit %d at factor %d is above the ceiling and throws', (limit, factor) => {
    const error = thrownBy(() => candidateCount(limit, factor))

    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toBe(
      `strands_mongodb: numCandidates would be ${limit * factor}, and the server requires a value within ` +
        `bounds [1..10000]. It is derived as limit (${limit}) times 'oversamplingFactor' (${factor}), so lower ` +
        'whichever of the two you can afford to: the limit costs you results, the factor costs you recall.',
    )
  })

  it('TS-104 — the ceiling itself is accepted', () => {
    expect(candidateCount(1000, 10)).toBe(MAX_NUM_CANDIDATES)
  })

  it.each(BAD_FACTORS)('TS-104 — a factor of %d is rejected with a RangeError naming it', (factor) => {
    const error = thrownBy(() => candidateCount(5, factor))

    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toContain(`'oversamplingFactor' is ${factor}`)
  })

  it.each(BAD_LIMITS)('TS-104 — a limit of %d is rejected with a RangeError naming the limit', (limit) => {
    const error = thrownBy(() => candidateCount(limit, 10))

    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toContain(`'limit' is ${limit}`)
  })

  it('TS-104 — a limit above the candidate count is rejected where the two meet', () => {
    const error = thrownBy(() => checkCandidateCount({ limit: 5, numCandidates: 4 }))

    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toBe(
      'strands_mongodb: limit (5) is greater than numCandidates (4), and the server requires limit <= ' +
        "numCandidates. Raise 'oversamplingFactor' or lower the limit.",
    )
  })

  it('TS-104 — a limit equal to the candidate count is accepted, so the bound is <=', () => {
    expect(() => checkCandidateCount({ limit: 5, numCandidates: 5 })).not.toThrow()
  })

  it('TS-104 — the vector tier refuses what candidateCount refuses, before building anything', () => {
    expect(() => vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1001, queryVector: VECTOR })).toThrow(
      RangeError,
    )
    expect(() =>
      vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5, queryVector: VECTOR, oversamplingFactor: 0 }),
    ).toThrow(RangeError)
  })
})

describe('TS-105 — the full-text stages run $search, $match, $set, $limit, in that order', () => {
  it('TS-105 — the stages are $search, $match, $set, $limit', () => {
    const stages = textStages({
      queryText: 'dark mode',
      indexName: 'text_index',
      limit: 5,
      queryFilter: { scope: 's' },
    })

    expect(names(stages)).toEqual(['$search', '$match', '$set', '$limit'])
  })

  it('TS-105 — the $limit is the last stage, after the $match', () => {
    const order = names(textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: { scope: 's' } }))

    expect(order.indexOf('$limit')).toBe(order.length - 1)
    expect(order.indexOf('$limit')).toBeGreaterThan(order.indexOf('$match'))
  })

  it('TS-105 — nothing bounds the result set before the $match', () => {
    const order = names(textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: { scope: 's' } }))

    expect(order.slice(0, order.indexOf('$match'))).toEqual(['$search'])
  })

  it('TS-105 — a query with no filter, or an empty one, has no $match', () => {
    expect(names(textStages({ queryText: 'q', indexName: 'i', limit: 5 }))).toEqual(['$search', '$set', '$limit'])
    expect(names(textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: {} }))).toEqual([
      '$search',
      '$set',
      '$limit',
    ])
  })

  it('TS-105 — the $search stage names the index and the content field, key order included', () => {
    const stages = textStages({ queryText: 'dark mode', indexName: 'text_index', limit: 5 })
    const expected = { $search: { index: 'text_index', text: { query: 'dark mode', path: CONTENT_FIELD } } }

    expect(stages[0]).toEqual(expected)
    expect(JSON.stringify(stages[0])).toBe(JSON.stringify(expected))
  })

  it.each(BAD_LIMITS)('TS-105 — a limit of %d is rejected, as on the vector tier', (limit) => {
    // Python's builder drops the `$limit` for a limit of 0 and sends a non-integer one. Both are refused here.
    expect(() => textStages({ queryText: 'q', indexName: 'i', limit })).toThrow(RangeError)
  })
})

describe('TS-106 — the filter is a pre-filter for vector and a post-filter for text', () => {
  it('TS-106 — the vector filter goes inside the stage, after the limit', () => {
    const stages = vectorStages({
      mode: MANUAL_MODE,
      indexName: 'i',
      limit: 5,
      queryVector: VECTOR,
      queryFilter: { scope: 's' },
    })

    expect(vectorSearch(stages).filter).toEqual({ scope: 's' })
    expect(Object.keys(vectorSearch(stages))).toEqual([
      'index',
      'path',
      'queryVector',
      'numCandidates',
      'limit',
      'filter',
    ])
  })

  it('TS-106 — the autoembed filter follows the model', () => {
    const stages = vectorStages({
      mode: AUTO_EMBED_MODE,
      indexName: 'i',
      limit: 5,
      queryText: 'q',
      queryFilter: { a: 1 },
    })

    expect(Object.keys(vectorSearch(stages))).toEqual([
      'index',
      'path',
      'query',
      'numCandidates',
      'limit',
      'model',
      'filter',
    ])
  })

  it('TS-106 — the text filter goes in a $match stage and not in $search', () => {
    const stages = textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: { scope: 's' } })

    expect(stages[1]).toEqual({ $match: { scope: 's' } })
    expect((stages[0] as { $search: object }).$search).not.toHaveProperty('filter')
  })

  it('TS-106 — an empty filter is omitted from the vector stage', () => {
    const stages = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5, queryVector: VECTOR, queryFilter: {} })

    expect(vectorSearch(stages)).not.toHaveProperty('filter')
  })

  it("TS-106 — the stage holds a copy of the caller's filter", () => {
    const filter: Record<string, unknown> = { scope: 's' }
    const vector = vectorStages({
      mode: MANUAL_MODE,
      indexName: 'i',
      limit: 5,
      queryVector: VECTOR,
      queryFilter: filter,
    })
    const text = textStages({ queryText: 'q', indexName: 'i', limit: 5, queryFilter: filter })

    filter.scope = 'other'

    expect(vectorSearch(vector).filter).toEqual({ scope: 's' })
    expect(text[1]).toEqual({ $match: { scope: 's' } })
  })
})

/** A hybrid pipeline with both tiers answerable, overriding one option at a time. */
const hybrid = (overrides: Partial<HybridStagesOptions> = {}): Stage[] =>
  hybridStages({
    mode: MANUAL_MODE,
    vectorIndexName: 'vi',
    textIndexName: 'ti',
    queryText: 'q',
    queryVector: VECTOR,
    limit: 5,
    ...overrides,
  })

/** The input pipelines of a hybrid pipeline's `$rankFusion`. */
const inputPipelines = (stages: readonly Stage[]): Record<string, Stage[]> =>
  (stages[0] as { $rankFusion: { input: { pipelines: Record<string, Stage[]> } } }).$rankFusion.input.pipelines

describe('TS-107 — the hybrid tier is one native $rankFusion stage', () => {
  it('TS-107 — the fusion is one stage, plus the score projection the server does not do', () => {
    const stages = hybrid()

    expect(names(stages)).toEqual(['$rankFusion', '$set', '$limit'])
    expect(stages[1]).toEqual({ $set: { score: { $meta: 'score' } } })
  })

  it('TS-107 — the fused list is capped at the limit', () => {
    // AT-225: each input returns up to `limit`, and the fusion returns their union.
    expect(hybrid({ limit: 7 }).at(-1)).toEqual({ $limit: 7 })
  })

  it("TS-107 — the outer projection uses neither tier's score name", () => {
    const serialized = JSON.stringify(hybrid())

    expect(serialized).not.toContain('vectorSearchScore')
    expect(serialized).not.toContain('searchScore')
  })

  it('TS-107 — the two tiers arrive as input pipelines named vector and text', () => {
    expect(Object.keys(inputPipelines(hybrid()))).toEqual(['vector', 'text'])
  })

  it('TS-107 — the score projection is outside the fusion and in neither input pipeline', () => {
    const stages = hybrid()

    expect(names(stages)).toContain('$set')
    for (const [name, branch] of Object.entries(inputPipelines(stages))) {
      expect(names(branch), name).not.toContain('$set')
    }
  })

  it('TS-107 — no $unionWith reaches the server on this path', () => {
    expect(JSON.stringify(hybrid())).not.toContain('$unionWith')
  })

  it('TS-107 — the input pipelines are the single-tier builders called without a score', () => {
    const pipelines = inputPipelines(hybrid({ queryFilter: { scope: 's' } }))

    expect(pipelines.vector).toEqual(
      vectorStages({
        mode: MANUAL_MODE,
        indexName: 'vi',
        limit: 5,
        queryVector: VECTOR,
        queryFilter: { scope: 's' },
        score: false,
      }),
    )
    expect(pipelines.text).toEqual(
      textStages({ queryText: 'q', indexName: 'ti', limit: 5, queryFilter: { scope: 's' }, score: false }),
    )
  })

  it('TS-107 — on the AutoEmbeddings path both branches read the text', () => {
    const pipelines = inputPipelines(hybrid({ mode: AUTO_EMBED_MODE, queryVector: undefined }))

    expect(vectorSearch(pipelines.vector ?? []).query).toEqual({ text: 'q' })
  })

  it('TS-107 — the vector branch still validates its candidate count', () => {
    expect(() => hybrid({ limit: MAX_NUM_CANDIDATES })).toThrow(/numCandidates/)
  })

  it('TS-107 — a query contradicting the mode is rejected here too', () => {
    expect(() => hybrid({ mode: AUTO_EMBED_MODE })).toThrow(/'vector'/)
  })

  it('TS-107 — the vector tier keeps its score stage by default and drops only that one', () => {
    const withScore = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR })
    const without = vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 1, queryVector: VECTOR, score: false })

    expect(withScore.at(-1)).toEqual({ $set: { score: { $meta: 'vectorSearchScore' } } })
    expect(without).toEqual(withScore.slice(0, -1))
  })

  it('TS-107 — the text tier drops only its score stage, which is not its last', () => {
    const withScore = textStages({ queryText: 'q', indexName: 'i', limit: 1 })
    const without = textStages({ queryText: 'q', indexName: 'i', limit: 1, score: false })

    expect(names(withScore)).toEqual(['$search', '$set', '$limit'])
    expect(names(without)).toEqual(['$search', '$limit'])
    expect(without).toEqual(withScore.filter((stage) => !('$set' in stage)))
  })

  it('TS-107 — the text tier keeps its filter when the score goes', () => {
    const stages = textStages({ queryText: 'q', indexName: 'i', limit: 1, queryFilter: { scope: 's' }, score: false })

    expect(names(stages)).toEqual(['$search', '$match', '$limit'])
  })
})

describe('TS-108 — a query contradicting the mode is rejected before the round trip', () => {
  it("TS-108 — a text query on the manual path throws naming 'embeddingDimensions' and 'text'", () => {
    const error = thrownBy(() => vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5, queryText: 'q' }))

    expect(error.constructor).toBe(Error)
    expect(error.message).toContain('embeddingDimensions')
    expect(error.message).toContain("'text'")
  })

  it("TS-108 — a vector query on the AutoEmbeddings path throws naming 'embeddingModel' and 'vector'", () => {
    const error = thrownBy(() => vectorStages({ mode: AUTO_EMBED_MODE, indexName: 'i', limit: 5, queryVector: VECTOR }))

    expect(error.constructor).toBe(Error)
    expect(error.message).toContain('embeddingModel')
    expect(error.message).toContain("'vector'")
  })

  it('TS-108 — a query with neither text nor vector throws a TypeError', () => {
    const error = thrownBy(() => vectorStages({ mode: MANUAL_MODE, indexName: 'i', limit: 5 }))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("neither 'text' nor 'vector'")
  })

  it.each([
    ['autoembed', AUTO_EMBED_MODE],
    ['manual', MANUAL_MODE],
  ] as const)('TS-108 — both at once throws for being both, not for the mode, on %s', (_, mode) => {
    const error = thrownBy(() => vectorStages({ mode, indexName: 'i', limit: 5, queryText: 'q', queryVector: VECTOR }))

    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain("both 'text' and 'vector'")
  })

  it('TS-108 — checkQueryKeys allows both only where fusion is possible', () => {
    expect(() => checkQueryKeys({ queryText: 'q', queryVector: VECTOR })).toThrow(TypeError)
    expect(() => checkQueryKeys({ queryText: 'q', queryVector: VECTOR, fusionPossible: true })).not.toThrow()
    expect(() => checkQueryKeys({ fusionPossible: true })).toThrow(/neither/)
  })

  it('TS-108 — checkQueryKeys accepts either key alone, whatever the mode', () => {
    expect(() => checkQueryKeys({ queryText: 'q' })).not.toThrow()
    expect(() => checkQueryKeys({ queryVector: VECTOR })).not.toThrow()
  })
})
