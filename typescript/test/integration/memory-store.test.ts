/**
 * `MongoDBMemoryStore` against a deployment with `mongot`: the round trip from `add` through the search index
 * to the `MemoryEntry` the SDK formats, which no tier below can see.
 *
 * Ports the integration classes of `python/tests/test_memory_store.py`. The checklist ids are used as they
 * are. The rest lead with `TS-` ids, the unit tier's where there is a unit half: AT-242 is TS-126 and AT-243
 * TS-137, and AT-048b shares TS-140 with its contract half, AT-048a. The ids with no other half are new:
 * AT-143 is TS-147, AT-059b TS-148 and AT-053b TS-149.
 *
 * **Written to hold on any deployment with `mongot`.** Python skips the AT-053b and AT-054 text halves where
 * the deployment has a registered embedding model, and AT-143 below MongoDB 8.0. This suite branches instead,
 * on the tier that actually ran or the version the server reports, and asserts the half that applies. A test
 * that cannot hold either way fails; nothing skips.
 *
 * The default store here is the shipped default: the automated-embedding path under `searchType: 'auto'`. On
 * a deployment with no registered model its vector index is refused and it answers from the text tier.
 */
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import type { MemoryEntry } from '@strands-agents/sdk'
import { Double } from 'mongodb'
import type { Collection, Document } from 'mongodb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import * as lifecycle from '../../src/index-lifecycle.js'
import { memoryInternals, MongoDBMemoryStore } from '../../src/memory-store.js'
import { configureLogging, logger as currentLogger } from '../../src/telemetry.js'
import type { MongoDBConfig, MongoDBMemoryStoreConfig, MongoDBSearchQuery } from '../../src/types.js'
import { RANK_FUSION_PENALTY, RESERVED_METADATA_KEYS, UNSCOPED } from '../../src/types.js'
import { type Deployment, useDeployment, uniqueName } from '../support/deployment.js'
import { describeTier, tierValue } from '../support/tiers.js'

// A pass-through, so the shared-wait test can count the waits. Every call still reaches the real function.
vi.mock('../../src/index-lifecycle.js', async (original) => {
  const actual = await original<typeof import('../../src/index-lifecycle.js')>()
  return { ...actual, ensure: vi.fn(actual.ensure) }
})

const QUERY_TEXT = 'dark mode'
const QUERY_VECTOR = [1.0, 0.0, 0.0, 0.0]

/** The manual-vector connection keys, which need nothing from the deployment's embedding-model registry. */
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const

/** How long a written document may take to become searchable, index build included. */
const SEARCHABLE_BUDGET_MS = 180_000

/** How far one document's score may move between two identical queries. Python's `_SCORE_DRIFT`. */
const SCORE_DRIFT = 1e-3

/** A search, repeated until `expected` results arrive or the budget runs out. Python's `_answered`. */
async function answered(
  store: MongoDBMemoryStore,
  query: string | MongoDBSearchQuery,
  expected = 1,
): Promise<MemoryEntry[]> {
  const deadline = Date.now() + SEARCHABLE_BUDGET_MS
  for (;;) {
    const found = await store.search(query)
    if (found.length >= expected || Date.now() > deadline) return found
    await sleep(500)
  }
}

/** An entry's metadata, which every entry this store returns carries. */
function metadata(entry: MemoryEntry | undefined): Record<string, unknown> {
  expect(entry?.metadata).toBeDefined()
  return entry?.metadata as Record<string, unknown>
}

/**
 * Write documents with vectors directly, as Python's `_seed_vectors` does, so a manual-vector store has
 * something to read without an embedder. Vectors go out as doubles, the BSON type Python writes.
 */
async function seedVectors(
  collection: Collection,
  scope: string,
  facts: Readonly<Record<string, number[]>>,
  storeName = 'facts',
): Promise<void> {
  const now = new Date()
  await collection.insertMany(
    Object.entries(facts).map(([content, vector]) => ({
      content,
      embedding: vector.map((value) => new Double(value)),
      scope,
      store_name: storeName,
      content_hash: createHash('sha256').update(content).digest('hex'),
      created_at: now,
    })),
  )
}

