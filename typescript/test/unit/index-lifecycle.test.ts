/**
 * Ensuring, verifying and probing indexes, against a fake collection.
 *
 * Ports the fake-backed half of `python/tests/test_indexes.py`, and the index spans and records from
 * `python/tests/test_telemetry.py` (AT-204, AT-209, AT-211). What a fake cannot show, that the states and
 * errors occur on a real server, is `test/contract/index-lifecycle.test.ts` and
 * `test/integration/search-indexes.test.ts`.
 *
 * None of the Python ids ported here is a checklist item, so the tests lead with `TS-` ids. AT-063 is TS-045,
 * AT-064 TS-046, AT-061 TS-047, AT-193 TS-048, AT-196 TS-049, AT-197 TS-050, AT-068 TS-051, AT-069 TS-052,
 * AT-125 TS-053, AT-180 TS-054, AT-053d TS-055, AT-145 TS-056, AT-204 TS-057, AT-209 TS-058 and AT-211
 * TS-059.
 *
 * One Python test has no port: the one that compares a partial filter expression reported as a `SON`. The
 * driver here reports plain objects, and the comparison below is deep equality, which ignores key order.
 */
import type { Logger } from '@strands-agents/sdk'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { StorageError } from '@strands-agents/sdk'
import { AggregationCursor, Collection, Db, MongoClient } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SearchIndexNotReady, ensure, rankFusionSupport, searchSupport } from '../../src/index-lifecycle.js'
import { IndexSpec, type SearchIndexSpec, memorySearchSpecs, memorySpecs, storageSpecs } from '../../src/indexes.js'
import { configureLogging, logger } from '../../src/telemetry.js'
import { POLL_INTERVAL_MS, READY_TIMEOUT_MS } from '../../src/types.js'
import {
  FakeCollection,
  FakeDatabase,
  existing,
  networkError,
  searchStates,
  serverError,
} from '../support/fake-indexes.js'
import { children, exportedSpans, named, one } from '../support/spans.js'

/** One log call a recording logger received: the level, the fields and the message. */
interface LogCall {
  readonly level: keyof Logger
  readonly fields: Record<string, unknown>
  readonly message: string
}

let records: LogCall[] = []
const original = logger

