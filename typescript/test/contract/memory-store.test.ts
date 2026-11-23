/**
 * `MongoDBMemoryStore` against a real deployment: what the server does with the documents and filters the unit
 * tier asserts as shapes.
 *
 * Ports the contract classes of `python/tests/test_memory_store.py`, and the memory half of
 * `test_telemetry.py`'s contract class. Nothing here reads through a search index unless the deployment has
 * one: the write path, the ordinary indexes and the deletes need only `mongod`.
 *
 * The checklist ids are used as they are. The rest lead with `TS-` ids, the same ones the unit tier gives
 * their unit halves where there is one: AT-014's memory half is TS-133, AT-208 TS-138 and the memory spans
 * TS-139. The ids with no unit half are new: AT-048a is TS-140, AT-085 TS-141, AT-152 TS-142, AT-145 TS-143,
 * AT-185 TS-144, AT-186 TS-145 and AT-188 TS-146.
 *
 * **Written to hold on any deployment.** Python skips AT-053a, AT-053c and one AT-186 test where the
 * deployment has a search process, and its CI runs the class a second time against one without. This suite
 * runs against one deployment, so each of those tests branches on what the deployment's own probe said and
 * asserts the half that applies; nothing skips. The no-search halves of AT-053a and AT-053c are asserted
 * unconditionally at the unit tier.
 */
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { inspect } from 'node:util'

import { StorageError } from '@strands-agents/sdk'
import { Collection, Double, MongoClient, MongoServerError, ObjectId } from 'mongodb'
import type { Db, Document } from 'mongodb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { REGISTRY } from '../../src/client.js'
import * as lifecycle from '../../src/index-lifecycle.js'
import { memorySearchSpecs } from '../../src/indexes.js'
import { memoryInternals, MongoDBMemoryStore } from '../../src/memory-store.js'
import { configureLogging, logger as currentLogger } from '../../src/telemetry.js'
import type { MongoDBConfig, MongoDBMemoryStoreConfig } from '../../src/types.js'
import { CONTENT_FIELD, EXPIRES_FIELD, RANK_FUSION_MIN_MAJOR, UNSCOPED, VECTOR_FIELD } from '../../src/types.js'
import { type Deployment, useDeployment, uniqueName } from '../support/deployment.js'
import { exportedSpans, named, one, rendered } from '../support/spans.js'
import { describeTier, tierValue } from '../support/tiers.js'

// Pass-through mocks, so the ten-store test can count probes. Every call still reaches the real function.
vi.mock('../../src/index-lifecycle.js', async (original) => {
  const actual = await original<typeof import('../../src/index-lifecycle.js')>()
  return {
    ...actual,
    searchSupport: vi.fn(actual.searchSupport),
    rankFusionSupport: vi.fn(actual.rankFusionSupport),
  }
})

/** The password the leak tests look for. */
const PASSWORD = 'SUPERSECRET'

/** The four indexes `initialize()` leaves on a memory collection: `_id_` and the three memory specs. */
const ORDINARY = [
  '_id_',
  'strands_expires_at_ttl',
  'strands_scope_store_content_hash_unique',
  'strands_scope_store_created_at',
]

/** How long a TTL'd document may take to disappear: two monitor cycles plus slack. */
const TTL_SWEEP_BUDGET_MS = 150_000

/** How long a search index may take to build. */
const BUILD_BUDGET_MS = 180_000

/** `uri` with `u:<PASSWORD>@` as its userinfo, built at runtime so no file holds one. */
function withPassword(uri: string): string {
  const [scheme, rest] = uri.split('://') as [string, string]
  const host = rest.includes('@') ? rest.slice(rest.indexOf('@') + 1) : rest
  return `${scheme}://u:${PASSWORD}@${host}`
}

/** Nothing rendered from any subject contains the password. */
function assertNoLeak(...subjects: unknown[]): void {
  subjects.forEach((subject, index) => {
    const text = typeof subject === 'string' ? subject : inspect(subject, { depth: 6, showHidden: true })
    expect(text.includes(PASSWORD), `subject ${index} leaked the password`).toBe(false)
  })
}

/** The rejection `promise` produces, which must be an error. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`rejected with a non-Error: ${String(error)}`, { cause: error })
  }
  throw new Error('expected a rejection')
}

/** The index names on `collection`, sorted. */
async function indexNames(collection: Collection): Promise<string[]> {
  return Object.keys(await collection.indexInformation()).sort()
}

type StoreOptions = Partial<Omit<MongoDBMemoryStoreConfig, 'config'>> & {
  config?: Partial<MongoDBConfig>
  viaConnectionString?: boolean
}