type StoreOptions = Partial<Omit<MongoDBMemoryStoreConfig, 'config'>> & { config?: Partial<MongoDBConfig> }

/** Stores on one collection per test, closed after every test. */
function useStores(deployment: () => Deployment): {
  store: (options?: StoreOptions) => MongoDBMemoryStore
  raw: () => Collection
} {
  const opened: MongoDBMemoryStore[] = []
  let collection = ''
  beforeEach(() => {
    collection = uniqueName('m_')
  })
  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close()
  })
  return {
    store: ({ config = {}, ...options } = {}) => {
      const connection: MongoDBConfig = {
        database: deployment().db.databaseName,
        connectionString: tierValue('integration'),
        ...config,
      }
      const store = new MongoDBMemoryStore({ name: 'facts', collection, ...options, config: connection })
      opened.push(store)
      return store
    },
    raw: () => deployment().db.collection(collection),
  }
}

/** Every record logged while `run` runs, as `level message`. */
async function logged(run: () => Promise<void>): Promise<{ level: string; message: string }[]> {
  const records: { level: string; message: string }[] = []
  const keep =
    (level: string) =>
    (_fields: unknown, message?: unknown): void => {
      records.push({ level, message: String(message) })
    }
  const original = currentLogger
  configureLogging({ debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') })
  try {
    await run()
  } finally {
    configureLogging(original)
  }
  return records
}

describeTier('integration', 'AT-040 — the MemoryEntry a search hands back', () => {
  const deployment = useDeployment('integration')
  const { store } = useStores(deployment)

  it('AT-040 — a search returns entries carrying the four reserved keys beside caller metadata', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('the user prefers dark mode', { source: 'chat' })

    const results = await answered(target, QUERY_TEXT)

    expect(results, 'the corpus never became searchable').not.toEqual([])
    const entry = results[0]
    expect(entry?.content).toBe('the user prefers dark mode')
    expect(entry?.storeName).toBe('facts')
    const found = metadata(entry)
    expect(found._id).toBeTruthy()
    expect(found._scope).toBe('tenant-a')
    expect(['vector', 'text', 'hybrid']).toContain(found._search_type)
    expect(typeof found._relevance_score).toBe('number')
    expect(found.source).toBe('chat')
  })

  it('AT-040 — every reserved key is on every entry, not only the first', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    for (const fact of ['dark mode is preferred', 'dark mode at night', 'dark mode everywhere']) await target.add(fact)

    const results = await answered(target, QUERY_TEXT, 3)

    expect(results).toHaveLength(3)
    for (const entry of results) {
      expect(Object.keys(metadata(entry))).toEqual(expect.arrayContaining([...RESERVED_METADATA_KEYS]))
    }
  })
})

describeTier('integration', 'AT-045b — the first search sets itself up', () => {
  const deployment = useDeployment('integration')
  const { store, raw } = useStores(deployment)

  it('AT-045b — searching a store nobody initialized returns results', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('the user prefers dark mode')

    const results = await answered(target, QUERY_TEXT)

    expect(results.map((entry) => entry.content)).toEqual(['the user prefers dark mode'])
    expect(await raw().listSearchIndexes().toArray(), 'a search answered, so a search index exists').not.toEqual([])
  })
})

describeTier('integration', 'TS-126 — concurrent first searches share one wait, against a real build', () => {
  const deployment = useDeployment('integration')
  const { store } = useStores(deployment)

  it('TS-126 — they all answer, and each index is waited on once', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('the user prefers dark mode')
    expect(memoryInternals.state(target).tiers, "a fresh store's indexes are still building").toEqual([])
    const ensure = vi.mocked(lifecycle.ensure)
    ensure.mockClear()
    const waited = (): string[] =>
      ensure.mock.calls.flatMap(([, , options]) =>
        (options?.timeoutMs ?? 0) > 0 && options?.search !== undefined ? options.search.map((spec) => spec.name) : [],
      )
    const batch = (): Promise<MemoryEntry[][]> =>
      Promise.all(Array.from({ length: 5 }, () => target.search(QUERY_TEXT)))

    let results = await batch()
    const specs = waited()
    expect(new Set(specs).size).toBe(specs.length)
    expect(specs.length).toBeGreaterThan(0)

    // READY does not mean mongot has the document yet, so the batch repeats until it does.
    const deadline = Date.now() + SEARCHABLE_BUDGET_MS
    while (!results.every((found) => found.length > 0) && Date.now() < deadline) {
      await sleep(500)
      results = await batch()
    }

    expect(results.map((found) => found.map((entry) => entry.content))).toEqual(
      Array.from({ length: 5 }, () => ['the user prefers dark mode']),
    )
    expect(waited(), 'searches after the first batch do not wait again').toEqual(specs)
  })
})