beforeEach(() => {
  records = []
  const keep =
    (level: keyof Logger) =>
    (fields: unknown, message: unknown): void => {
      records.push({ level, fields: fields as Record<string, unknown>, message: message as string })
    }
  configureLogging({ debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') })
})

afterEach(() => {
  configureLogging(original)
})

/** The rejection of `promise`, failing the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection, and the promise resolved')
}

/** The memory spec over these keys. */
function memorySpec(...keys: string[]): IndexSpec {
  const found = memorySpecs().find((spec) => spec.keys.map(([k]) => k).join() === keys.join())
  if (found === undefined) throw new Error(`no memory spec over ${keys.join()}`)
  return found
}

const DEDUP = (): IndexSpec => memorySpec('scope', 'store_name', 'content_hash')
const RECENCY = (): IndexSpec => memorySpec('scope', 'store_name', 'created_at')
const TTL = (): IndexSpec => memorySpec('expires_at')

/** The vector spec under the zero-configuration defaults. */
const VECTOR = (): SearchIndexSpec => memorySearchSpecs({ database: 'd' })[0]
/** The text spec. */
const TEXT = (): SearchIndexSpec => memorySearchSpecs({ database: 'd' })[1]

/** An existing index as the server reports one created from `spec`, plus anything in `extra`. */
function present(spec: IndexSpec, extra: Record<string, unknown> = {}, name = spec.name): Record<string, unknown> {
  return existing(name, spec.key, { ...spec.options, ...extra })
}

/** Run ensure against a fake pair. */
function run(
  collection: FakeCollection,
  options: Parameters<typeof ensure>[2],
  database = new FakeDatabase(collection.dbName),
): Promise<void> {
  return ensure(database.db, collection.collection, { intervalMs: 0, ...options })
}

describe('TS-037 — ordinary indexes are created, verified and reported against a fake', () => {
  it('TS-037 — a missing index is created when creation is allowed', async () => {
    const collection = new FakeCollection({ collectionName: 'storage' })
    await run(collection, { ordinary: storageSpecs() })
    expect(collection.createdIndexes).toEqual([
      [{ key: { expires_at: 1 }, name: 'strands_expires_at_ttl', expireAfterSeconds: 0 }],
    ])
  })

  it('TS-037 — a collection that does not exist yet has every index created, which creates it', async () => {
    // The Node driver, unlike PyMongo, surfaces the server's NamespaceNotFound from listIndexes.
    const collection = new FakeCollection({ exists: false })
    await run(collection, { ordinary: memorySpecs() })
    expect(collection.createdIndexes).toEqual([memorySpecs().map((spec) => spec.description())])
    expect(collection.exists).toBe(true)
  })

  it('TS-037 — all missing indexes are created in one call', async () => {
    const collection = new FakeCollection()
    await run(collection, { ordinary: memorySpecs() })
    expect(collection.createdIndexes).toHaveLength(1)
    expect(collection.createdIndexes[0]).toHaveLength(3)
  })

  it('TS-037 — an index matching on keys and options is left alone', async () => {
    const collection = new FakeCollection({ indexes: memorySpecs().map((spec) => present(spec)) })
    await run(collection, { ordinary: memorySpecs() })
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-037 — matching is on the key list rather than the name', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP(), {}, 'theirs')] })
    await run(collection, { ordinary: [DEDUP()] })
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-037 — options the server or another tool added are ignored', async () => {
    const collection = new FakeCollection({ indexes: [present(TTL(), { background: true, hidden: false })] })
    await run(collection, { ordinary: [TTL()] })
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-037 — a partial filter expression compares deeply, whatever its key order', async () => {
    const reordered = existing('theirs', DEDUP().key, {
      partialFilterExpression: { content_hash: { $exists: true } },
      unique: true,
    })
    const collection = new FakeCollection({ indexes: [reordered] })
    await run(collection, { ordinary: [DEDUP()] })
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-037 — a key list in a different order is a different index', async () => {
    const collection = new FakeCollection({
      indexes: [existing('theirs', { store_name: 1, scope: 1, created_at: -1 })],
    })
    await run(collection, { ordinary: [RECENCY()] })
    expect(collection.createdIndexes).toHaveLength(1)
  })

  it('TS-037 — an unexpected driver error surfaces as a StorageError with the cause', async () => {
    const collection = new FakeCollection()
    const cause = serverError(13, 'not authorized')
    collection.indexError = cause
    const error = await rejection(run(collection, { ordinary: memorySpecs() }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('reading indexes on testdb.memory')
    expect(error.cause).toBe(cause)
  })

  it('TS-037 — a failed create surfaces as a StorageError with the cause', async () => {
    const collection = new FakeCollection()
    const cause = networkError()
    collection.createIndexesError = cause
    const error = await rejection(run(collection, { ordinary: memorySpecs() }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('creating indexes on testdb.memory')
    expect(error.cause).toBe(cause)
  })

  it('TS-037 — an error that is not the driver’s propagates unchanged', async () => {
    const collection = new FakeCollection()
    const bug = new TypeError('a bug')
    collection.indexError = bug
    expect(await rejection(run(collection, { ordinary: memorySpecs() }))).toBe(bug)
  })

  it('TS-037 — nothing is read when there is nothing to ensure', async () => {
    const collection = new FakeCollection()
    collection.indexError = new Error('read')
    await run(collection, {})
    await run(collection, { ordinary: [], search: [] })
  })
})

describe('TS-045 — an index over the declared keys that lacks the option it exists for is refused', () => {
  it('TS-045 — a matching key list with a missing option throws', async () => {
    const collection = new FakeCollection({ indexes: [existing('theirs', DEDUP().key)] })
    const error = await rejection(run(collection, { ordinary: [DEDUP()] }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('unique')
  })

  it('TS-045 — the message carries found, wanted and the remedy', async () => {
    const collection = new FakeCollection({ indexes: [existing('theirs', DEDUP().key)] })
    const { message } = await rejection(run(collection, { ordinary: [DEDUP()] }))
    expect(message).toContain("'theirs'")
    expect(message).toContain("'strands_scope_store_content_hash_unique'")
    expect(message).toContain('its unique is absent and this package needs true')
    expect(message).toContain('db.runCommand({"dropIndexes": "memory", "index": "theirs"})')
    expect(message).toContain(DEDUP().creationCommand('memory'))
  })

  it('TS-045 — a mismatch throws even when creation is allowed, and creates nothing', async () => {
    const collection = new FakeCollection({ indexes: [existing('theirs', DEDUP().key)] })
    await rejection(run(collection, { ordinary: memorySpecs(), create: true }))
    expect(collection.createdIndexes).toEqual([])
  })
})

describe('TS-046 — a differing expireAfterSeconds is a mismatch, not a match', () => {
  it('TS-046 — a TTL index with a different expiry is refused', async () => {
    const collection = new FakeCollection({ indexes: [present(TTL(), { expireAfterSeconds: 3600 })] })
    const { message } = await rejection(run(collection, { ordinary: [TTL()] }))
    expect(message).toContain('expireAfterSeconds')
  })

  it('TS-046 — the message names the value the index actually has', async () => {
    const collection = new FakeCollection({ indexes: [present(TTL(), { expireAfterSeconds: 3600 })] })
    const { message } = await rejection(run(collection, { ordinary: [TTL()] }))
    expect(message).toContain('its expireAfterSeconds is 3600 and this package needs 0')
  })

  it('TS-046 — an absent option is named as absent', async () => {
    const collection = new FakeCollection({ indexes: [existing('plain', TTL().key)] })
    const { message } = await rejection(run(collection, { ordinary: [TTL()] }))
    expect(message).toContain('its expireAfterSeconds is absent and this package needs 0')
  })
})

describe('TS-047 — verify-only mode creates nothing and throws on a missing index', () => {
  it('TS-047 — verify-only creates nothing and throws with the creation command', async () => {
    const collection = new FakeCollection()
    const error = await rejection(run(collection, { ordinary: [DEDUP()], create: false }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('createIndexes')
    expect(error.message).toContain('ensureIndexes is false')
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-047 — the error names every missing index, not only the first', async () => {
    const collection = new FakeCollection()
    const { message } = await rejection(run(collection, { ordinary: memorySpecs(), create: false }))
    expect(message.match(/"createIndexes"/g)).toHaveLength(3)
    expect(message).toContain(
      `Absent: ${memorySpecs()
        .map((spec) => spec.name)
        .join(', ')}.`,
    )
  })

  it('TS-047 — on a collection that does not exist yet, every index is reported missing', async () => {
    const collection = new FakeCollection({ exists: false })
    const error = await rejection(run(collection, { ordinary: memorySpecs(), create: false }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('ensureIndexes is false')
    expect(error.message.match(/"createIndexes"/g)).toHaveLength(3)
    expect(collection.exists).toBe(false)
  })

  it('TS-047 — verify-only passes when everything is present', async () => {
    const collection = new FakeCollection()
    await run(collection, { ordinary: memorySpecs() })
    await run(collection, { ordinary: memorySpecs(), create: false })
    expect(collection.createdIndexes).toHaveLength(1)
  })
})

describe('TS-048 — a matched index whose collation folds case is refused', () => {
  const folding = { locale: 'en', strength: 2 }

  it('TS-048 — an index reporting a folding collation is refused', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP(), { collation: folding }, 'theirs')] })
    const error = await rejection(run(collection, { ordinary: [DEDUP()] }))
    expect(error).toBeInstanceOf(StorageError)
  })

  it('TS-048 — the message names the locale, the index and the remedy', async () => {
    const collection = new FakeCollection({ indexes: [present(RECENCY(), { collation: folding }, 'theirs')] })
    const { message } = await rejection(run(collection, { ordinary: [RECENCY()] }))
    expect(message).toContain("'en'")
    expect(message).toContain("'theirs'")
    expect(message).toContain('dropIndex')
    expect(message).toContain(RECENCY().creationCommand('memory'))
  })

  it('TS-048 — nothing is created on the way to the refusal', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP(), { collation: folding }, 'theirs')] })
    await rejection(run(collection, { ordinary: memorySpecs() }))
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-048 — an index reporting a simple collation is accepted', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP(), { collation: { locale: 'simple' } })] })
    await run(collection, { ordinary: [DEDUP()] })
  })

  it('TS-048 — an index reporting no collation at all is accepted', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP())] })
    await run(collection, { ordinary: [DEDUP()] })
  })

  it('TS-048 — a missing index is still created rather than inspected', async () => {
    const collection = new FakeCollection()
    await run(collection, { ordinary: [DEDUP()] })
    expect(collection.createdIndexes).toHaveLength(1)
  })
})