/**
 * Stores built over one deployment, on one collection per test, closed after every test. The collection is
 * fresh per test and shared by every store that test builds, as Python's `unique_collection_name` is.
 */
function useStores(deployment: () => Deployment): {
  store: (options?: StoreOptions) => MongoDBMemoryStore
  raw: () => Collection
  db: () => Db
  name: () => string
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
    store: ({ viaConnectionString = false, config = {}, ...options } = {}) => {
      const { client, db } = deployment()
      const connection: MongoDBConfig = viaConnectionString
        ? { database: db.databaseName, connectionString: tierValue('contract'), ...config }
        : { database: db.databaseName, client, ...config }
      const store = new MongoDBMemoryStore({ name: 'facts', collection, ...options, config: connection })
      opened.push(store)
      return store
    },
    raw: () => deployment().db.collection(collection),
    db: () => deployment().db,
    name: () => collection,
  }
}

describeTier('contract', 'AT-042, AT-043 — a retried write stores one document, against the unique index', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)
  const writable = (): MongoDBMemoryStore => store({ writable: true, scope: 'tenant-a' })

  it('AT-042 — the same content twice stores one document, and the result says so', async () => {
    const target = writable()
    await target.initialize()

    const first = await target.add('the user prefers dark mode')
    const second = await target.add('the user prefers dark mode')

    expect([first.inserted, first.duplicates]).toEqual([1, 0])
    expect([second.inserted, second.duplicates]).toEqual([0, 1])
    expect(second.ids).toEqual(first.ids)
    expect(await raw().countDocuments({})).toBe(1)
  })

  it('AT-042 — a duplicate leaves the first-seen timestamp alone', async () => {
    const target = writable()
    await target.initialize()
    await target.add('the user prefers dark mode')
    const before = (await raw().findOne({}))?.created_at

    await sleep(5)
    await target.add('the user prefers dark mode')

    expect((await raw().findOne({}))?.created_at).toEqual(before)
  })

  it('AT-043 — a lost insert race is reported as a duplicate, with the winner’s id', async () => {
    const target = writable()
    await target.initialize()
    const first = await target.add('the user prefers dark mode')

    // The real collection, with a duplicate-key error out of the next `updateOne`, injected rather than raced
    // so which answer the loser gets is reproducible.
    let raised = false
    const original = Collection.prototype.updateOne
    const spy = vi.spyOn(Collection.prototype, 'updateOne').mockImplementationOnce(function (this: Collection) {
      raised = true
      return Promise.reject(new MongoServerError({ message: 'E11000 duplicate key error: injected', code: 11000 }))
    })
    try {
      const second = await target.add('the user prefers dark mode')

      expect(raised).toBe(true)
      expect([second.inserted, second.duplicates]).toEqual([0, 1])
      expect(second.ids).toEqual(first.ids)
      expect(await raw().countDocuments({})).toBe(1)
    } finally {
      spy.mockRestore()
      expect(Collection.prototype.updateOne).toBe(original)
    }
  })

  it('AT-043 — ten concurrent adds of one fact store one document and throw nothing', async () => {
    const target = writable()
    await target.initialize()

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => target.add('the user prefers dark mode')))

    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    const added = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    expect(added.reduce((sum, result) => sum + result.inserted, 0)).toBe(1)
    expect(added.reduce((sum, result) => sum + result.duplicates, 0)).toBe(9)
    expect(await raw().countDocuments({})).toBe(1)
  })
})

describeTier('contract', 'AT-045a — initialize twice is the same as once, on the ordinary index set', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it('AT-045a — initializing twice creates one index set', async () => {
    const target = store()
    await target.initialize()
    await target.initialize()

    expect(await indexNames(raw())).toEqual(ORDINARY)
  })
})