describeTier('integration', 'AT-047a — no search crosses a scope, on either tier', () => {
  const deployment = useDeployment('integration')
  const { store, raw } = useStores(deployment)

  it('AT-047a — the text tier never returns another scope’s document', async () => {
    const stores = ['tenant-a', 'tenant-b'].map((scope) =>
      store({ writable: true, scope, config: { searchType: 'text' } }),
    )
    const [a, b] = stores as [MongoDBMemoryStore, MongoDBMemoryStore]
    await a.add('dark mode for tenant a')
    await b.add('dark mode for tenant b')

    for (const [target, expected] of [
      [a, 'dark mode for tenant a'],
      [b, 'dark mode for tenant b'],
    ] as const) {
      const results = await answered(target, QUERY_TEXT)
      expect(results.map((entry) => entry.content)).toEqual([expected])
      expect(new Set(results.map((entry) => metadata(entry)._scope))).toEqual(new Set([target.scope]))
    }
  })

  it('AT-047a — the vector tier never returns another scope’s document, even a nearer one', async () => {
    await seedVectors(raw(), 'tenant-a', { 'dark mode for tenant a': [0.9, 0.1, 0.0, 0.0] })
    await seedVectors(raw(), 'tenant-b', { 'dark mode for tenant b': QUERY_VECTOR })
    const target = store({ scope: 'tenant-a', config: { ...MANUAL_VECTOR, searchType: 'vector' } })

    const results = await answered(target, { vector: QUERY_VECTOR, limit: 10 })

    expect(results.map((entry) => entry.content)).toEqual(['dark mode for tenant a'])
    expect(metadata(results[0])._search_type).toBe('vector')
  })
})

/** Four documents on which the two tiers disagree, so the fused winner is neither tier's. Python's `_FUSION_CORPUS`. */
const FUSION_CORPUS: Readonly<Record<string, number[]>> = {
  'the user prefers a dim interface at night': [1.0, 0.0, 0.0, 0.0],
  'dark mode': [0.9, 0.44, 0.0, 0.0],
  'dark mode is the setting the user prefers': [0.7, 0.71, 0.0, 0.0],
  'dark mode dark mode dark mode, in dark mode': [0.2, 0.98, 0.0, 0.0],
}

/** How many of the corpus the text tier can return: the paraphrase holds neither query term. */
const FUSION_TEXT_MATCHES = Object.keys(FUSION_CORPUS).filter((content) => content.includes(QUERY_TEXT)).length

/** Reciprocal rank fusion of measured orders, as `$rankFusion` computes it with equal weights. */
function fuse(...orders: string[][]): string[] {
  const scores = new Map<string, number>()
  for (const order of orders) {
    order.forEach((content, index) => {
      scores.set(content, (scores.get(content) ?? 0) + 1 / (RANK_FUSION_PENALTY + index + 1))
    })
  }
  return [...scores.keys()].sort((a, b) => (scores.get(b) as number) - (scores.get(a) as number) || (a < b ? -1 : 1))
}