describe('TS-049 — a folding unique index is refused even beside a correct one', () => {
  const folding = { locale: 'en', strength: 2 }
  const foldingUnique = (): Record<string, unknown> => present(DEDUP(), { collation: folding }, 'folding_unique')

  it('TS-049 — a folding unique index behind the declared one is refused', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP()), foldingUnique()] })
    const error = await rejection(run(collection, { ordinary: [DEDUP()] }))
    expect(error.message).toContain("'folding_unique'")
  })

  it('TS-049 — the answer does not depend on which index was created first', async () => {
    const collection = new FakeCollection({ indexes: [foldingUnique(), present(DEDUP())] })
    const error = await rejection(run(collection, { ordinary: [DEDUP()] }))
    expect(error.message).toContain("'folding_unique'")
  })

  it('TS-049 — the message names the index that is actually the problem, and the remedy', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP()), foldingUnique()] })
    const { message } = await rejection(run(collection, { ordinary: [DEDUP()] }))
    expect(message).toContain("'en'")
    expect(message).toContain('it is unique')
    expect(message).toContain('db.runCommand({"dropIndexes": "memory", "index": "folding_unique"})')
  })

  it('TS-049 — nothing is created on the way to the refusal', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP()), foldingUnique()] })
    await rejection(run(collection, { ordinary: memorySpecs() }))
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-049 — a second binary index over the same keys is accepted', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP()), present(DEDUP(), {}, 'second')] })
    await run(collection, { ordinary: [DEDUP()] })
  })

  it('TS-049 — a folding index enforcing nothing beside a correct one is accepted', async () => {
    const collection = new FakeCollection({
      indexes: [present(RECENCY()), present(RECENCY(), { collation: folding }, 'folding_plain')],
    })
    await run(collection, { ordinary: [RECENCY()] })
  })

  it('TS-049 — a folding index enforcing nothing and alone is still refused', async () => {
    const collection = new FakeCollection({
      indexes: [present(RECENCY(), { collation: folding }, 'folding_plain')],
    })
    const { message } = await rejection(run(collection, { ordinary: [RECENCY()] }))
    expect(message).toContain("'folding_plain'")
  })
})

describe('TS-050 — a date-only index is exempt from the collation rule', () => {
  const folding = { locale: 'en', strength: 2 }

  it('TS-050 — a collated TTL index is accepted', async () => {
    const collection = new FakeCollection({ indexes: [present(TTL(), { collation: folding })] })
    await run(collection, { ordinary: [TTL()] })
    expect(collection.createdIndexes).toEqual([])
  })

  it('TS-050 — the whole memory index set is accepted over a collated TTL index', async () => {
    const collection = new FakeCollection({
      indexes: [present(DEDUP()), present(RECENCY()), present(TTL(), { collation: folding })],
    })
    await run(collection, { ordinary: memorySpecs() })
  })

  it('TS-050 — the exemption is declared on the spec rather than guessed', () => {
    expect(TTL().dateOnly).toBe(true)
    expect(storageSpecs()[0]?.dateOnly).toBe(true)
  })

  it('TS-050 — the recency index is not exempt', async () => {
    const collection = new FakeCollection({ indexes: [present(RECENCY(), { collation: folding })] })
    await rejection(run(collection, { ordinary: [RECENCY()] }))
  })

  it('TS-050 — the dedup index is not exempt', async () => {
    const collection = new FakeCollection({ indexes: [present(DEDUP(), { collation: folding })] })
    await rejection(run(collection, { ordinary: [DEDUP()] }))
  })

  it('TS-050 — a date-only index this package creates carries no collation', () => {
    expect(TTL().creationCommand('memory')).not.toContain('collation')
  })
})