describeTier('contract', 'AT-046 — the store stamps the scope itself, on the write path', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it('AT-046 — the stored document carries the store’s scope and name, and a hash of the content alone', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('the user prefers dark mode')

    const document = (await raw().findOne({})) as Document
    expect(document.scope).toBe('tenant-a')
    expect(document.store_name).toBe('facts')
    expect(document[CONTENT_FIELD]).toBe('the user prefers dark mode')
    expect(document.created_at).toBeInstanceOf(Date)
    expect(document.content_hash).toBe(createHash('sha256').update('the user prefers dark mode').digest('hex'))
  })

  it('AT-046 — caller metadata cannot set the write scope, and stays visible where it was put', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    await target.add('a fact', { scope: 'tenant-b', _scope: 'tenant-b' })

    const document = (await raw().findOne({})) as Document
    expect(document.scope).toBe('tenant-a')
    expect(document.metadata.scope).toBe('tenant-b')
  })

  it('AT-046 — a configured filter cannot set the write scope', async () => {
    const target = store({ writable: true, scope: 'tenant-a', filter: { scope: 'tenant-b' } })
    await target.add('a fact')

    expect(await raw().countDocuments({ scope: 'tenant-a' })).toBe(1)
    expect(await raw().countDocuments({ scope: 'tenant-b' })).toBe(0)
  })

  it('TS-140 — a store with no scope stamps the sentinel, never nothing and never empty', async () => {
    const target = store({ writable: true })
    expect(target.scope).toBe(UNSCOPED)
    expect(UNSCOPED).toBe('__unscoped__')

    await target.add('a fact from a store nobody scoped')

    expect((await raw().findOne({}))?.scope).toBe(UNSCOPED)
  })
})

describeTier('contract', 'AT-047b — two stores, one collection, and dedup that does not cross a scope', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it('AT-047b — the same fact in two scopes is two documents', async () => {
    const first = store({ writable: true, scope: 'tenant-a' })
    const second = store({ writable: true, scope: 'tenant-b' })
    await first.initialize()

    const a = await first.add('the user prefers dark mode')
    const b = await second.add('the user prefers dark mode')

    expect([a.inserted, b.inserted]).toEqual([1, 1])
    expect(a.ids).not.toEqual(b.ids)
    expect(await raw().countDocuments({ scope: 'tenant-a' })).toBe(1)
    expect(await raw().countDocuments({ scope: 'tenant-b' })).toBe(1)
  })
})

describeTier('contract', 'TS-141 — deletes stay inside the store that issued them, on real documents', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it('TS-141 — a memory deletes once, and the second attempt reports nothing', async () => {
    const target = store({ writable: true, scope: 'tenant-a' })
    const first = await target.add('the user prefers dark mode')
    await target.add('the user works in emea')

    expect(await target.delete(first.ids[0] as string)).toBe(1)
    expect(await raw().countDocuments({})).toBe(1)
    expect(await target.delete(first.ids[0] as string)).toBe(0)
    expect(await raw().countDocuments({})).toBe(1)
  })

  it('TS-141 — a sibling store’s id deletes nothing, and reads the same as an absent one', async () => {
    const mine = store({ writable: true, scope: 'tenant-a' })
    const sibling = store({ writable: true, scope: 'tenant-a', name: 'notes' })
    const theirs = await sibling.add('the user prefers dark mode')

    const absent = await mine.delete(new ObjectId().toHexString())
    const borrowed = await mine.delete(theirs.ids[0] as string)

    expect([borrowed, absent]).toEqual([0, 0])
    expect(await raw().countDocuments({ store_name: 'notes' })).toBe(1)
  })

  it('TS-141 — deleteAll empties its own store and leaves the sibling', async () => {
    const mine = store({ writable: true, scope: 'tenant-a' })
    const sibling = store({ writable: true, scope: 'tenant-a', name: 'notes' })
    await mine.add('the user prefers dark mode')
    await mine.add('the user works in emea')
    await sibling.add('the user prefers dark mode')

    expect(await mine.deleteAll()).toBe(2)
    expect(await raw().countDocuments({ store_name: 'facts' })).toBe(0)
    expect(await raw().countDocuments({ store_name: 'notes' })).toBe(1)
  })
})

describeTier('contract', 'AT-053c — a deployment with or without Atlas Search, measured rather than assumed', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)
  const warnings: string[] = []
  const original = currentLogger

  beforeEach(() => {
    warnings.length = 0
    configureLogging({
      debug: () => undefined,
      info: () => undefined,
      warn: (_fields: unknown, message?: unknown) => {
        warnings.push(String(message))
      },
      error: () => undefined,
    })
  })
  afterEach(() => {
    configureLogging(original)
  })

  it('AT-053c — initialize leaves the ordinary indexes, and warns of no search exactly where the probe found none', async () => {
    const support = await lifecycle.searchSupport(raw())
    const target = store({ writable: true })

    await target.initialize()

    expect(await indexNames(raw())).toEqual(ORDINARY)
    const noSearch = warnings.filter((message) => message.includes('does not run Atlas Search'))
    if (support.available) {
      expect(noSearch).toEqual([])
    } else {
      expect(noSearch).toHaveLength(1)
      expect(noSearch[0]).toContain(String(support.code))
    }
    expect((await target.add('the user prefers dark mode')).inserted).toBe(1)
  })

  it('AT-053c — search on auto either answers or throws naming the server’s code, never a third thing', async () => {
    const support = await lifecycle.searchSupport(raw())
    const target = store()
    await target.initialize()

    if (support.available) {
      // A store with search does not throw the deployment error, whatever else its first search waits for.
      const outcome = await target.search('dark mode').then(
        () => undefined,
        (error: unknown) => error,
      )
      if (outcome !== undefined) expect(String(outcome)).not.toContain('does not run Atlas Search')
    } else {
      const error = await rejection(target.search('dark mode'))
      expect(error).toBeInstanceOf(StorageError)
      expect(error.message).toContain(String(support.code))
      expect(error.message).toContain('Atlas')
    }
  })
})

