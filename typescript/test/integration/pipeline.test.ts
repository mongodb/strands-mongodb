/**
 * The search pipelines against a deployment with `mongot`: the stage order, the server's bounds and the score
 * names, none of which a unit test can tell apart from their wrong versions.
 *
 * Ports the `integration` classes of `python/tests/test_pipeline.py`. None of these items is in the checklist,
 * so the titles lead with TS ids:
 *
 * | TS id  | Python                                                                                      |
 * |--------|---------------------------------------------------------------------------------------------|
 * | TS-109 | AT-072b, `TestTheBoundsThisPackageCopiesFromTheServer`                                      |
 * | TS-110 | AT-073, AT-073b, AT-073c, `TestTheOrderingAgainstMongot`                                    |
 * | TS-111 | AT-074 and the vector pre-filter test, `TestBothTiersAgainstMongot`                         |
 * | TS-103 | AT-070c, the crossed score name; the unit half in `test/unit/pipeline.test.ts` shares the id |
 *
 * **One deviation.** Python skips its tests when the search process is unreachable, and skips AT-073c where
 * explain does not report the requests made to `mongot`. This suite runs with no skips, so an unreachable
 * search process fails, and AT-073c asserts the weaker thing that is observable: that the limit does not change
 * what explain reports.
 *
 * Manual-vector mode throughout. An `autoEmbed` definition fails at creation on a deployment with no registered
 * model, so the AutoEmbeddings query belongs to the `autoembed` tier.
 */
import { setTimeout as sleep } from 'node:timers/promises'

import type { Collection, Db, Document } from 'mongodb'
import { MongoServerError } from 'mongodb'
import { expect, it } from 'vitest'

import { ensure } from '../../src/index-lifecycle.js'
import { memorySearchSpecs, vectorMode } from '../../src/indexes.js'
import { textStages, vectorStages } from '../../src/pipeline.js'
import {
  CONTENT_FIELD,
  DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_VECTOR_INDEX_NAME,
  MAX_NUM_CANDIDATES,
  SCORE_FIELD,
  TEXT_SCORE_META,
  VECTOR_FIELD,
  VECTOR_SCORE_META,
} from '../../src/types.js'
import { useDeployment, uniqueName } from '../support/deployment.js'
import { describeTier } from '../support/tiers.js'

/** The manual-vector config, which every deployment with `mongot` accepts. */
const MANUAL_VECTOR = { database: 'unused', embeddingDimensions: 4, similarity: 'cosine' as const }

const MANUAL_MODE = vectorMode(MANUAL_VECTOR)

const VECTOR = [1, 0, 0, 0]

/** One query for every test here, so ranking differences come from the corpus. */
const QUERY_TEXT = 'dark mode toggle'

/**
 * How long a corpus is waited on before it counts as never indexed. The corpus is seeded before the index is
 * created, so what this waits out is the initial sync, which on every deployment measured has finished by READY.
 */
const SEARCHABLE_BUDGET_MS = 90_000

/** The multipliers of AT-073b: 1x is the naive order, and 38x over-fetches 190 documents to return 5. */
const OVER_FETCH_MULTIPLIERS = [1, 2, 5, 10, 20, 38] as const

/** A test document: these carry an integer or string `_id` rather than an ObjectId. */
type Seeded = Document & { _id: number | string }

/** What explain reports about the requests an aggregation made to `mongot`. */
type PullHistory = { requests: number[] } | { first: number; requests: number } | { unobservable: string[] }

/**
 * Seed a corpus every document of which matches {@link QUERY_TEXT}, one in `inScopeEvery` in scope `keep`, and
 * build both search indexes on it.
 *
 * `rankInScopeLast` makes BM25 rank every in-scope document below every out-of-scope one, by repeating the
 * query terms in the out-of-scope documents and padding the in-scope ones. With uniform text the documents tie
 * within rounding and the order of a truncated prefix is not stable across builds.
 */
async function seedAndIndex(
  db: Db,
  options: { count: number; inScopeEvery: number; rankInScopeLast?: boolean },
): Promise<Collection<Seeded>> {
  const { count, inScopeEvery, rankInScopeLast = false } = options
  const content = (index: number, inScope: boolean): string => {
    if (!rankInScopeLast) return `${QUERY_TEXT} note number ${index}`
    if (inScope) return `${QUERY_TEXT} ${Array.from({ length: 60 }, (_, n) => `padding${n}`).join(' ')}`
    return Array.from({ length: 5 }, () => QUERY_TEXT).join(' ')
  }
  const collection = db.collection<Seeded>(uniqueName('p_'))
  await collection.insertMany(
    Array.from({ length: count }, (_, index) => {
      const inScope = index % inScopeEvery === 0
      return {
        _id: index,
        [CONTENT_FIELD]: content(index, inScope),
        scope: inScope ? 'keep' : 'drop',
        // Aligned with VECTOR on the first axis and separated on the second, so cosine orders them by index.
        [VECTOR_FIELD]: [1, index / count, 0, 0],
      }
    }),
  )
  await ensure(db, db.collection(collection.collectionName), { search: memorySearchSpecs(MANUAL_VECTOR) })
  return collection
}