describe('TS-038 — search indexes: the build states, the status vocabulary and the namespace errors', () => {
  it('TS-038 — a missing index is created and then polled to ready', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['', 'BUILDING', 'READY']) })
    await run(collection, { search: [VECTOR()] })
    expect(collection.createdSearchIndexes).toEqual([
      { name: 'vector_index', type: 'vectorSearch', definition: VECTOR().definition },
    ])
    expect(collection.readsOf('vector_index')).toBe(3)
  })

  it('TS-038 — the collection is created without options, since the driver sends create directly', async () => {
    const collection = new FakeCollection()
    const database = new FakeDatabase()
    await run(collection, { search: [VECTOR()] }, database)
    expect(database.createCollectionCalls).toEqual([['memory', undefined]])
  })

  it('TS-038 — a collection that already exists is not an error', async () => {
    const collection = new FakeCollection()
    const database = new FakeDatabase()
    database.createError = serverError(48, 'Collection already exists')
    await run(collection, { search: [VECTOR()] }, database)
    expect(collection.createdSearchIndexes).toHaveLength(1)
  })

  it('TS-038 — a collection creation failure that is not code 48 surfaces', async () => {
    const collection = new FakeCollection()
    const database = new FakeDatabase()
    const cause = serverError(13, 'not authorized')
    database.createError = cause
    const error = await rejection(run(collection, { search: [VECTOR()] }, database))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('creating the collection testdb.memory')
    expect(error.cause).toBe(cause)
    expect(collection.createdSearchIndexes).toEqual([])
  })

  it('TS-038 — a collection creation that never reached the server surfaces', async () => {
    const collection = new FakeCollection()
    const database = new FakeDatabase()
    database.createError = networkError()
    const error = await rejection(run(collection, { search: [VECTOR()] }, database))
    expect(error.message).toContain('creating the collection')
  })

  it('TS-038 — an index already ready is left alone and the collection is not touched', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['READY']) })
    const database = new FakeDatabase()
    await run(collection, { search: [VECTOR()] }, database)
    expect(collection.createdSearchIndexes).toEqual([])
    expect(database.createCollectionCalls).toEqual([])
  })

  it.each(['PENDING', 'BUILDING', 'STAGED', 'SOMETHING_NEW'])(
    'TS-038 — %s is read as building, and waited out',
    async (status) => {
      const collection = new FakeCollection({ searchStates: searchStates('vector_index', [status, 'READY']) })
      await run(collection, { search: [VECTOR()] })
      expect(collection.createdSearchIndexes).toEqual([])
      expect(collection.readsOf('vector_index')).toBe(2)
    },
  )

  it('TS-038 — a failed build throws with the failure detail and the remedy', async () => {
    const collection = new FakeCollection({
      searchStates: {
        vector_index: [[{ name: 'vector_index', status: 'FAILED', statusDetail: [{ message: 'oom' }] }]],
      },
    })
    const error = await rejection(run(collection, { search: [VECTOR()] }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('FAILED')
    expect(error.message).toContain('oom')
    expect(error.message).toContain('dropSearchIndex')
    expect(collection.createdSearchIndexes).toEqual([])
  })

  it('TS-038 — a build that fails partway through throws rather than waiting it out', async () => {
    const collection = new FakeCollection({
      searchStates: {
        vector_index: [
          [{ name: 'vector_index', status: 'BUILDING' }],
          [{ name: 'vector_index', status: 'FAILED', statusDetail: { reason: 'disk full' } }],
        ],
      },
    })
    const error = await rejection(run(collection, { search: [VECTOR()], timeoutMs: 5_000 }))
    expect(error.message).toContain('disk full')
  })

  it('TS-038 — an index dropped mid-build is waited for rather than recreated', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING', '']) })
    const error = await rejection(run(collection, { search: [VECTOR()], timeoutMs: 0 }))
    expect(error).toBeInstanceOf(SearchIndexNotReady)
    expect(error.message).toContain('vector_index is absent')
    expect(collection.createdSearchIndexes).toEqual([])
  })

  it('TS-038 — the timeout message says what each search type does next', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING']) })
    const error = await rejection(run(collection, { search: [VECTOR()], timeoutMs: 0 }))
    expect(error.message).toContain('named searchType')
    expect(error.message).toContain("'auto'")
    expect(error.message).toContain('db.memory.getSearchIndexes()')
  })

  it('TS-038 — a build that never finishes times out naming the last status', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING']) })
    const error = await rejection(run(collection, { search: [VECTOR()], timeoutMs: 0 }))
    expect(error).toBeInstanceOf(SearchIndexNotReady)
    expect(error).toBeInstanceOf(StorageError)
    expect(error.name).toBe('SearchIndexNotReady')
    expect(error.message).toContain('waited 0s for 1 search index(es) on testdb.memory')
    expect(error.message).toContain('vector_index is BUILDING')
  })

  it('TS-038 — verify-only throws with the search creation command', async () => {
    const collection = new FakeCollection()
    const database = new FakeDatabase()
    const error = await rejection(run(collection, { search: [VECTOR()], create: false }, database))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('createSearchIndexes')
    expect(error.message).toContain('ensureIndexes is false')
    expect(error.message).toContain('Absent: vector_index.')
    expect(collection.createdSearchIndexes).toEqual([])
    expect(database.createCollectionCalls).toEqual([])
  })

  it('TS-038 — verify-only still waits for a build somebody else started', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING', 'READY']) })
    await run(collection, { search: [VECTOR()], create: false })
    expect(collection.readsOf('vector_index')).toBe(2)
  })

  it('TS-038 — polling yields to the event loop between reads', async () => {
    const collection = new FakeCollection({
      searchStates: searchStates('vector_index', ['BUILDING', 'BUILDING', 'BUILDING', 'READY']),
    })
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 0)
    try {
      await run(collection, { search: [VECTOR()], intervalMs: 5 })
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it('TS-038 — a read against a collection that does not exist reads as absent, so the index is created', async () => {
    const collection = new FakeCollection({
      searchStates: {
        vector_index: [serverError(26, 'ns does not exist'), [{ name: 'vector_index', status: 'READY' }]],
      },
    })
    await run(collection, { search: [VECTOR()] })
    expect(collection.createdSearchIndexes).toHaveLength(1)
  })

  it('TS-038 — a read that fails for any other reason surfaces, naming the index', async () => {
    const cause = serverError(13, 'not authorized')
    const collection = new FakeCollection({ searchStates: { vector_index: [cause] } })
    const error = await rejection(run(collection, { search: [VECTOR()] }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("reading search index 'vector_index' on testdb.memory failed")
    expect(error.cause).toBe(cause)
  })

  it('TS-038 — a read that never reached the server surfaces with its cause', async () => {
    const cause = networkError()
    const collection = new FakeCollection({ searchStates: { vector_index: [cause] } })
    const error = await rejection(run(collection, { search: [VECTOR()] }))
    expect(error.cause).toBe(cause)
  })

  it('TS-038 — a failed createSearchIndex surfaces, naming the index', async () => {
    const collection = new FakeCollection()
    const cause = serverError(68, 'exists with a different definition')
    collection.createSearchIndexError = cause
    const error = await rejection(run(collection, { search: [VECTOR()] }))
    expect(error.message).toContain("creating search index 'vector_index' on testdb.memory failed")
    expect(error.cause).toBe(cause)
  })

  it('TS-038 — a status is logged when it changes and not on every poll', async () => {
    const collection = new FakeCollection({
      searchStates: searchStates('vector_index', ['BUILDING', 'BUILDING', 'BUILDING', 'READY']),
    })
    await run(collection, { search: [VECTOR()], create: false })
    const statuses = records.filter((record) => record.message.includes('vector_index')).map((r) => r.message)
    expect(statuses.filter((message) => message.includes('BUILDING'))).toHaveLength(1)
    expect(statuses.filter((message) => message.includes('READY'))).toHaveLength(1)
  })
})

describe('TS-051 — the collection is created before the search index', () => {
  it('TS-051 — createCollection runs first, by name', async () => {
    const order: string[] = []
    const collection = new FakeCollection()
    const database = new FakeDatabase()
    const create = database.createCollection.bind(database)
    database.createCollection = async (name, options) => {
      order.push(`collection ${name}`)
      return create(name, options)
    }
    const createIndex = collection.createSearchIndex.bind(collection)
    collection.createSearchIndex = async (description) => {
      order.push(`index ${description.name as string}`)
      return createIndex(description)
    }
    await run(collection, { search: [VECTOR()] }, database)
    expect(order).toEqual(['collection memory', 'index vector_index'])
  })
})

describe('TS-039 — an existing search index must cover the declared definition', () => {
  it('TS-039 — a present index with a different definition throws and creates nothing', async () => {
    const other = { fields: [{ type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' }] }
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['READY'], other) })
    const error = await rejection(run(collection, { search: [VECTOR()] }))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('does not cover')
    expect(error.message).toContain('dropSearchIndex')
    expect(collection.createdSearchIndexes).toEqual([])
  })

  it('TS-039 — an identical definition is a match even reported back by the server', async () => {
    const collection = new FakeCollection({
      searchStates: searchStates('vector_index', ['READY'], structuredClone(VECTOR().definition)),
    })
    await run(collection, { search: [VECTOR()] })
  })

  it('TS-039 — a text index mapped over a different field is a mismatch', async () => {
    const other = { mappings: { dynamic: false, fields: { body: [{ type: 'string' }] } } }
    const collection = new FakeCollection({ searchStates: searchStates('text_index', ['READY'], other) })
    const { message } = await rejection(run(collection, { search: [TEXT()] }))
    expect(message).toContain('definition.mappings.fields.content is absent')
  })

  it('TS-039 — a vector index with the wrong dimension count is a mismatch', async () => {
    const spec = memorySearchSpecs({ database: 'd', embeddingDimensions: 1024, similarity: 'cosine' })[0]
    const reported = structuredClone(spec.definition) as { fields: Array<Record<string, unknown>> }
    ;(reported.fields[0] as Record<string, unknown>).numDimensions = 1536
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['READY'], reported) })
    const { message } = await rejection(run(collection, { search: [spec] }))
    expect(message).toContain('numDimensions')
  })

  it('TS-039 — a missing filter path is a mismatch', async () => {
    const reported = { fields: (VECTOR().definition.fields as unknown[]).slice(0, 2) }
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['READY'], reported) })
    const { message } = await rejection(run(collection, { search: [VECTOR()] }))
    expect(message).toContain('store_name')
  })

  it('TS-039 — fields the server or another tool added are not mismatches', async () => {
    const reported = {
      fields: [...(VECTOR().definition.fields as unknown[]), { type: 'filter', path: 'extra' }],
      storedSource: true,
    }
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['READY'], reported) })
    await run(collection, { search: [VECTOR()] })
  })

  it('TS-039 — dynamic mapping turned on is a mismatch', async () => {
    const reported = { mappings: { dynamic: true, fields: { content: [{ type: 'string' }] } } }
    const collection = new FakeCollection({ searchStates: searchStates('text_index', ['READY'], reported) })
    const { message } = await rejection(run(collection, { search: [TEXT()] }))
    expect(message).toContain('definition.mappings.dynamic is true where this package declared false')
  })

  it('TS-039 — an object reported where one was declared as a scalar says so', async () => {
    const reported = { mappings: 'none' }
    const collection = new FakeCollection({ searchStates: searchStates('text_index', ['READY'], reported) })
    const { message } = await rejection(run(collection, { search: [TEXT()] }))
    expect(message).toContain('declared the object')
  })

  it('TS-039 — a list reported as a scalar says so', async () => {
    const reported = { fields: 'none' }
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['READY'], reported) })
    const { message } = await rejection(run(collection, { search: [VECTOR()] }))
    expect(message).toContain('declared the list')
  })
})