describeTier('contract', 'TS-142 — a memory with a TTL actually disappears', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it(
    'TS-142 — a document written with ttlSeconds 0 is gone after the sweep, with no ensureIndexes call',
    async () => {
      const admin = deployment().client.db('admin')
      // Turns a 60-second monitor cycle into a 1-second one where the deployment allows it, and puts it back.
      // An optimisation for local runs, never a premise: the budget is sized for a monitor nobody touched.
      let previous: number | undefined
      try {
        previous = ((await admin.command({ getParameter: 1, ttlMonitorSleepSecs: 1 })) as Document)
          .ttlMonitorSleepSecs as number
        await admin.command({ setParameter: 1, ttlMonitorSleepSecs: 1 })
      } catch (error) {
        if (!(error instanceof MongoServerError)) throw error
        previous = undefined
      }
      try {
        const target = store({ writable: true, scope: 'tenant-a', ttlSeconds: 0 })
        expect((await target.add('this memory is written to be forgotten')).inserted).toBe(1)

        const stamped = await raw().findOne({ scope: 'tenant-a' })
        expect(stamped, 'the write did not land, so this test cannot be about the sweep').not.toBeNull()
        expect(stamped?.[EXPIRES_FIELD]).toBeInstanceOf(Date)

        const deadline = Date.now() + TTL_SWEEP_BUDGET_MS
        while ((await raw().countDocuments({ scope: 'tenant-a' })) > 0 && Date.now() < deadline) await sleep(1000)

        expect(await raw().countDocuments({ scope: 'tenant-a' })).toBe(0)
      } finally {
        if (previous !== undefined) await admin.command({ setParameter: 1, ttlMonitorSleepSecs: previous })
      }
    },
    TTL_SWEEP_BUDGET_MS + 30_000,
  )
})

describeTier('contract', "TS-133 — no memory method renders the connection string's password", () => {
  const deployment = useDeployment('contract')
  const { name } = useStores(deployment)
  const CALLS = ['initialize', 'search', 'add'] as const

  it.each(CALLS)('TS-133 — a wrapped authentication failure from %s renders no password', async (call) => {
    const target = new MongoDBMemoryStore({
      name: 'facts',
      collection: name(),
      writable: true,
      config: {
        database: deployment().db.databaseName,
        connectionString: withPassword(tierValue('contract')),
        clientOptions: { serverSelectionTimeoutMS: 5000 },
      },
    })
    try {
      const error = await rejection(
        call === 'initialize'
          ? target.initialize()
          : call === 'search'
            ? target.search('dark mode')
            : target.add('a fact'),
      )
      expect(error).toBeInstanceOf(StorageError)
      assertNoLeak(error.message, error, error.stack)
    } finally {
      await target.close()
    }
  })

  it('TS-133 — the succeeding path renders no password at debug', async () => {
    const lines: string[] = []
    const keep = (fields: unknown, message?: unknown): void => {
      lines.push(`${String(message)} ${JSON.stringify(fields)}`)
    }
    const original = currentLogger
    configureLogging({ debug: keep, info: keep, warn: keep, error: keep })
    const client = new MongoClient(tierValue('contract'))
    const target = new MongoDBMemoryStore({
      name: 'facts',
      collection: name(),
      writable: true,
      // An injected client beside a password-bearing connection string: constructed rather than typical, and
      // the shape this guarantee exists for, since every call reaches a live deployment while the config
      // still holds a secret.
      config: { database: deployment().db.databaseName, client, connectionString: withPassword(tierValue('contract')) },
    })
    try {
      await target.initialize()
      await target.add('the user prefers dark mode')
      target.getTools()
    } finally {
      configureLogging(original)
      await target.close()
      // Closed here rather than by `close()`, which never closes an injected client.
      await client.close()
    }
    assertNoLeak(...lines, target, String(target), JSON.stringify(target))
  })
})

