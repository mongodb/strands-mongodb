/**
 * `MongoDBStorage` against a real deployment: what the server does with the filters and documents the unit
 * tier asserts.
 *
 * Ports the contract classes of `python/tests/test_storage.py`. One claim here cannot move to a fake: that
 * a `sort({ _id: 1 })` over a bounded range returns keys in the order the SDK's own `sort()` would. The SDK's
 * snapshot history reads its ordering from that, and a fake asserting it would be asserting itself.
 *
 * The checklist ids are used as they are. The rest lead with `TS-` ids, the same ones the unit tier gives
 * their unit halves where there is one: AT-030 is TS-066, AT-229 TS-072, AT-121b TS-074, AT-176 TS-077,
 * AT-192 TS-078 and the driver's call shapes TS-081. The ids with no unit half are new:
 * AT-031 is TS-084, AT-035 TS-085, AT-038b TS-086, AT-032e TS-087, AT-122 TS-088, and a payload stored under
 * another binary subtype TS-089.
 *
 * AT-091b, one store across two event loops, has no TypeScript counterpart: Node has one loop per thread
 * and the driver is not bound to it.
 */
import { randomBytes } from 'node:crypto'

import { SessionManager, StorageError } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import type { Snapshot, SnapshotLocation, SnapshotStorage } from '@strands-agents/sdk'
import { AggregationCursor, Binary, Collection, FindCursor, MongoServerError } from 'mongodb'
import type { Document } from 'mongodb'
import { afterEach, expect, it, vi } from 'vitest'

import { resolve } from '../../src/client.js'
import { readCollation, requireBinaryComparison } from '../../src/index-lifecycle.js'
import { MongoDBStorage } from '../../src/storage.js'
import { tokenize, tokenOverlapScore } from '../../src/tokenize.js'
import type { MongoDBConfig, MongoDBStorageOptions } from '../../src/types.js'
import { EXPIRES_FIELD, MAX_DOCUMENT_BYTES } from '../../src/types.js'
import { type Deployment, useDeployment, uniqueName } from '../support/deployment.js'
import { describeTier, tierValue } from '../support/tiers.js'

/** A collation that folds case, as an operator's own tooling might set one. */
const FOLDING = { locale: 'en', strength: 2 }

/** `bytes(range(256))`. */
const EVERY_BYTE = Uint8Array.from({ length: 256 }, (_, index) => index)

/**
 * AT-024's payloads. The empty one catches an `?? null` on the way out, and the 4 MiB one a payload the driver
 * had to chunk. A named table because the gate's static scan reads an `it.each` title only when the call's
 * argument has no parentheses in it.
 */
const PAYLOADS: ReadonlyArray<[string, Uint8Array]> = [
  ['empty', new Uint8Array()],
  ['nul', Uint8Array.of(0)],
  ['every byte', EVERY_BYTE],
  ['four mebibytes', new Uint8Array(256 * 16384).map((_, index) => index % 256)],
]

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | null): string | null => (bytes === null ? null : new TextDecoder().decode(bytes))

/**
 * A UUID7 whose 48-bit timestamp is `milliseconds`, in the layout the SDK's `uuid` dependency produces.
 * Generated here, one millisecond apart, so the order is the timestamp's and not the generator's.
 */
function uuid7(milliseconds: number): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(milliseconds, 0, 6)
  bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `count` UUID7s in chronological order. */
function uuid7s(count: number): string[] {
  const start = Date.now()
  return Array.from({ length: count }, (_, index) => uuid7(start + index))
}

/**
 * Stores built over one deployment, each on a fresh collection, closed after every test.
 *
 * Stores share the deployment's client through `config.client`, which the package never closes. One store per
 * call in `connectionString` mode exercises the package's own client, which `close()` does release.
 */
function useStores(deployment: () => Deployment): {
  store: (options?: MongoDBStorageOptions & { viaConnectionString?: boolean }) => MongoDBStorage
  raw: (store: MongoDBStorage) => Collection
} {
  const opened: MongoDBStorage[] = []
  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close()
  })
  return {
    store: ({ viaConnectionString = false, ...options } = {}) => {
      const { client, db } = deployment()
      const config: MongoDBConfig = viaConnectionString
        ? { database: db.databaseName, connectionString: tierValue('contract') }
        : { database: db.databaseName, client }
      const store = new MongoDBStorage(config, { collection: uniqueName('s_'), ...options })
      opened.push(store)
      return store
    },
    raw: (store) => deployment().db.collection(store.collectionName),
  }
}