describe('TS-052 — the definition mongot rewrites for a text index still matches', () => {
  it('TS-052 — the one-element list collapsed into an object, with defaults filled in, covers the declaration', async () => {
    const rewritten = {
      mappings: {
        dynamic: false,
        fields: { content: { type: 'string', indexOptions: 'offsets', store: true, norms: 'include' } },
      },
    }
    const collection = new FakeCollection({ searchStates: searchStates('text_index', ['READY'], rewritten) })
    await run(collection, { search: [TEXT()] })
    expect(collection.createdSearchIndexes).toEqual([])
  })
})

describe('TS-053 — the default readiness timeout is 300 seconds, and the poll interval is the reference’s', () => {
  it('TS-053 — 300 s and 0.5 s, in milliseconds', () => {
    expect(READY_TIMEOUT_MS).toBe(300_000)
    expect(POLL_INTERVAL_MS).toBe(500)
  })
})

describe('TS-054 — an index that reports READY is checked against the declared definition, not only its status', () => {
  const DRIFTED = {
    fields: [{ type: 'autoEmbed', path: 'content', model: 'voyage-3-lite', modality: 'text' }],
  }

  it('TS-054 — a definition that drifts during the build is refused when it reports ready', async () => {
    const collection = new FakeCollection({
      searchStates: {
        vector_index: [
          [{ name: 'vector_index', status: 'BUILDING', latestDefinition: VECTOR().definition }],
          [{ name: 'vector_index', status: 'READY', latestDefinition: DRIFTED }],
        ],
      },
    })
    const { message } = await rejection(run(collection, { search: [VECTOR()] }))
    expect(message).toContain('voyage-4-lite')
  })

  it('TS-054 — an index this package created is checked against what the server built', async () => {
    const collection = new FakeCollection({
      searchStates: { vector_index: [[], [{ name: 'vector_index', status: 'READY', latestDefinition: DRIFTED }]] },
    })
    const { message } = await rejection(run(collection, { search: [VECTOR()] }))
    expect(message).toContain('does not cover')
  })

  it('TS-054 — the refusal carries the same remedy as the cold path', async () => {
    const collection = new FakeCollection({
      searchStates: { vector_index: [[], [{ name: 'vector_index', status: 'READY', latestDefinition: DRIFTED }]] },
    })
    const { message } = await rejection(run(collection, { search: [VECTOR()] }))
    expect(message).toContain(VECTOR().dropCommand('memory'))
    expect(message).toContain(VECTOR().creationCommand('memory'))
  })

  it('TS-054 — a build whose definition still covers is accepted', async () => {
    const collection = new FakeCollection({
      searchStates: searchStates('vector_index', ['BUILDING', 'READY'], VECTOR().definition),
    })
    await run(collection, { search: [VECTOR()] })
  })

  it('TS-054 — a report that carries no definition is not a gap', async () => {
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING', 'READY']) })
    await run(collection, { search: [VECTOR()] })
  })

  it('TS-054 — the recheck reads nothing the poll was not already reading', async () => {
    const collection = new FakeCollection({
      searchStates: searchStates('vector_index', ['BUILDING', 'READY'], VECTOR().definition),
    })
    await run(collection, { search: [VECTOR()] })
    expect(collection.readsOf('vector_index')).toBe(2)
  })

  it('TS-054 — one drifted index beside one clean one names the drifted one', async () => {
    const collection = new FakeCollection({
      searchStates: {
        ...searchStates('vector_index', ['BUILDING', 'READY'], VECTOR().definition),
        text_index: [
          [{ name: 'text_index', status: 'BUILDING', latestDefinition: TEXT().definition }],
          [{ name: 'text_index', status: 'READY', latestDefinition: { mappings: { dynamic: true, fields: {} } } }],
        ],
      },
    })
    const { message } = await rejection(run(collection, { search: [VECTOR(), TEXT()] }))
    expect(message).toContain("'text_index'")
    expect(message).not.toContain("'vector_index'")
  })
})