describeTier('contract', 'TS-143 — the fusion probe agrees with the server it probed', () => {
  const deployment = useDeployment('contract')
  const { store, raw, db } = useStores(deployment)

  it('TS-143 — the probe answers what the deployment’s own version string says', async () => {
    const buildInfo = await db().command({ buildInfo: 1 })
    const major = Number(String(buildInfo.version).split('.', 1)[0])

    const answered = await lifecycle.rankFusionSupport(db(), raw())

    expect(answered).toBe(major >= RANK_FUSION_MIN_MAJOR)
    expect(buildInfo.versionArray[0]).toBe(major)
  })

  it('TS-143 — a store on this deployment reports the same answer in its capabilities', async () => {
    const target = store()
    await target.initialize()
    const capabilities = memoryInternals.state(target).capabilities
    expect(capabilities).not.toBeNull()
    const probed = await lifecycle.rankFusionSupport(db(), raw())

    if (capabilities?.search === true) expect(capabilities.rankFusion).toBe(probed)
    else expect(capabilities?.rankFusion).toBe(false)
  })
})

/** The manual-vector connection keys, which need nothing from the deployment's embedding-model registry. */
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const
const QUERY_VECTOR = [1.0, 0.0, 0.0, 0.0]
const QUERY_TEXT = 'dark mode'

describeTier('contract', 'TS-144 — the tier set is the one the deployment implies', () => {
  const deployment = useDeployment('contract')
  const { store, raw, db } = useStores(deployment)

  /**
   * Initialize `target` and wait for every search index it can build, so its tier set is final. Under `auto`,
   * `initialize()` does not wait for a build, so which tiers resolve would otherwise depend on timing.
   */
  async function settled(target: MongoDBMemoryStore, config: Partial<MongoDBConfig> = {}): Promise<void> {
    await target.initialize()
    if (memoryInternals.state(target).capabilities?.search !== true) return
    const connection: MongoDBConfig = { database: db().databaseName, ...config }
    for (const spec of memorySearchSpecs(connection)) {
      try {
        await lifecycle.ensure(db(), raw(), { search: [spec], timeoutMs: BUILD_BUDGET_MS })
      } catch (error) {
        // A refused index, such as an autoEmbed one on a deployment with no model, raises at once and stays out.
        if (!(error instanceof StorageError)) throw error
      }
    }
    if (memoryInternals.state(target).tierRetryAt !== null) {
      memoryInternals.setRetryAt(target, 0)
      await target.initialize()
    }
  }

  it('TS-144 — the tier set agrees with what this deployment can do', async () => {
    const target = store()
    await target.initialize()
    const { capabilities, tiers } = memoryInternals.state(target)
    expect(capabilities).not.toBeNull()
    const search = capabilities?.search === true
    const rankFusion = capabilities?.rankFusion === true

    expect(search || !rankFusion).toBe(true)
    if (!search) expect(tiers).toEqual([])
    if (!rankFusion) expect(tiers).not.toContain('hybrid')
    if (tiers.length > 0) expect(search).toBe(true)
    if (tiers.includes('hybrid')) expect(tiers).toEqual(['hybrid', 'vector', 'text'])
  })

  it(
    'TS-144 — a store needing no embedding model resolves the fusion wherever it can',
    async () => {
      const target = store({ config: MANUAL_VECTOR })
      await settled(target, MANUAL_VECTOR)
      const { capabilities, tiers } = memoryInternals.state(target)

      if (capabilities?.search === true && capabilities.rankFusion) {
        expect(tiers).toEqual(['hybrid', 'vector', 'text'])
        expect(memoryInternals.pickTier(target, QUERY_TEXT, QUERY_VECTOR)).toBe('hybrid')
        expect(memoryInternals.pickTier(target, undefined, QUERY_VECTOR)).toBe('vector')
        expect(memoryInternals.pickTier(target, QUERY_TEXT, undefined)).toBe('text')
      } else {
        expect(tiers).not.toContain('hybrid')
      }
    },
    BUILD_BUDGET_MS * 2 + 30_000,
  )

  it(
    'TS-144 — hybrid leads the set or is absent from it, and text is last',
    async () => {
      const target = store()
      await settled(target)
      const { tiers } = memoryInternals.state(target)

      if (tiers.includes('hybrid')) expect(tiers[0]).toBe('hybrid')
      if (tiers.length > 0) expect(tiers.at(-1)).toBe('text')
    },
    BUILD_BUDGET_MS * 2 + 30_000,
  )

  it(
    'TS-144 — a text query resolves to hybrid where hybrid is on offer, and is refused with the code where nothing is',
    async () => {
      const target = store()
      await settled(target)
      const { capabilities, tiers } = memoryInternals.state(target)

      if (tiers.includes('hybrid')) {
        expect(memoryInternals.pickTier(target, QUERY_TEXT, undefined)).toBe('hybrid')
      } else if (tiers.length > 0) {
        expect(memoryInternals.pickTier(target, QUERY_TEXT, undefined)).not.toBe('hybrid')
      } else if (capabilities?.search !== true) {
        expect(() => memoryInternals.pickTier(target, QUERY_TEXT, undefined)).toThrow(
          String(capabilities?.noSearchCode),
        )
      }
    },
    BUILD_BUDGET_MS * 2 + 30_000,
  )

  it(
    'TS-144 — an explicit hybrid store gets the tier or an error, and never a substitute',
    async () => {
      const reference = store()
      await settled(reference)
      const { capabilities, tiers } = memoryInternals.state(reference)
      const explicit = store({ config: { searchType: 'hybrid', indexReadyTimeoutMs: BUILD_BUDGET_MS } })

      if (tiers.includes('hybrid')) {
        await explicit.initialize()
        expect(memoryInternals.state(explicit).tiers).toEqual(['hybrid'])
      } else if (capabilities?.search === true) {
        expect(await rejection(explicit.initialize())).toBeInstanceOf(StorageError)
      } else {
        await explicit.initialize()
        expect(memoryInternals.state(explicit).tiers).toEqual([])
      }
    },
    BUILD_BUDGET_MS * 3 + 30_000,
  )
})