/** Run `pipeline` until `mongot` answers it, since READY means the index exists, not that it holds every document. */
async function untilAnswered(collection: Collection<Seeded>, pipeline: Document[]): Promise<Document[]> {
  const deadline = Date.now() + SEARCHABLE_BUDGET_MS
  for (;;) {
    const results = await collection.aggregate(pipeline).toArray()
    if (results.length > 0 || Date.now() >= deadline) return results
    await sleep(500)
  }
}

/** The error `pipeline` is rejected with. */
async function rejection(collection: Collection<Seeded>, pipeline: Document[]): Promise<MongoServerError> {
  const error: unknown = await collection
    .aggregate(pipeline)
    .toArray()
    .then(
      () => undefined,
      (caught: unknown) => caught,
    )
  expect(error).toBeInstanceOf(MongoServerError)
  return error as MongoServerError
}

/** A bare `$vectorSearch` on an index that does not exist, so a failure is the bound rather than the lookup. */
function absentIndexStage(numCandidates: number, limit: number): Document[] {
  return [{ $vectorSearch: { index: 'absent_index', path: VECTOR_FIELD, queryVector: VECTOR, numCandidates, limit } }]
}

/** Each document's field names, sorted, as one comparable string per document. */
function shapes(documents: Document[]): Set<string> {
  return new Set(documents.map((document) => Object.keys(document).sort().join(',')))
}

describeTier('integration', 'TS-109 — the bounds this package copies from the server', () => {
  const deployment = useDeployment('integration')

  // Marked integration rather than contract: a plain mongod answers both with code 31082, search not configured.
  it('TS-109 — the numCandidates ceiling is the ceiling the server enforces', async () => {
    const collection = deployment().db.collection<Seeded>(uniqueName('b_'))
    await collection.insertOne({ _id: 'seed' })

    const error = await rejection(collection, absentIndexStage(MAX_NUM_CANDIDATES + 1, 1))

    expect(error.message).toContain(`[1..${MAX_NUM_CANDIDATES}]`)
  })

  it('TS-109 — a non-positive limit is the error the message describes', async () => {
    // 7912700 on 8.0 and 65137 on 9.0.
    const collection = deployment().db.collection<Seeded>(uniqueName('b_'))
    await collection.insertOne({ _id: 'seed' })

    const error = await rejection(collection, absentIndexStage(10, 0))

    expect([7912700, 65137]).toContain(error.code)
  })
})

describeTier('integration', 'TS-110 — the full-text stage order against mongot', () => {
  const deployment = useDeployment('integration')
  const keepFive = (limit = 5): Document[] =>
    textStages({ queryText: QUERY_TEXT, indexName: DEFAULT_TEXT_INDEX_NAME, limit, queryFilter: { scope: 'keep' } })

  it('TS-110 — the emitted order returns the requested count: 200 match, 10 in scope, 5 asked for', async () => {
    const collection = await seedAndIndex(deployment().db, { count: 200, inScopeEvery: 20 })

    const results = await untilAnswered(collection, keepFive())

    expect(results).toHaveLength(5)
    expect(new Set(results.map((document) => document.scope))).toEqual(new Set(['keep']))
  })

  it('TS-110 — no bound ahead of the $match below the corpus size fills the limit', async () => {
    // The smallest bound that fills it is 200, the corpus size, which is not known when the stage is built.
    const collection = await seedAndIndex(deployment().db, { count: 200, inScopeEvery: 20, rankInScopeLast: true })
    const emitted = keepFive()
    const boundedAt = async (size: number): Promise<number> =>
      (
        await collection
          .aggregate([...emitted.slice(0, 1), { $limit: size }, { $match: { scope: 'keep' } }, { $limit: 5 }])
          .toArray()
      ).length

    expect(await untilAnswered(collection, emitted)).toHaveLength(5)
    const returned: Record<number, number> = {}
    for (const multiplier of OVER_FETCH_MULTIPLIERS) returned[multiplier] = await boundedAt(5 * multiplier)
    expect(returned).toEqual(Object.fromEntries(OVER_FETCH_MULTIPLIERS.map((multiplier) => [multiplier, 0])))
    expect(await boundedAt(200)).toBe(5)
  })

  it('TS-110 — the cost of not bounding early tracks the filter and not the limit', async () => {
    // 8.0's $_internalSearchMongotRemote lists every request size: 101, then 1.5x. 9.0 runs search under
    // $_internalDocumentResultsAndMetadata and reports the first size and the count. Atlas 8.0.30 reports
    // neither, and there the assertion left is that both limits explain identically.
    const db = deployment().db
    const collection = await seedAndIndex(db, { count: 200, inScopeEvery: 20, rankInScopeLast: true })

    const history = async (limit: number): Promise<PullHistory> => {
      const stages = keepFive(limit)
      await untilAnswered(collection, stages)
      const explained = await db.command({
        explain: { aggregate: collection.collectionName, pipeline: stages, cursor: {} },
        verbosity: 'executionStats',
      })
      for (const stage of explained.stages as Document[]) {
        const remote = stage.$_internalSearchMongotRemote as Document | undefined
        if (remote !== undefined) {
          const sizes = remote.internalMongotBatchSizeHistory as number[] | undefined
          return sizes === undefined ? { unobservable: Object.keys(remote).sort() } : { requests: [...sizes] }
        }
        const extension = stage.$_internalDocumentResultsAndMetadata as Document | undefined
        if (extension !== undefined) {
          const search = extension.source.$search.explain as Document
          return { first: search.metadata.cursorOptions.batchSize, requests: search.resourceUsage.numBatches }
        }
      }
      throw new Error(`no search stage in ${JSON.stringify((explained.stages as Document[]).map(Object.keys))}`)
    }

    const forOne = await history(1)
    const forFifty = await history(50)

    expect(forOne, 'the limit changed what was pulled from mongot').toEqual(forFifty)
    if (!('unobservable' in forOne))
      expect([{ requests: [101, 152] }, { first: 108, requests: 2 }]).toContainEqual(forOne)
  })
})