describe('TS-055 — the three server codes that mean this deployment has no Atlas Search', () => {
  it('TS-055 — a deployment that lists its search indexes supports search', async () => {
    expect(await searchSupport(new FakeCollection().collection)).toEqual({ available: true })
  })

  it.each([31082, 115, 6047401])('TS-055 — code %s degrades and reports itself', async (code) => {
    const collection = new FakeCollection({ searchStates: { '*': [serverError(code)] } })
    expect(await searchSupport(collection.collection)).toEqual({ available: false, code })
  })

  it('TS-055 — a code outside the measured set throws rather than reading as no search', async () => {
    const cause = serverError(13, 'not authorized')
    const collection = new FakeCollection({ searchStates: { '*': [cause] } })
    const error = await rejection(searchSupport(collection.collection))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('probing Atlas Search support on testdb.memory')
    expect(error.cause).toBe(cause)
  })

  it('TS-055 — the code createSearchIndex answers with is not in the set', async () => {
    const collection = new FakeCollection({ searchStates: { '*': [serverError(59)] } })
    await rejection(searchSupport(collection.collection))
  })

  it('TS-055 — a collection that does not exist still answers the question', async () => {
    const collection = new FakeCollection({ searchStates: { '*': [serverError(26)] } })
    expect(await searchSupport(collection.collection)).toEqual({ available: true })
  })

  it('TS-055 — a probe that never reached the server throws with its cause', async () => {
    const cause = networkError()
    const collection = new FakeCollection({ searchStates: { '*': [cause] } })
    const error = await rejection(searchSupport(collection.collection))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.cause).toBe(cause)
  })
})