describeTier('contract', 'TS-145 — why a deployment refuses hybrid, and not merely that it does', () => {
  const deployment = useDeployment('contract')
  const { store, raw, db } = useStores(deployment)

  it('TS-145 — this deployment runs $rankFusion over ordinary pipelines exactly where its version says it can', async () => {
    const buildInfo = await db().command({ buildInfo: 1 })
    await raw().insertMany(
      Array.from({ length: 5 }, (_, index) => ({ _id: index, up: index, down: -index }) as Document),
    )
    const pipeline = [
      {
        $rankFusion: {
          input: { pipelines: { ascending: [{ $sort: { up: 1 } }], descending: [{ $sort: { down: 1 } }] } },
        },
      },
      { $limit: 3 },
    ]

    if ((buildInfo.versionArray[0] as number) >= RANK_FUSION_MIN_MAJOR) {
      const fused = await raw().aggregate(pipeline).toArray()
      expect(fused).toHaveLength(3)
      for (const document of fused) expect([0, 1, 2, 3, 4]).toContain(document._id)
    } else {
      expect(await rejection(raw().aggregate(pipeline).toArray())).toBeInstanceOf(MongoServerError)
    }
  })

  it('TS-145 — the store’s fusion answer is the probe’s, and false wherever there is no search', async () => {
    const target = store()
    await target.initialize()
    const { capabilities, tiers } = memoryInternals.state(target)

    if (capabilities?.search !== true) {
      expect(tiers).toEqual([])
      expect(capabilities?.rankFusion).toBe(false)
    } else {
      expect(capabilities.rankFusion).toBe(await lifecycle.rankFusionSupport(db(), raw()))
    }
  })
})

describeTier(
  'contract',
  'AT-065 — ten stores initializing at once share one client, one probe and one index set',
  () => {
    const deployment = useDeployment('contract')
    const { name, raw } = useStores(deployment)

    it('AT-065 — ten distinct stores on one collection, initialized together', async () => {
      vi.mocked(lifecycle.searchSupport).mockClear()
      vi.mocked(lifecycle.rankFusionSupport).mockClear()
      const before = REGISTRY.size
      const config: MongoDBConfig = { database: deployment().db.databaseName, connectionString: tierValue('contract') }
      const stores = Array.from(
        { length: 10 },
        (_, index) => new MongoDBMemoryStore({ name: `facts${index}`, collection: name(), config }),
      )
      try {
        const results = await Promise.allSettled(stores.map((store) => store.initialize()))

        expect(results.filter((result) => result.status === 'rejected')).toEqual([])
        expect(REGISTRY.size - before).toBe(1)
        expect(vi.mocked(lifecycle.searchSupport).mock.calls.map(([collection]) => collection.collectionName)).toEqual([
          name(),
        ])
        expect(await indexNames(raw())).toEqual(ORDINARY)
        const fusionProbes = vi.mocked(lifecycle.rankFusionSupport).mock.calls.length
        expect(fusionProbes).toBeLessThanOrEqual(1)
        if (memoryInternals.state(stores[0] as MongoDBMemoryStore).capabilities?.search !== true) {
          expect(fusionProbes).toBe(0)
        }
      } finally {
        await (stores[0] as MongoDBMemoryStore).close()
      }
    })
  },
)

