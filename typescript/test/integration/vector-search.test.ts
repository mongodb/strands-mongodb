/**
 * `MongoDBVectorSearchStrategy` against a deployment with `mongot`: the only place the prefix pre-filter and
 * the score can be observed.
 *
 * Ports `TestVectorSearchAgainstAtlas` from `python/tests/test_vector_search.py`. AT-241 is not a checklist
 * item, so every title leads with TS-094. One test has no Python counterpart: that the server holds the vector
 * as doubles and the ancestors as written, which is what lets a Python store read the same document.
 *
 * The vectors are computed here, by a bag-of-words embedder, so no embedding service is needed. The index is
 * the manual-vector kind, which every deployment with `mongot` accepts.
 */
import { setTimeout as sleep } from 'node:timers/promises'

import type { StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { MongoDBStorage } from '../../src/storage.js'
import { MongoDBVectorSearchStrategy } from '../../src/vector-search.js'
import { useDeployment, uniqueName } from '../support/deployment.js'
import { describeTier, tierValue } from '../support/tiers.js'

const VOCABULARY = ['dark', 'mode', 'coffee', 'tea'] as const

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** One dimension per word in {@link VOCABULARY}, plus a floor so no vector is zero. */
const bagOfWords = {
  async embed(text: string): Promise<number[]> {
    const words = text.toLowerCase().split(/\s+/)
    return VOCABULARY.map((word) => 0.01 + words.filter((found) => found === word).length)
  },
}

/** Poll `search` until `until` holds. `mongot` indexes a write asynchronously, so one read can miss it. */
async function eventually(
  search: () => Promise<StorageSearchResult[]>,
  until: (found: StorageSearchResult[]) => boolean,
  timeoutMs = 60_000,
): Promise<StorageSearchResult[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await search()
    if (until(found) || Date.now() > deadline) return found
    await sleep(500)
  }
}

describeTier('integration', 'TS-094 — nearest first, scoped to the prefix, and gone once deleted', () => {
  const deployment = useDeployment('integration')
  let storage: MongoDBStorage

  // A store in this test's own collection, its index built and queryable, as Python's `vector_storage`.
  beforeEach(async () => {
    storage = new MongoDBStorage(
      { database: deployment().db.databaseName, connectionString: tierValue('integration') },
      {
        collection: uniqueName('v_'),
        searchStrategy: new MongoDBVectorSearchStrategy({ embedder: bagOfWords, dimensions: 4, similarity: 'cosine' }),
      },
    )
    await storage.write('seed', bytes('tea'))
    await storage.ensureIndexes()
    await storage.delete('seed')
  })

  afterEach(async () => {
    await storage.close()
  })

  it('TS-094 — the nearest value ranks first, with its payload', async () => {
    await storage.write('notes/ui.md', bytes('dark mode'))
    await storage.write('notes/drinks.md', bytes('coffee tea'))

    const found = await eventually(
      () => storage.search('dark'),
      (results) => results.length === 2,
    )

    expect(found.map((result) => result.key)).toEqual(['notes/ui.md', 'notes/drinks.md'])
    expect(found[0]?.data).toEqual(bytes('dark mode'))
    expect(found[0]?.data?.constructor).toBe(Uint8Array)
    const [first, second] = found.map((result) => result.score)
    expect(first).toBeGreaterThan(second as number)
    expect(second).toBeGreaterThan(0)
  })

  it('TS-094 — a namespace sees only its own keys', async () => {
    const tenantA = storage.namespace('tenant-a')
    await tenantA.write('notes/ui.md', bytes('dark mode'))
    await storage.namespace('tenant-b').write('notes/ui.md', bytes('dark mode'))
    await eventually(
      () => storage.search('dark'),
      (results) => results.length === 2,
    )

    const found = await tenantA.search('dark')

    expect(found.map((result) => result.key)).toEqual(['notes/ui.md'])
  })

  it('TS-094 — a deleted or emptied value stops matching', async () => {
    await storage.write('gone', bytes('dark'))
    await storage.write('emptied', bytes('dark'))
    await eventually(
      () => storage.search('dark'),
      (results) => results.length === 2,
    )

    await storage.delete('gone')
    await storage.write('emptied', new Uint8Array())

    const found = await eventually(
      () => storage.search('dark'),
      (results) => results.length === 0,
    )
    expect(found).toEqual([])
  })

  it('TS-094 — the server holds every component as a double and the ancestors as written', async () => {
    // `1.01` would be a double anyway. A component of exactly 1 is what the driver alone would send as an int32.
    const integral = new MongoDBStorage(
      { database: deployment().db.databaseName, connectionString: tierValue('integration') },
      {
        collection: storage.collectionName,
        prefix: 'tenant-a',
        searchStrategy: new MongoDBVectorSearchStrategy({
          embedder: { embed: async () => [1, 0, 2, 3] },
          dimensions: 4,
          similarity: 'cosine',
        }),
      },
    )
    try {
      await integral.write('notes/ui.md', bytes('dark mode'))
    } finally {
      await integral.close()
    }

    const [stored] = await deployment()
      .db.collection(storage.collectionName)
      .aggregate([
        { $match: { _id: 'tenant-a/notes/ui.md' } },
        { $project: { types: { $map: { input: '$embedding', in: { $type: '$$this' } } }, prefixes: 1 } },
      ])
      .toArray()

    expect(stored).toEqual({
      _id: 'tenant-a/notes/ui.md',
      types: ['double', 'double', 'double', 'double'],
      prefixes: ['tenant-a/', 'tenant-a/notes/'],
    })
  })
})