describe('TS-056 — whether the deployment can run $rankFusion, from its own version', () => {
  it.each([
    [[6, 0, 0, 0], false],
    [[7, 0, 12, 0], false],
    [[8, 0, 0, 0], true],
    [[8, 0, 23, 0], true],
    [[8, 2, 1, 0], true],
    [[9], true],
  ])('TS-056 — versionArray %j reads as %s', async (versionArray, expected) => {
    const collection = new FakeCollection()
    expect(await rankFusionSupport(new FakeDatabase('testdb', versionArray).db, collection.collection)).toBe(expected)
  })

  it('TS-056 — it reads buildInfo once per call', async () => {
    const database = new FakeDatabase()
    await rankFusionSupport(database.db, new FakeCollection().collection)
    expect(database.commandCalls).toEqual([{ buildInfo: 1 }])
  })

  it.each([{}, [], ['8', 0], [true], [8.5], null, 'x'])(
    'TS-056 — a versionArray of %j reads as unsupported',
    async (versionArray) => {
      const database = new FakeDatabase('testdb', versionArray)
      expect(await rankFusionSupport(database.db, new FakeCollection().collection)).toBe(false)
    },
  )

  it('TS-056 — a reply with no versionArray reads as unsupported', async () => {
    const database = new FakeDatabase()
    database.buildInfo = {}
    expect(await rankFusionSupport(database.db, new FakeCollection().collection)).toBe(false)
    database.buildInfo = null
    expect(await rankFusionSupport(database.db, new FakeCollection().collection)).toBe(false)
  })

  it('TS-056 — a failed buildInfo degrades rather than throwing', async () => {
    const database = new FakeDatabase()
    database.commandError = serverError(13)
    expect(await rankFusionSupport(database.db, new FakeCollection().collection)).toBe(false)
  })
})

