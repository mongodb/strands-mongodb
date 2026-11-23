/**
 * The AutoEmbeddings query against a deployment that runs automated embedding: the one claim about the
 * `autoEmbed` query shape that only the server can settle.
 *
 * Ports `TestTheAutoEmbeddingsQueryAgainstADeploymentThatCanAnswerIt` from `python/tests/test_pipeline.py`.
 * AT-070i is not a checklist item, so the title leads with TS-100, the id `test/unit/pipeline.test.ts` gives
 * AT-070, the query shape this test sends.
 *
 * Gated on `MONGODB_AUTOEMBED_URI`. A deployment with no registered embedding model refuses an `autoEmbed`
 * index at creation, so this cannot run on the contract or integration tiers.
 */
import { setTimeout as sleep } from 'node:timers/promises'

import type { Document } from 'mongodb'
import { expect, it } from 'vitest'

import { ensure } from '../../src/index-lifecycle.js'
import { memorySearchSpecs, vectorMode } from '../../src/indexes.js'
import { vectorStages } from '../../src/pipeline.js'
import { CONTENT_FIELD, DEFAULT_VECTOR_INDEX_NAME, SCORE_FIELD } from '../../src/types.js'
import { useDeployment, uniqueName } from '../support/deployment.js'
import { describeTier } from '../support/tiers.js'

const QUERY_TEXT = 'dark mode'

/** How long the index may take to hold every document once it reports READY. */
const SEARCHABLE_BUDGET_MS = 180_000

describeTier('autoembed', 'TS-100 — the AutoEmbeddings query shape, against a deployment that can answer it', () => {
  const deployment = useDeployment('autoembed')

  it('TS-100 — the server accepts the stage this package emits, and scores what it returns', async () => {
    // If this fails with a query-shape error, the fix is the `query` key in `vectorStages`, with its TS-100
    // assertion in `test/unit/pipeline.test.ts`.
    const { db } = deployment()
    const collection = db.collection<Document & { _id: number }>(uniqueName('a_'))
    await collection.insertMany(
      Array.from({ length: 20 }, (_, n) => ({ _id: n, [CONTENT_FIELD]: `${QUERY_TEXT} note ${n}`, scope: 'keep' })),
    )
    const config = { database: db.databaseName }
    await ensure(db, db.collection(collection.collectionName), { search: memorySearchSpecs(config), create: true })
    const stages = vectorStages({
      mode: vectorMode({}),
      indexName: DEFAULT_VECTOR_INDEX_NAME,
      limit: 5,
      queryText: QUERY_TEXT,
      queryFilter: { scope: 'keep' },
    })

    const deadline = Date.now() + SEARCHABLE_BUDGET_MS
    let results: Document[] = []
    while (results.length === 0 && Date.now() < deadline) {
      results = await collection.aggregate(stages).toArray()
      if (results.length === 0) await sleep(500)
    }

    expect(results).toHaveLength(5)
    for (const document of results) expect(typeof document[SCORE_FIELD]).toBe('number')
  })
})