describeTier('integration', 'TS-147 — fusion ranks what neither tier ranks first', () => {
  const deployment = useDeployment('integration')
  const { store, raw } = useStores(deployment)

  it('TS-147 — the fused order is RRF of the two tiers it composed, on the fused scale', async () => {
    await seedVectors(raw(), 'tenant-a', FUSION_CORPUS)
    const [vector, text, hybrid] = (['vector', 'text', 'hybrid'] as const).map((searchType) =>
      store({ scope: 'tenant-a', config: { ...MANUAL_VECTOR, searchType } }),
    ) as [MongoDBMemoryStore, MongoDBMemoryStore, MongoDBMemoryStore]

    const refused = await hybrid.initialize().then(
      () => undefined,
      (error: unknown) => error,
    )
    if (refused !== undefined) {
      // Not a skip: a deployment without $rankFusion has to say so, in the sentence the store documents.
      const buildInfo = await deployment().db.command({ buildInfo: 1 })
      expect(buildInfo.versionArray[0]).toBeLessThan(8)
      expect(String(refused)).toContain('needs MongoDB 8.0 or later')
      return
    }

    const size = Object.keys(FUSION_CORPUS).length
    const vectorOrder = (await answered(vector, { vector: QUERY_VECTOR, limit: size }, size)).map((e) => e.content)
    const textOrder = (await answered(text, { text: QUERY_TEXT, limit: size }, FUSION_TEXT_MATCHES)).map(
      (e) => e.content,
    )
    const fused = await answered(hybrid, { text: QUERY_TEXT, vector: QUERY_VECTOR, limit: size }, size)
    const fusedOrder = fused.map((entry) => entry.content)

    expect(metadata(fused[0])._search_type).toBe('hybrid')
    expect(fusedOrder).toEqual(fuse(vectorOrder, textOrder))
    expect([vectorOrder[0], textOrder[0]], 'the corpus stopped exercising fusion').not.toContain(fusedOrder[0])
    const score = metadata(fused[0])._relevance_score as number
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(2 / (RANK_FUSION_PENALTY + 1))
  })
})

describeTier('integration', 'TS-140 — the sentinel scope is read like any other', () => {
  const deployment = useDeployment('integration')
  const { store } = useStores(deployment)

  it('TS-140 — an unscoped store reads the sentinel scope and nothing else', async () => {
    const unscoped = store({ writable: true })
    const scoped = store({ writable: true, scope: 'tenant-b' })
    await unscoped.add('dark mode with no tenant')
    await scoped.add('dark mode for tenant b')

    const results = await answered(unscoped, QUERY_TEXT)
    expect(results.map((entry) => entry.content)).toEqual(['dark mode with no tenant'])
    expect(metadata(results[0])._scope).toBe(UNSCOPED)
    expect((await answered(scoped, QUERY_TEXT)).map((entry) => entry.content)).toEqual(['dark mode for tenant b'])
  })
})

describeTier('integration', 'TS-149 — the shipped default, on a deployment with or without a model', () => {
  const deployment = useDeployment('integration')
  const { store } = useStores(deployment)

  it('TS-149 — initialize does not throw, and warns with the server’s reason exactly where the vector tier is missing', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    const records = await logged(() => target.initialize())

    const missing = records.filter(
      (record) => record.level === 'warn' && record.message.includes('vector search tier is not available'),
    )
    const { tiers, tierRetryAt } = memoryInternals.state(target)
    if (tiers.includes('vector')) {
      expect(missing).toEqual([])
      return
    }
    // The vector tier is absent, so the store must say something about it at initialize, and come back for it.
    expect(records.some((record) => record.message.includes('vector'))).toBe(true)
    expect(tierRetryAt).not.toBeNull()
    // Where the server refused the index rather than still building it, its own reason survives into the log.
    const refusal = missing.find((record) => record.message.includes('failed:'))
    if (refusal !== undefined) expect(refusal.message.toLowerCase()).toContain('regist')
  })

  it('TS-149 — search answers from whichever tier came up, and from text where the vector index is absent', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('the user prefers dark mode')

    const results = await answered(target, QUERY_TEXT)

    expect(results.map((entry) => entry.content)).toEqual(['the user prefers dark mode'])
    const { tiers } = memoryInternals.state(target)
    const ran = metadata(results[0])._search_type
    if (tiers.includes('vector')) expect(['vector', 'hybrid']).toContain(ran)
    else expect(ran).toBe('text')
  })
})