describeTier('contract', 'the five methods against a real deployment', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it('AT-020 — write overwrites rather than appending', async () => {
    const storage = store({ viaConnectionString: true })
    await storage.write('a/b', encode('first'))
    await storage.write('a/b', encode('second'))

    expect(decode(await storage.read('a/b'))).toBe('second')
    expect(await storage.list('')).toEqual(['a/b'])
  })

  it('AT-021 — reading an absent key returns null', async () => {
    expect(await store().read('never/written')).toBeNull()
  })

  it('AT-023 — deleting an absent key is a no-op, and so is deleting one twice', async () => {
    const storage = store()
    await storage.delete('never/written')

    await storage.write('a/b', encode('payload'))
    await storage.delete('a/b')
    await storage.delete('a/b')

    expect(await storage.read('a/b')).toBeNull()
  })

  it.each(PAYLOADS)('AT-024 — bytes round-trip unchanged: %s', async (_label, payload) => {
    const storage = store()
    await storage.write('a/b', payload)

    const found = await storage.read('a/b')

    expect(found?.constructor).toBe(Uint8Array)
    expect(found).toEqual(payload)
  })

  it('TS-089 — a payload stored under another binary subtype reads back as plain bytes', async () => {
    // A collection also written by another driver may hold subtype 2, the old binary subtype. js-bson
    // decodes every subtype as a `Binary`, so without the copy in `read` the caller would get the wrapper.
    const storage = store()
    await raw(storage).replaceOne(
      { _id: 'a/b' as never },
      { _id: 'a/b', data: new Binary(encode('payload'), Binary.SUBTYPE_BYTE_ARRAY) },
      { upsert: true },
    )
    const stored = await raw(storage).findOne({ _id: 'a/b' as never })
    expect((stored?.data as Binary).sub_type).toBe(Binary.SUBTYPE_BYTE_ARRAY)

    const found = await storage.read('a/b')

    expect(found?.constructor).toBe(Uint8Array)
    expect(decode(found)).toBe('payload')
  })

  it("AT-025 — list('') returns every key", async () => {
    const storage = store()
    for (const key of ['a/one', 'b/two', 'c/three']) await storage.write(key, encode('payload'))

    expect(await storage.list('')).toEqual(['a/one', 'b/two', 'c/three'])
  })

  it('AT-026 — list returns full keys rather than suffixes', async () => {
    const storage = store()
    await storage.write('a/one', encode('payload'))
    await storage.write('a/two', encode('payload'))

    expect(await storage.list('a/')).toEqual(['a/one', 'a/two'])
  })

  it("AT-026 / AT-027 — list order equals the SDK's own storage, on keys that separate byte order from anything else", async () => {
    // Digits before letters, uppercase before lowercase, and a multi-byte code point last. The SDK's
    // `InMemoryStorage` sorts with `Array.prototype.sort`, which is what its session adapter assumes.
    const keys = ['a/10', 'a/2', 'a/B', 'a/a', 'a/é', 'a/Z']
    const storage = store()
    const reference = new InMemoryStorage()
    for (const key of keys) {
      await storage.write(key, encode('payload'))
      await reference.write(key, encode('payload'))
    }

    const found = await storage.list('a/')

    expect(found).toEqual(await reference.list('a/'))
    expect(found).toEqual(['a/10', 'a/2', 'a/B', 'a/Z', 'a/a', 'a/é'])
  })

  it('AT-027 — a UUID7 snapshot history lists chronologically', async () => {
    // UUID7's leading 48 bits are a millisecond timestamp, so the hex form sorts chronologically, and the
    // `_id` sort is what has to preserve that. Written newest first, so insertion order cannot pass for it.
    const storage = store()
    const prefix = 'session/s1/scopes/agent/a1/snapshots/immutable_history/'
    const identifiers = uuid7s(25)
    for (const identifier of [...identifiers].reverse()) {
      await storage.write(`${prefix}snapshot_${identifier}.json`, encode('payload'))
    }

    expect(await storage.list(prefix)).toEqual(identifiers.map((identifier) => `${prefix}snapshot_${identifier}.json`))
  })

  it("AT-081 — the snapshot keys the SDK's session manager builds round-trip, unscoped once", async () => {
    // The SDK's own adapter, taken from a real `SessionManager`, so the keys are the SDK's and not this file's.
    // `namespace('session')` carries the SDK's marker, so the manager uses the view as it is rather than
    // scoping it a second time to `session/session/...`.
    const storage = store()
    const scoped = storage.namespace('session')
    const manager = new SessionManager({ sessionId: 's1', storage: scoped })
    const adapter = (manager as unknown as { _storage: { snapshot: SnapshotStorage } })._storage.snapshot
    const location: SnapshotLocation = { sessionId: 's1', scope: 'agent', scopeId: 'a1' }
    const snapshot = (messages: number): Snapshot => ({ messages }) as unknown as Snapshot

    // The latest snapshot is overwritten on every save, so a backend that appended or refused the second
    // write would leave the manager reading a stale session.
    await adapter.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot(0) })
    await adapter.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot(1) })
    expect(await adapter.loadSnapshot({ location })).toEqual({ messages: 1 })

    const latest = await raw(storage).findOne({
      _id: 'session/s1/scopes/agent/a1/snapshots/snapshot_latest.json' as never,
    })
    expect(latest).not.toBeNull()

    const identifiers = uuid7s(3)
    for (const identifier of [...identifiers].reverse()) {
      await adapter.saveSnapshot({ location, snapshotId: identifier, isLatest: false, snapshot: snapshot(2) })
    }

    expect(await adapter.listSnapshotIds({ location })).toEqual(identifiers)
    // Both shapes in one listing: the history directory sorts ahead of the latest key on its first byte.
    expect(await scoped.list('s1/scopes/agent/a1/snapshots/')).toEqual([
      ...identifiers.map((identifier) => `s1/scopes/agent/a1/snapshots/immutable_history/snapshot_${identifier}.json`),
      's1/scopes/agent/a1/snapshots/snapshot_latest.json',
    ])
  })

  it('AT-028 — list on a prefix matching nothing returns an empty array', async () => {
    // The neighbouring key proves the range bound excludes it, rather than the collection being empty.
    const storage = store()
    await storage.write('sessions-archive/abc', encode('payload'))

    expect(await storage.list('sessions/')).toEqual([])
  })

  it('AT-029 — an oversized payload is refused naming the key, and nothing is written', async () => {
    const storage = store()

    const error = await storage.write('a/b', new Uint8Array(MAX_DOCUMENT_BYTES)).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StorageError)
    expect((error as Error).message).toContain("'a/b'")
    expect(await raw(storage).countDocuments({})).toBe(0)
  })

  it("TS-086 — the size ceiling is the server's own", async () => {
    const hello = await deployment().db.admin().command({ hello: 1 })

    expect(MAX_DOCUMENT_BYTES).toBe(hello.maxBsonObjectSize)
  })

  it('TS-066 — a namespaced write stores the full id and lists without the prefix', async () => {
    const storage = store()
    const scoped = storage.namespace('tenant-a')
    await scoped.write('sessions/abc', encode('payload'))

    expect(await raw(storage).findOne({ _id: 'tenant-a/sessions/abc' as never })).not.toBeNull()
    expect(await scoped.list('')).toEqual(['sessions/abc'])
  })

  it('TS-066 — a namespace does not see a sibling whose name it prefixes', async () => {
    const storage = store()
    await storage.namespace('tenant-a').write('k', encode('a'))
    await storage.namespace('tenant-ab').write('k', encode('ab'))

    expect(await storage.namespace('tenant-a').list('')).toEqual(['k'])
    expect(decode(await storage.namespace('tenant-a').read('k'))).toBe('a')
    expect(await storage.namespace('tenant-a').deletePrefix('')).toBe(1)
    expect(decode(await storage.namespace('tenant-ab').read('k'))).toBe('ab')
  })

  it('TS-084 — deletePrefix removes exactly the prefix and reports the count', async () => {
    const storage = store()
    for (const key of ['a/one', 'a/two', 'a/three', 'b/four']) await storage.write(key, encode('payload'))

    expect(await storage.deletePrefix('a/')).toBe(3)
    expect(await storage.list('')).toEqual(['b/four'])
    expect(await storage.deletePrefix('nothing')).toBe(0)
  })

  it('TS-085 — a TTL store stamps expires_at as a date, and a store without one stamps nothing', async () => {
    const before = Date.now()
    const expiring = store({ ttlSeconds: 60 })
    const lasting = store()
    await expiring.write('k', encode('v'))
    await lasting.write('k', encode('v'))

    const stamped = (await raw(expiring).findOne({ _id: 'k' as never }))?.[EXPIRES_FIELD] as unknown
    const unstamped = await raw(lasting).findOne({ _id: 'k' as never })

    expect(stamped).toBeInstanceOf(Date)
    expect((stamped as Date).getTime()).toBeGreaterThanOrEqual(before + 60_000 - 1000)
    expect(unstamped).not.toHaveProperty(EXPIRES_FIELD)
  })

  it('TS-081 — find returns its cursor synchronously, deleteMany reports a count', async () => {
    // The call shapes the fake copies, against the driver rather than against its type declarations.
    const collection = deployment().db.collection(uniqueName('p_'))
    await collection.insertMany([{ _id: 'a/2' as never }, { _id: 'a/1' as never }])

    const cursor = collection.find({}, { projection: { _id: 1 } })

    expect(cursor).toBeInstanceOf(FindCursor)
    expect(await cursor.sort({ _id: 1 }).toArray()).toEqual([{ _id: 'a/1' }, { _id: 'a/2' }])
    expect((await collection.deleteMany({})).deletedCount).toBe(2)
  })
})