describe('TS-040 — the fakes match the driver', () => {
  it('TS-040 — every method the module calls exists on the real classes', () => {
    for (const method of ['indexInformation', 'createIndexes', 'listSearchIndexes', 'createSearchIndex']) {
      expect(typeof (Collection.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
      expect(typeof (FakeCollection.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    for (const method of ['createCollection', 'command']) {
      expect(typeof (Db.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
      expect(typeof (FakeDatabase.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    expect(Object.getOwnPropertyDescriptor(Collection.prototype, 'collectionName')?.get).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(Collection.prototype, 'dbName')?.get).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(Db.prototype, 'databaseName')?.get).toBeDefined()
  })

  it('TS-040 — the real listSearchIndexes returns its cursor synchronously, and it is async-iterable', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:1/')
    try {
      const cursor = client.db('d').collection('c').listSearchIndexes('n')
      // `ListSearchIndexesCursor` is exported as a type only; at runtime it is this subclass.
      expect(cursor).toBeInstanceOf(AggregationCursor)
      expect(typeof cursor[Symbol.asyncIterator]).toBe('function')
      await cursor.close()
    } finally {
      await client.close()
    }
  })

  it('TS-040 — the fake cursor is async-iterable too', () => {
    const cursor = new FakeCollection().listSearchIndexes('n')
    expect(typeof cursor[Symbol.asyncIterator]).toBe('function')
  })
})

describe('TS-057 — indexes.ensure, indexes.probe and indexes.wait are one span each', () => {
  /** Run `work` inside a span called `parent`, standing in for the operation that caused it. */
  function underParent<T>(work: () => Promise<T>): Promise<T> {
    return trace.getTracer('tests').startActiveSpan('parent', async (parent) => {
      try {
        return await work()
      } finally {
        parent.end()
      }
    })
  }

  it('TS-057 — ensure records its mode and how many it created', async () => {
    const spans = exportedSpans()
    const collection = new FakeCollection({ dbName: 'appdb' })
    const database = new FakeDatabase('appdb')
    await underParent(() => run(collection, { ordinary: storageSpecs() }, database))
    await underParent(() => run(collection, { ordinary: storageSpecs(), create: false }, database))
    const [first, second] = named(spans, 'parent').map((parent) =>
      children(spans, parent, 'strands_mongodb.indexes.ensure'),
    )
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first?.[0]?.attributes).toEqual({
      'strands_mongodb.database': 'appdb',
      'strands_mongodb.collection': 'memory',
      'strands_mongodb.indexes.mode': 'ensure',
      'strands_mongodb.indexes.created': 1,
    })
    expect(second?.[0]?.attributes).toMatchObject({
      'strands_mongodb.indexes.mode': 'verify',
      'strands_mongodb.indexes.created': 0,
    })
  })

  it('TS-057 — each probe is a span naming what it probed', async () => {
    const spans = exportedSpans()
    const collection = new FakeCollection()
    await underParent(() => searchSupport(collection.collection))
    await underParent(() => rankFusionSupport(new FakeDatabase().db, collection.collection))
    const probes = named(spans, 'parent').map((parent) => children(spans, parent, 'strands_mongodb.indexes.probe')[0])
    expect(probes.map((probe) => probe?.attributes['strands_mongodb.indexes.probe'])).toEqual(['search', 'rank_fusion'])
    expect(probes.map((probe) => probe?.attributes['strands_mongodb.collection'])).toEqual(['memory', 'memory'])
  })

  it('TS-057 — a wait is one span however many polls it takes', async () => {
    const spans = exportedSpans()
    const collection = new FakeCollection({
      searchStates: searchStates('vector_index', ['BUILDING', 'BUILDING', 'BUILDING', 'READY']),
    })
    await underParent(() => run(collection, { search: [VECTOR()], create: false, timeoutMs: 5_000 }))
    const waits = children(spans, one(spans, 'strands_mongodb.indexes.ensure'), 'strands_mongodb.indexes.wait')
    expect(waits).toHaveLength(1)
    expect(waits[0]?.attributes['strands_mongodb.indexes.outcome']).toBe('ready')
    expect(waits[0]?.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('TS-057 — a failing ensure is an error span with its count so far', async () => {
    const spans = exportedSpans()
    const collection = new FakeCollection()
    collection.createIndexesError = networkError()
    await rejection(underParent(() => run(collection, { ordinary: storageSpecs() })))
    const span = one(spans, 'strands_mongodb.indexes.ensure')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('StorageError')
    expect(span.attributes['strands_mongodb.indexes.created']).toBe(0)
  })
})

describe('TS-058 — a timed-out wait is an outcome and not an error', () => {
  it('TS-058 — the wait span says timed_out, and the caller still gets the error', async () => {
    const spans = exportedSpans()
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING']) })
    const error = await rejection(run(collection, { search: [VECTOR()], create: false, timeoutMs: 0 }))
    expect(error.message).toContain('waited 0s for 1 search index(es) on testdb.memory')
    const wait = one(spans, 'strands_mongodb.indexes.wait')
    expect(wait.attributes['strands_mongodb.indexes.outcome']).toBe('timed_out')
    expect(wait.status.code).toBe(SpanStatusCode.UNSET)
    expect(wait.events).toEqual([])
    expect(one(spans, 'strands_mongodb.indexes.ensure').status.code).toBe(SpanStatusCode.ERROR)
  })

  it('TS-058 — a build that fails mid-wait is an error on the wait span', async () => {
    const spans = exportedSpans()
    const collection = new FakeCollection({ searchStates: searchStates('vector_index', ['BUILDING', 'FAILED']) })
    await rejection(run(collection, { search: [VECTOR()], create: false, timeoutMs: 5_000 }))
    const wait = one(spans, 'strands_mongodb.indexes.wait')
    expect(wait.status.code).toBe(SpanStatusCode.ERROR)
    expect(wait.attributes['strands_mongodb.indexes.outcome']).toBeUndefined()
  })
})

describe('TS-059 — the index records read as they do in Python', () => {
  it('TS-059 — creating, creating a search index, and each status change, at info, with their fields', async () => {
    const collection = new FakeCollection({ dbName: 'appdb' })
    await run(collection, { ordinary: storageSpecs(), search: [VECTOR()] }, new FakeDatabase('appdb'))
    expect(records).toEqual([
      {
        level: 'info',
        fields: { strands_mongodb_event: 'creating_indexes', strands_mongodb_namespace: 'appdb.memory' },
        message: 'strands_mongodb: creating 1 index(es) on appdb.memory: strands_expires_at_ttl',
      },
      {
        level: 'info',
        fields: { strands_mongodb_event: 'creating_search_index', strands_mongodb_namespace: 'appdb.memory' },
        message: "strands_mongodb: creating vectorSearch index 'vector_index' on appdb.memory",
      },
      {
        level: 'info',
        fields: { strands_mongodb_event: 'search_index_status', strands_mongodb_namespace: 'appdb.memory' },
        message: "strands_mongodb: search index 'vector_index' on appdb.memory is READY",
      },
    ])
  })
})