describeTier('integration', 'AT-054 — _search_type reports the tier that ran', () => {
  const deployment = useDeployment('integration')
  const { store, raw } = useStores(deployment)

  it('AT-054 — the shipped default reports text exactly where its vector tier did not come up', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('the user prefers dark mode')

    const results = await answered(target, QUERY_TEXT)

    expect(results).not.toEqual([])
    const ran = metadata(results[0])._search_type
    if (memoryInternals.state(target).tiers.includes('vector')) expect(['vector', 'hybrid']).toContain(ran)
    else expect(ran).toBe('text')
  })

  it('AT-054 — a manual-vector store on auto, queried by vector, reports vector', async () => {
    await seedVectors(raw(), 'tenant-a', { 'the user prefers dark mode': QUERY_VECTOR })
    const target = store({ scope: 'tenant-a', config: MANUAL_VECTOR })

    const results = await answered(target, { vector: QUERY_VECTOR })

    expect(results.map((entry) => entry.content)).toEqual(['the user prefers dark mode'])
    expect(metadata(results[0])._search_type).toBe('vector')
  })
})

describeTier('integration', 'TS-148 — the score bound drops results, measured rather than assumed', () => {
  const deployment = useDeployment('integration')
  const { store } = useStores(deployment)

  it('TS-148 — a bound above the lowest score drops exactly that result', async () => {
    // A bound of 0 drops nothing but puts the writer on the tier the bounded store will take.
    const writer = store({ writable: true, scope: 'tenant-a', minScore: 0 })
    await writer.add('dark mode dark mode dark mode')
    await writer.add(`dark mode once, then padding ${Array.from({ length: 60 }, (_, n) => `word${n}`).join(' ')}`)
    const unbounded = await answered(writer, QUERY_TEXT, 2)
    expect(unbounded).toHaveLength(2)

    const measured = unbounded
      .map((entry) => [metadata(entry)._relevance_score as number, entry.content] as const)
      .sort((a, b) => a[0] - b[0])
    const [[lowest], [highest, topContent]] = measured as [readonly [number, string], readonly [number, string]]
    expect(lowest).toBeLessThan(highest)
    const bound = (lowest + highest) / 2

    const bounded = store({ scope: 'tenant-a', minScore: bound })
    let results: MemoryEntry[] = []
    const records = await logged(async () => {
      results = await answered(bounded, QUERY_TEXT)
    })

    expect(results.map((entry) => entry.content)).toEqual([topContent])
    const kept = metadata(results[0])._relevance_score as number
    expect(kept).toBeGreaterThanOrEqual(bound)
    expect(Math.abs(kept - highest)).toBeLessThanOrEqual(SCORE_DRIFT)
    expect(
      records.some(
        (record) =>
          record.level === 'debug' && record.message.includes('minScore') && record.message.includes('kept 1 of 2'),
      ),
    ).toBe(true)
  })
})

/** The bag-of-words embedder over `dark`, `mode`, `coffee` and `tea`. Python's `_WordEmbedder`. */
const wordEmbedder = {
  async embed(text: string): Promise<number[]> {
    const words = text.toLowerCase().split(/\s+/)
    return ['dark', 'mode', 'coffee', 'tea'].map((word) => 0.01 + words.filter((found) => found === word).length)
  },
}

describeTier('integration', 'TS-137 — an embedder completes the manual path, against a deployment', () => {
  const deployment = useDeployment('integration')
  const { store, raw } = useStores(deployment)

  it('TS-137 — a memory added as text is found by a text query on the vector tier', async () => {
    const target = store({
      writable: true,
      embedder: wordEmbedder,
      config: { ...MANUAL_VECTOR, searchType: 'vector' },
    })
    await target.add('the user prefers dark mode')
    await target.add('the user drinks coffee and tea')

    const found = await answered(target, QUERY_TEXT, 2)

    expect(found.map((entry) => entry.content)).toEqual([
      'the user prefers dark mode',
      'the user drinks coffee and tea',
    ])
    expect(new Set(found.map((entry) => metadata(entry)._search_type))).toEqual(new Set(['vector']))
    // The vector as the server holds it: doubles, which is what a Python store writes and reads.
    const stored = (await raw().findOne({}, { promoteValues: false })) as Document
    for (const value of stored.embedding as unknown[]) expect(value).toBeInstanceOf(Double)
  })
})