describeTier('contract', 'search against a real deployment', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  const KEYS = [
    'notes/dark-mode-toggle.md',
    'notes/toggle-dark.md',
    'notes/café-münchen.md',
    'notes/日本語.md',
    'sessions/s1/state.json',
  ]

  /** Payloads large enough that a document fetch would be visible in `totalDocsExamined`. */
  async function seed(storage: MongoDBStorage): Promise<void> {
    for (const key of KEYS) await storage.write(key, new Uint8Array(400).fill(0x78))
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TS-072 — a namespaced store does not match its own prefix', async () => {
    const scoped = store().namespace('sessions')
    await scoped.write('s1/state.json', encode('{}'))
    await scoped.write('s2/dark-mode.json', encode('{}'))

    expect(await scoped.search('sessions')).toEqual([])
    expect((await scoped.search('dark')).map((result) => result.key)).toEqual(['s2/dark-mode.json'])
  })

  it('AT-032b — results are keys and numeric scores, with no payload', async () => {
    const storage = store()
    await seed(storage)

    const found = await storage.search('dark mode')

    expect(found.map((result) => result.key)).toEqual(['notes/dark-mode-toggle.md', 'notes/toggle-dark.md'])
    for (const result of found) {
      expect(typeof result.score).toBe('number')
      expect(result).not.toHaveProperty('data')
    }
  })

  // `[\p{L}\p{N}_]+` and not `\w+`: the server's `\w` is ASCII-only, so `\w+` would split `café` and drop
  // `日本語`, and both mangled forms still return results. Only a comparison with the SDK's scorer shows it.
  it.each(['dark mode toggle', 'münchen café', '日本語', 'state json', 'toggle', 'nothing at all here'])(
    'AT-032d — the server scores %j exactly as the SDK would, over keys',
    async (query) => {
      const storage = store()
      await seed(storage)
      const tokens = tokenize(query)
      const expected = KEYS.map((key) => ({ key, score: tokenOverlapScore(tokens, key) }))
        .filter((result) => result.score > 0)
        .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

      expect(await storage.search(query)).toEqual(expected)
    },
  )

  it('AT-032d — a mixed-case key matches a lowercase query', async () => {
    // Every other key here is lowercase, so this is the one test where `$toLower` on the key does any work.
    const storage = store()
    await storage.write('Sessions/Agent-1/State.json', encode('x'))

    expect(await storage.search('sessions agent')).toEqual([{ key: 'Sessions/Agent-1/State.json', score: 2 }])
  })

  it('AT-032d — a token only in a payload does not match', async () => {
    // The one intended divergence from the SDK's default, which scores `${key} ${content}`. It buys the
    // covered scan below.
    const storage = store()
    await storage.write('notes/one.md', encode('needle'))

    expect(await storage.search('needle')).toEqual([])
    expect((await storage.search('notes one')).map((result) => result.key)).toEqual(['notes/one.md'])
  })

  it('AT-033 — scores are positive, never increase, and ties break by ascending key', async () => {
    const storage = store()
    await seed(storage)

    const found = await storage.search('notes toggle')
    const ordered = [...found].sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))

    expect(found.length).toBeGreaterThan(1)
    expect(found.every((result) => result.score > 0)).toBe(true)
    expect(found).toEqual(ordered)
  })

  it('TS-087 — the scan is covered by the _id index and fetches no documents', async () => {
    // A namespaced store's range gives the planner an IXSCAN on `_id_`, and since `_id` is the only field the
    // pipeline reads, no document is fetched although each carries 400 bytes. The pipeline is the one
    // `search` sent, captured on its way to the driver.
    const storage = store()
    const scoped = storage.namespace('tenant-a')
    await seed(scoped)
    const aggregate = vi.spyOn(Collection.prototype, 'aggregate')
    await scoped.search('dark mode')
    const pipeline = aggregate.mock.calls[0]?.[0] as Document[]

    const plan = await deployment().db.command({
      explain: { aggregate: storage.collectionName, pipeline, cursor: {} },
      verbosity: 'executionStats',
    })

    const winning = collect(plan, 'winningPlan')
    expect(winning.length).toBeGreaterThan(0)
    expect(JSON.stringify(winning)).toContain('IXSCAN')
    expect(JSON.stringify(winning)).not.toContain('COLLSCAN')
    const examined = collect(plan, 'totalDocsExamined')
    expect(examined.length).toBeGreaterThan(0)
    expect(examined.every((count) => count === 0)).toBe(true)
  })

  it('TS-081 — aggregate returns its cursor synchronously', async () => {
    const storage = store()
    await raw(storage).insertOne({ _id: 'a/one' as never, data: encode('x') })

    const cursor = raw(storage).aggregate([{ $match: { _id: 'a/one' } }, { $project: { _id: 1 } }])

    expect(cursor).toBeInstanceOf(AggregationCursor)
    expect(await cursor.toArray()).toEqual([{ _id: 'a/one' }])
  })
})