/** The query for every metric test: the first axis, unit length, so a score is readable off a vector. */
const METRIC_QUERY = [1.0, 0.0, 0.0, 0.0]

/** Six vectors on which the three metrics disagree: one corpus, one query, three orders. */
const METRIC_CORPUS: Readonly<Record<string, number[]>> = {
  'on the axis, a tenth of the way out': [0.1, 0.0, 0.0, 0.0],
  'half a unit, off the axis': [0.3, 0.4, 0.0, 0.0],
  'the same direction as the last one, ten times as long': [3.0, 4.0, 0.0, 0.0],
  'unit length, spread over every dimension': [0.5, 0.5, 0.5, 0.5],
  'square to the query, in a dimension of its own': [0.0, 0.0, 1.0, 0.0],
  'off to one side and behind': [-0.6, 0.8, 0.0, 0.0],
}

type Metric = 'cosine' | 'dotProduct' | 'euclidean'
const METRICS: readonly Metric[] = ['cosine', 'dotProduct', 'euclidean']

/** This metric's own nearness, higher being nearer: cosine, the dot product, or the negated squared distance. */
function similarity(metric: Metric, vector: number[]): number {
  const dot = vector.reduce((sum, value, index) => sum + value * (METRIC_QUERY[index] as number), 0)
  if (metric === 'cosine') {
    const length = (values: number[]): number => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
    return dot / (length(vector) * length(METRIC_QUERY))
  }
  if (metric === 'dotProduct') return dot
  return -vector.reduce((sum, value, index) => sum + (value - (METRIC_QUERY[index] as number)) ** 2, 0)
}

/** The score mongot was measured to compute: `(1 + cosine) / 2`, `(1 + dot) / 2`, `1 / (1 + distance²)`. */
function predicted(metric: Metric, vector: number[]): number {
  const near = similarity(metric, vector)
  return metric === 'euclidean' ? 1 / (1 - near) : (1 + near) / 2
}