describeTier('integration', 'TS-111 — the vector tier against mongot', () => {
  const deployment = useDeployment('integration')

  it('TS-111 — a precomputed embedding returns the same shape as the text path', async () => {
    // AT-074 is about parity, so the two paths are compared: the same fields, and a numeric score on both.
    const collection = await seedAndIndex(deployment().db, { count: 50, inScopeEvery: 5 })
    const vector = vectorStages({
      mode: MANUAL_MODE,
      indexName: DEFAULT_VECTOR_INDEX_NAME,
      limit: 5,
      queryVector: VECTOR,
      queryFilter: { scope: 'keep' },
    })
    const text = textStages({
      queryText: QUERY_TEXT,
      indexName: DEFAULT_TEXT_INDEX_NAME,
      limit: 5,
      queryFilter: { scope: 'keep' },
    })

    const fromVector = await untilAnswered(collection, vector)
    const fromText = await untilAnswered(collection, text)

    expect(fromVector).toHaveLength(5)
    expect(fromText).toHaveLength(5)
    expect(shapes(fromVector)).toEqual(shapes(fromText))
    for (const document of [...fromVector, ...fromText]) expect(typeof document[SCORE_FIELD]).toBe('number')
  })

  it('TS-111 — the vector filter is a pre-filter, so the limit fills with no $limit stage', async () => {
    const collection = await seedAndIndex(deployment().db, { count: 200, inScopeEvery: 20 })
    const stages = vectorStages({
      mode: MANUAL_MODE,
      indexName: DEFAULT_VECTOR_INDEX_NAME,
      limit: 5,
      queryVector: VECTOR,
      queryFilter: { scope: 'keep' },
    })

    const results = await untilAnswered(collection, stages)

    expect(results).toHaveLength(5)
    expect(new Set(results.map((document) => document.scope))).toEqual(new Set(['keep']))
    expect(stages.map((stage) => Object.keys(stage)[0])).toEqual(['$vectorSearch', '$set'])
  })
})

/** The tier, and the score name that belongs to the other one. */
const CROSSED_SCORES = [
  ['vector', TEXT_SCORE_META],
  ['text', VECTOR_SCORE_META],
] as const

describeTier('integration', 'TS-103 — a crossed score name never yields a usable score', () => {
  const deployment = useDeployment('integration')

  // Measured: mongot 8.3.8 refuses the pipeline, and Atlas 8.0.30 returns documents with no score at all.
  // Neither produces a score a caller could mistake for a real one, which is what is asserted.
  it.each(CROSSED_SCORES)('TS-103 — the %s tier with the other tier’s score name', async (tier, crossedMeta) => {
    const collection = await seedAndIndex(deployment().db, { count: 20, inScopeEvery: 2 })
    const good =
      tier === 'vector'
        ? vectorStages({ mode: MANUAL_MODE, indexName: DEFAULT_VECTOR_INDEX_NAME, limit: 3, queryVector: VECTOR })
        : textStages({ queryText: QUERY_TEXT, indexName: DEFAULT_TEXT_INDEX_NAME, limit: 3 })
    const answered = await untilAnswered(collection, good)
    expect(answered.length).toBeGreaterThan(0)
    for (const document of answered) expect(typeof document[SCORE_FIELD]).toBe('number')

    const crossed = [...good.slice(0, 1), { $set: { [SCORE_FIELD]: { $meta: crossedMeta } } }]
    const outcome = await collection
      .aggregate(crossed)
      .toArray()
      .then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      )

    if ('error' in outcome) {
      expect(outcome.error).toBeInstanceOf(MongoServerError)
      expect(String((outcome.error as Error).message)).toContain('score metadata, but it is not available')
    } else {
      expect(outcome.results.length, 'the crossed pipeline answered nothing, so it proves nothing').toBeGreaterThan(0)
      for (const document of outcome.results) expect(document[SCORE_FIELD]).toBeUndefined()
    }
  })
})