/**
 * Every value under `field`, anywhere in an explain document. The shape differs by server version and query
 * engine: the classic engine nests the plan under `stages[0].$cursor`, the slot-based one puts it at the top.
 */
function collect(document: unknown, field: string): unknown[] {
  if (Array.isArray(document)) return document.flatMap((item) => collect(item, field))
  if (document === null || typeof document !== 'object') return []
  return Object.entries(document).flatMap(([key, value]) => (key === field ? [value] : collect(value, field)))
}

describeTier('contract', 'TS-074 — ensureIndexes against a real deployment', () => {
  const deployment = useDeployment('contract')
  const { store, raw } = useStores(deployment)

  it('TS-074 — creates the TTL index, and a second call leaves it alone', async () => {
    // The second call is where a real `createIndexes` would fail: the server rejects a second index over the
    // same keys under another name, so options that did not round-trip would throw here.
    const storage = store({ ttlSeconds: 60 })
    await storage.ensureIndexes()
    await storage.ensureIndexes()

    const indexes = await raw(storage).indexInformation({ full: true })
    const ttl = indexes.find((index) => index.name === 'strands_expires_at_ttl')

    expect(ttl?.expireAfterSeconds).toBe(0)
    expect(ttl?.key).toEqual({ [EXPIRES_FIELD]: 1 })
  })
})