describeTier('contract', 'TS-146 — every vector metric scores as a similarity, measured on a real index', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  /** A manual-vector store on one metric with the corpus written, or `undefined` where nothing can search. */
  async function seeded(metric: Metric): Promise<MongoDBMemoryStore | undefined> {
    const target = store({
      scope: 'tenant-a',
      config: { ...MANUAL_VECTOR, similarity: metric, searchType: 'vector', indexReadyTimeoutMs: BUILD_BUDGET_MS },
    })
    const support = await lifecycle.searchSupport(raw())
    if (!support.available) return undefined
    await target.initialize()
    const now = new Date()
    await raw().insertMany(
      Object.entries(METRIC_CORPUS).map(([content, vector]) => ({
        [CONTENT_FIELD]: content,
        // Doubles, as Python writes them: a JS number such as 1.0 would otherwise go out as an int32.
        [VECTOR_FIELD]: vector.map((value) => new Double(value)),
        scope: 'tenant-a',
        store_name: 'facts',
        content_hash: createHash('sha256').update(content).digest('hex'),
        created_at: now,
      })),
    )
    return target
  }

  /** Content and score in server order, once mongot has the whole corpus. */
  async function scores(target: MongoDBMemoryStore): Promise<[string, number][]> {
    const expected = Object.keys(METRIC_CORPUS).length
    const deadline = Date.now() + BUILD_BUDGET_MS
    for (;;) {
      const found = await target.search({ vector: METRIC_QUERY, limit: 10 })
      if (found.length >= expected || Date.now() > deadline) {
        return found.map((entry) => [entry.content, Number(entry.metadata?._relevance_score)])
      }
      await sleep(500)
    }
  }

  /** Where the deployment cannot search, there is no score to read: the store refuses with the code. */
  async function refusesWithoutSearch(): Promise<void> {
    const support = await lifecycle.searchSupport(raw())
    expect(support.available).toBe(false)
  }

  it.each(METRICS)(
    'TS-146 — the nearest vector scores highest and the furthest lowest: %s',
    async (metric) => {
      const target = await seeded(metric)
      if (target === undefined) return refusesWithoutSearch()
      const measured = await scores(target)

      expect(measured).toHaveLength(Object.keys(METRIC_CORPUS).length)
      const values = measured.map(([, score]) => score)
      expect(values).toEqual([...values].sort((a, b) => b - a))
      expect(values.every((score) => score > 0)).toBe(true)
      const nearness = measured.map(([content]) => similarity(metric, METRIC_CORPUS[content] as number[]))
      expect(nearness).toEqual([...nearness].sort((a, b) => b - a))
      const ranked = Object.keys(METRIC_CORPUS).sort(
        (a, b) => similarity(metric, METRIC_CORPUS[b] as number[]) - similarity(metric, METRIC_CORPUS[a] as number[]),
      )
      expect(measured[0]?.[0]).toBe(ranked[0])
      expect(measured.at(-1)?.[0]).toBe(ranked.at(-1))
    },
    BUILD_BUDGET_MS * 2,
  )

  it.each(METRICS)(
    'TS-146 — the score is the number this deployment’s formula predicts: %s',
    async (metric) => {
      const target = await seeded(metric)
      if (target === undefined) return refusesWithoutSearch()
      for (const [content, score] of await scores(target)) {
        const expected = predicted(metric, METRIC_CORPUS[content] as number[])
        expect(Math.abs(score - expected) / Math.abs(expected)).toBeLessThan(1e-6)
      }
    },
    BUILD_BUDGET_MS * 2,
  )

  it(
    'TS-146 — the reported score is the one the server projected, on a pipeline this package did not build',
    async () => {
      const target = await seeded('euclidean')
      if (target === undefined) return refusesWithoutSearch()
      const reported = Object.fromEntries(await scores(target))
      const projected = Object.fromEntries(
        (
          await raw()
            .aggregate([
              {
                $vectorSearch: {
                  index: memorySearchSpecs({ database: 'unused', ...MANUAL_VECTOR })[0].name,
                  path: VECTOR_FIELD,
                  queryVector: METRIC_QUERY,
                  numCandidates: 100,
                  limit: Object.keys(METRIC_CORPUS).length,
                },
              },
              { $set: { projected: { $meta: 'vectorSearchScore' } } },
              { $project: { [CONTENT_FIELD]: 1, projected: 1, _id: 0 } },
            ])
            .toArray()
        ).map((document) => [String(document[CONTENT_FIELD]), Number(document.projected)]),
      )
      expect(Object.keys(projected)).not.toHaveLength(0)
      expect(reported).toEqual(projected)
    },
    BUILD_BUDGET_MS * 2,
  )

  it(
    'TS-146 — a dotProduct score is not bounded above by one',
    async () => {
      const target = await seeded('dotProduct')
      if (target === undefined) return refusesWithoutSearch()
      const measured = await scores(target)
      expect(measured.filter(([, score]) => score > 1)).not.toEqual([])
      expect(measured[0]?.[1]).toBe(Math.max(...measured.map(([, score]) => score)))
    },
    BUILD_BUDGET_MS * 2,
  )
})

describeTier('contract', 'TS-138, TS-139 — the memory spans against a real deployment', () => {
  const deployment = useDeployment('contract')
  const { store } = useStores(deployment)

  it('TS-139 — the outcomes a fake writes for itself, read off a real server instead', async () => {
    const spans = exportedSpans()
    const lines: string[] = []
    const keep = (fields: unknown, message?: unknown): void => {
      lines.push(`${String(message)} ${JSON.stringify(fields)}`)
    }
    const original = currentLogger
    configureLogging({ debug: keep, info: keep, warn: keep, error: keep })
    try {
      const target = store({ writable: true, scope: 'mk-scope-28f4' })
      await target.add('mk-content-41ab', { mk_metakey_3e8f: 'mk-metavalue-90cd' })
      await target.add('mk-content-41ab', { mk_metakey_3e8f: 'mk-metavalue-90cd' })
      await target.delete('feedfacecafe0123456789ab')
      await target.deleteAll()
    } finally {
      configureLogging(original)
    }

    const adds = named(spans, 'strands_mongodb.memory.add')
    expect(adds.map((span) => span.attributes['strands_mongodb.duplicate'])).toEqual([false, true])
    expect(one(spans, 'strands_mongodb.memory.delete').attributes['strands_mongodb.deleted_count']).toBe(0)
    expect(one(spans, 'strands_mongodb.memory.delete_all').attributes['strands_mongodb.deleted_count']).toBe(1)
    const markers = [
      'mk-scope-28f4',
      'mk-content-41ab',
      'mk_metakey_3e8f',
      'mk-metavalue-90cd',
      'feedfacecafe0123456789ab',
    ]
    const surfaces = [...spans.getFinishedSpans().map(rendered), ...lines]
    expect(surfaces.flatMap((text) => markers.filter((marker) => text.includes(marker)))).toEqual([])
  })
})