describeTier('contract', 'TS-088 — a document written with a TTL expires', () => {
  const deployment = useDeployment('contract')
  const { store } = useStores(deployment)

  // The TTL monitor sweeps once a minute, so a one-second lifetime ends on the first sweep after it: under
  // 60 seconds typically, 120 in the worst alignment. 180 is that plus a sweep. The poll is coarse because
  // the answer changes once.
  const EXPIRY_BUDGET_MS = 180_000
  const EXPIRY_POLL_MS = 5_000

  it(
    'TS-088 — the outcome, not the index: a read returns null once the monitor has swept',
    async () => {
      // The only test in the suite that waits on wall-clock time, because the thing that removes the
      // document is a background task in `mongod` that nothing in this package can be asked about.
      const storage = store({ ttlSeconds: 1 })
      await storage.ensureIndexes()
      await storage.write('expiring/key', encode('payload'))
      // Read back first, so a null at the end cannot be a write that never landed.
      expect(decode(await storage.read('expiring/key'))).toBe('payload')

      const deadline = Date.now() + EXPIRY_BUDGET_MS
      while ((await storage.read('expiring/key')) !== null) {
        if (Date.now() > deadline) {
          throw new Error(
            `the document was still readable ${EXPIRY_BUDGET_MS / 1000}s after it expired. The monitor sweeps ` +
              'once a minute, so this is not a slow sweep: either the index is absent or the deployment has ' +
              'ttlMonitorEnabled set to false.',
          )
        }
        await new Promise((done) => setTimeout(done, EXPIRY_POLL_MS))
      }
    },
    EXPIRY_BUDGET_MS + 30_000,
  )
})

describeTier('contract', 'TS-077 — a case-folding collection against a real deployment', () => {
  const deployment = useDeployment('contract')
  const { store } = useStores(deployment)

  /** A collection created with a case-folding collation. */
  async function folded(): Promise<Collection> {
    return deployment().db.createCollection(uniqueName('f_'), { collation: FOLDING })
  }

  it('TS-077 — the server reports the collation where the preflight reads it', async () => {
    const collection = await folded()

    const report = await readCollation(deployment().db, collection)

    expect(report.exists).toBe(true)
    expect(report.collation?.locale).toBe('en')
    expect(report.collation?.strength).toBe(2)
  })

  it('TS-077 — an uncollated collection reports none, and is still reported as there', async () => {
    // The vacuity guard for the test above: a check that reported a collation for every collection would pass
    // that one and refuse every store anybody has.
    const collection = await deployment().db.createCollection(uniqueName('plain_'))

    const report = await readCollation(deployment().db, collection)

    expect(report.collation).toBeUndefined()
    expect(report.exists).toBe(true)
  })

  it('TS-077 — the server does not store an explicit simple collation', async () => {
    // The reason the unit tier's `simple` case cannot be reached from a deployment.
    const collection = await deployment().db.createCollection(uniqueName('simple_'), {
      collation: { locale: 'simple' },
    })

    const report = await readCollation(deployment().db, collection)

    expect(report.collation).toBeUndefined()
    expect(report.exists).toBe(true)
  })

  it('TS-077 — a store over it refuses before writing anything', async () => {
    const collection = await folded()
    const storage = store({ collection: collection.collectionName, viaConnectionString: true })

    const error = await storage.write('k', encode('v')).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StorageError)
    expect((error as Error).message).toContain('collation')
    expect(await collection.countDocuments({})).toBe(0)
  })

  // What the refusal is refusing, in the driver against the raw collection, since a store over it refuses.

  it('TS-077 — the equality a namespaced read issues crosses the namespace', async () => {
    const collection = await folded()
    await collection.insertOne({ _id: 'Tenant-A/private' as never, data: encode('secret') })

    const found = await collection.findOne({ _id: 'tenant-a/private' as never })

    // Null would mean the deployment no longer folds case, and this block checks nothing.
    expect(found?._id).toBe('Tenant-A/private')
  })

  it('TS-077 — two keys differing only in case collide on the _id index', async () => {
    // The `_id` index is unique and its collation cannot be chosen, so the key space collapses.
    const collection = await folded()
    await collection.insertOne({ _id: 'tenant-a/private' as never, data: encode('one') })

    const error = await collection
      .insertOne({ _id: 'Tenant-A/private' as never, data: encode('two') })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MongoServerError)
    expect((error as MongoServerError).code).toBe(11000)
  })

  it('TS-077 — the range a prefix delete builds crosses the namespace', async () => {
    const collection = await folded()
    await collection.insertOne({ _id: 'Tenant-A/private' as never, data: encode('secret') })

    const matched = await collection.find({ _id: { $gte: 'tenant-a/', $lt: 'tenant-a0' } as never }).toArray()

    expect(matched.map((document) => document._id)).toEqual(['Tenant-A/private'])
  })
})

describeTier('contract', 'TS-078 — an absent collection against a real deployment', () => {
  const deployment = useDeployment('contract')
  const { store } = useStores(deployment)

  it('TS-078 — a collection never created reports that it is not there', async () => {
    const report = await readCollation(deployment().db, deployment().db.collection(uniqueName('never_')))

    expect(report.exists).toBe(false)
    expect(report.collation).toBeUndefined()
  })

  it('TS-078 — the preflight declines to verify an absent collection and verifies the one beside it', async () => {
    // In one test so neither answer can pass alone: a preflight that answered false for everything would pass
    // the first assertion and never cache anything.
    const { db } = deployment()
    const present = await db.createCollection(uniqueName('present_'))

    expect(await requireBinaryComparison(db, db.collection(uniqueName('absent_')))).toBe(false)
    expect(await requireBinaryComparison(db, present)).toBe(true)
  })

  it('TS-078 — a store over an empty database keeps asking until its own write creates the collection', async () => {
    const storage = store({ viaConnectionString: true })
    const config: MongoDBConfig = { database: storage.databaseName, connectionString: tierValue('contract') }
    const cache = resolve(config, 'MongoDBStorage').binaryKeys
    const target = `${storage.databaseName}.${storage.collectionName}`

    expect(await storage.read('absent')).toBeNull()
    expect(cache.has(target)).toBe(false)

    await storage.write('k', encode('v'))
    expect(decode(await storage.read('k'))).toBe('v')

    expect(cache.has(target)).toBe(true)
  })
})
