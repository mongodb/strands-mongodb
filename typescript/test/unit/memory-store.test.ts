/**
 * `MongoDBMemoryStore` against a fake client injected through `config.client`, with the four index-lifecycle
 * calls `initialize()` makes replaced by a recorder.
 *
 * Ports the unit tier of `python/tests/test_memory_store.py`. What a fake cannot show, that a server
 * agrees, is `test/contract/memory-store.test.ts` and `test/integration/memory-store.test.ts`. The fake is
 * the Python file's `_RecordingCollection`: fixed documents in, recorded stages out. It matches and ranks
 * nothing, so every claim about matching or ranking is on a tier below.
 *
 * The checklist ids are used as they are. The Python ids that are not checklist items lead with `TS-` ids:
 * AT-052 is TS-112, AT-052a TS-113, AT-044d TS-114, AT-057 TS-115, AT-055 TS-116, AT-058 TS-117, AT-059a
 * TS-118, AT-076 TS-119, AT-077 TS-120, AT-082 TS-121, AT-083 TS-122, AT-084 TS-123, AT-079 TS-124, AT-125
 * and AT-126 TS-125, AT-242 TS-126, AT-078 and AT-166 TS-127, AT-176 and AT-065b TS-128, AT-192 TS-129,
 * AT-146 and AT-147 TS-130, AT-157 TS-131, AT-148, AT-149 and AT-150 TS-132, AT-014's memory half TS-133,
 * AT-153 and AT-154 TS-134, AT-155 and AT-156 TS-135, AT-227 TS-136, AT-243 TS-137, AT-208 TS-138, and the
 * memory spans of `test_telemetry.py` TS-139. TS-150 has no Python counterpart: the entry point exports the
 * store, and its type satisfies the SDK's `MemoryStore`.
 *
 * Python's event-loop tests (a store used from a second loop, a cancelled waiter) have no counterpart: Node
 * has one loop, and a promise is not cancelled.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { MemoryManager, StorageError } from '@strands-agents/sdk'
import type { MemoryStore } from '@strands-agents/sdk'
import { BSON, Double, MongoClient, MongoServerError, ObjectId } from 'mongodb'
import type { Document } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REGISTRY, type Connection } from '../../src/client.js'
import * as lifecycle from '../../src/index-lifecycle.js'
import { memorySpecs, storageSpecs } from '../../src/indexes.js'
import { EXPIRES_OVERHEAD_BYTES } from '../../src/keys.js'
import { memoryInternals, MongoDBMemoryStore } from '../../src/memory-store.js'
import { MongoDBStorage } from '../../src/storage.js'
import { configureLogging, logger as currentLogger } from '../../src/telemetry.js'
import type { MongoDBConfig, MongoDBMemoryStoreConfig } from '../../src/types.js'
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_STORAGE_COLLECTION,
  EXPIRES_FIELD,
  READY_TIMEOUT_MS,
  RESERVED_METADATA_KEYS,
  TIER_RETRY_MAX_MS,
  TIER_RETRY_MS,
} from '../../src/types.js'
import { exportedSpans, named, one, rendered } from '../support/spans.js'
import { networkError } from '../support/fake-indexes.js'
import { FakeStorageDatabase } from '../support/fake-storage.js'

// Pass-through mocks: every test that does not install a recorder runs the real function.
vi.mock('../../src/index-lifecycle.js', async (original) => {
  const actual = await original<typeof import('../../src/index-lifecycle.js')>()
  return {
    ...actual,
    ensure: vi.fn(actual.ensure),
    searchSupport: vi.fn(actual.searchSupport),
    rankFusionSupport: vi.fn(actual.rankFusionSupport),
    requireBinaryComparison: vi.fn(actual.requireBinaryComparison),
  }
})

/** The password the leak tests look for. */
const PASSWORD = 'SUPERSECRET'

/** Reason a refused index build carries, worded so a failure report cannot be read as a real server error. */
const PRETEND_REASON = 'no embedding model is registered (a stand-in for that failure, not a server message)'

/** The code a deployment without Atlas Search answers `listSearchIndexes` with. */
const NO_SEARCH_CODE = 6047401

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** Yield to the event loop once, as each Python fake does with `await asyncio.sleep(0)`. */
const tick = (): Promise<void> => new Promise((done) => setImmediate(done))

// ---------------------------------------------------------------------------------------------------------
// The fake collection and client
// ---------------------------------------------------------------------------------------------------------

/** A collection that records what it was handed and answers with documents the test wrote. */
class RecordingCollection {
  readonly pipelines: Document[][] = []
  readonly upserts: [Document, Document][] = []
  readonly finds: Document[] = []
  readonly deletes: Document[] = []
  deleted = 0
  /** What `updateOne` reports: an id when it inserted, `null` when it matched. */
  upsertedId: ObjectId | null = new ObjectId()
  /** An error `updateOne` throws instead, such as a duplicate-key error from a racing writer. */
  updateFailure: Error | undefined
  existing: Document | null = { _id: new ObjectId() }

  constructor(
    readonly collectionName: string,
    readonly dbName: string,
    public documents: Document[] = [{ _id: 'abc', content: 'the user prefers dark mode' }],
    public failure: Error | undefined = undefined,
  ) {}

  aggregate(pipeline: Document[]): AsyncIterable<Document> {
    this.pipelines.push(pipeline.map((stage) => ({ ...stage })))
    const { failure, documents } = this
    return (async function* () {
      if (failure !== undefined) throw failure
      for (const document of documents) yield { ...document }
    })()
  }

  async updateOne(selector: Document, update: Document): Promise<Document> {
    this.upserts.push([{ ...selector }, { ...update }])
    if (this.failure !== undefined) throw this.failure
    if (this.updateFailure !== undefined) throw this.updateFailure
    return { upsertedId: this.upsertedId }
  }

  async findOne(selector: Document): Promise<Document | null> {
    this.finds.push({ ...selector })
    return this.existing
  }

  async deleteOne(selector: Document): Promise<Document> {
    this.deletes.push({ ...selector })
    if (this.failure !== undefined) throw this.failure
    return { deletedCount: this.deleted }
  }

  async deleteMany(selector: Document): Promise<Document> {
    this.deletes.push({ ...selector })
    if (this.failure !== undefined) throw this.failure
    return { deletedCount: this.deleted }
  }

  /** The one recorded pipeline. */
  get stages(): Document[] {
    expect(this.pipelines).toHaveLength(1)
    return this.pipelines[0] as Document[]
  }
}

/** A client whose every collection is a {@link RecordingCollection}, one per name. */
class FakeClient {
  readonly collections = new Map<string, RecordingCollection>()
  readonly options = {}

  appendMetadata(): void {}

  db(name: string): Document {
    return {
      databaseName: name,
      collection: (collection: string) => this.collection(collection, name),
    }
  }

  collection(name = 'memory', database = 'appdb'): RecordingCollection {
    const key = `${database}.${name}`
    let found = this.collections.get(key)
    if (found === undefined) {
      found = new RecordingCollection(name, database)
      this.collections.set(key, found)
    }
    return found
  }

  get asClient(): MongoClient {
    return this as unknown as MongoClient
  }
}

/** The one stage using `operator`. */
function stageOf(stages: Document[], operator: string): Document {
  const found = stages.filter((stage) => operator in stage)
  expect(found).toHaveLength(1)
  return (found[0] as Document)[operator] as Document
}

// ---------------------------------------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------------------------------------

let client: FakeClient

/** A connection config on the current fake client. */
function connection(overrides: Partial<MongoDBConfig> = {}): MongoDBConfig {
  return { database: 'appdb', client: client.asClient, ...overrides }
}

/** A store on the fake client, nesting the connection half under `config`. */
function store(overrides: Partial<MongoDBMemoryStoreConfig> = {}): MongoDBMemoryStore {
  return new MongoDBMemoryStore({ name: 'facts', config: connection(), ...overrides })
}

/** Put a store in the state `initialize()` would leave it in, and return its recording collection. */
function prepared(
  target: MongoDBMemoryStore,
  options: { documents?: Document[]; tiers?: readonly string[]; failure?: Error } = {},
): RecordingCollection {
  const collection = client.collection()
  if (options.documents !== undefined) collection.documents = options.documents
  collection.failure = options.failure
  memoryInternals.prepare(target, options.tiers ?? ['text'])
  return collection
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

/** The metadata of an entry, which every entry this store returns carries. */
function metadataOf(entry: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  expect(entry.metadata).toBeDefined()
  return entry.metadata as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------------------
// The setup recorder
// ---------------------------------------------------------------------------------------------------------

interface RecorderOptions {
  available?: boolean
  failing?: Iterable<string>
  rankFusion?: boolean
  refuseCollation?: boolean
  absentUntilProvisioned?: boolean
}

/** A stand-in for the four index-lifecycle calls `initialize()` makes, which can refuse a named index. */
class SetupRecorder {
  available: boolean
  rankFusion: boolean
  refuseCollation: boolean
  absentUntilProvisioned: boolean
  readonly failing: Set<string>
  readonly building = new Set<string>()
  readonly collations: string[] = []
  readonly fusionProbes: string[] = []
  readonly probes: string[] = []
  readonly ordinary: string[][] = []
  readonly search: string[] = []
  readonly timeouts: (number | undefined)[] = []
  readonly creates: (boolean | undefined)[] = []

  constructor(options: RecorderOptions = {}) {
    this.available = options.available ?? true
    this.failing = new Set(options.failing ?? [])
    this.rankFusion = options.rankFusion ?? false
    this.refuseCollation = options.refuseCollation ?? false
    this.absentUntilProvisioned = options.absentUntilProvisioned ?? false
    vi.mocked(lifecycle.requireBinaryComparison).mockImplementation(async (_db, collection) => {
      this.collations.push(collection.collectionName)
      await tick()
      if (this.refuseCollation) {
        throw new StorageError(
          `strands_mongodb: the collection appdb.${collection.collectionName} was created with the collation ` +
            "'en', and this package cannot store keys in a collection whose string comparison is not binary.",
        )
      }
      return !(this.absentUntilProvisioned && this.collations.length === 1)
    })
    vi.mocked(lifecycle.searchSupport).mockImplementation(async (collection) => {
      this.probes.push(collection.collectionName)
      await tick()
      return this.available ? { available: true } : { available: false, code: NO_SEARCH_CODE }
    })
    vi.mocked(lifecycle.rankFusionSupport).mockImplementation(async (_db, collection) => {
      this.fusionProbes.push(collection.collectionName)
      await tick()
      return this.rankFusion
    })
    vi.mocked(lifecycle.ensure).mockImplementation(async (_db, _collection, options = {}) => {
      this.timeouts.push(options.timeoutMs)
      this.creates.push(options.create)
      if (options.ordinary !== undefined && options.ordinary.length > 0) {
        this.ordinary.push(options.ordinary.map((spec) => spec.name))
      }
      for (const spec of options.search ?? []) {
        if (this.failing.has(spec.name)) {
          throw new StorageError(`strands_mongodb: creating ${spec.name} failed: ${PRETEND_REASON}`)
        }
        if (this.building.has(spec.name)) {
          throw new lifecycle.SearchIndexNotReady(`strands_mongodb: ${spec.name} is still building`)
        }
        this.search.push(spec.name)
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------------------------------------

interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly fields: Record<string, unknown>
  readonly message: string
}

let records: LogRecord[] = []
const original = currentLogger

/** Every record of one event. */
function recordsOf(event: string): LogRecord[] {
  return records.filter((record) => record.fields.strands_mongodb_event === event)
}

beforeEach(() => {
  REGISTRY.clear()
  client = new FakeClient()
  records = []
  const capture =
    (level: LogRecord['level']) =>
    (fields: unknown, message?: unknown): void => {
      records.push({ level, fields: fields as Record<string, unknown>, message: String(message) })
    }
  configureLogging({ debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') })
  // A default deployment with search and no fusion, so a store that initializes by accident still finishes.
  new SetupRecorder()
})

afterEach(() => {
  configureLogging(original)
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------------------------------------
// The protocol surface
// ---------------------------------------------------------------------------------------------------------

describe("TS-112 — the SDK's MemoryStore surface, asserted by assignment", () => {
  it('TS-112 — the store assigns to MemoryStore, so tsc reports a missing member', () => {
    const typed: MemoryStore = store()
    expect(typed.name).toBe('facts')
  })

  const DISPATCHED = ['search', 'add', 'initialize', 'getTools'] as const

  it.each(DISPATCHED)('TS-112 — %s is a method the manager can dispatch through', (method) => {
    expect(typeof (store() as unknown as Record<string, unknown>)[method]).toBe('function')
  })
})

describe('TS-113 — getTools is present and empty, and presence changes nothing', () => {
  it('TS-113 — getTools returns an empty array', () => {
    const tools = store().getTools()
    expect(tools).toEqual([])
    expect(Array.isArray(tools)).toBe(true)
  })

  it('TS-113 — a manager holding the store registers only its own two tools', () => {
    const manager = new MemoryManager({ stores: [store({ writable: true })], addToolConfig: true })
    expect(manager.getTools().map((tool) => tool.name)).toEqual(['search_memory', 'add_memory'])
  })
})

describe('AT-044a, AT-044b — the SDK routes extraction through add, the pair rather than the half', () => {
  it('AT-044a — addMessages is absent, on the instance and on the prototype', () => {
    const target = store()
    expect('addMessages' in target).toBe(false)
    expect((target as unknown as Record<string, unknown>).addMessages).toBeUndefined()
  })

  it('AT-044b — add is present, the half that makes the absence mean something', () => {
    expect(typeof store().add).toBe('function')
  })

  it("AT-044b — a writable store satisfies the manager's write-sink check, and extraction is accepted", () => {
    const manager = new MemoryManager({ stores: [store({ writable: true, extraction: true })] })
    expect(manager.getTools()[0]?.name).toBe('search_memory')
  })
})

/** Every `src/` module, by file name. */
function sources(): [string, string][] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => [name, readFileSync(join(SRC, name), 'utf8')])
}

describe('TS-114 — no method stands in for absence', () => {
  it('TS-114 — no module throws a not-implemented stub, which would be present to the SDK', () => {
    const offenders = sources()
      .filter(([, text]) => /throw new \w*Error\(\s*['"`][^'"`]*not implemented/i.test(text))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Limits, reserved keys, regex tier, writable, bounds, input checks
// ---------------------------------------------------------------------------------------------------------

describe('AT-041 — a four-link limit chain and a floor, both asserted where they are decided', () => {
  it('AT-041 — a query limit wins over everything below it', () => {
    expect(memoryInternals.resolveLimit({ query: 3, options: 7, instance: 11 })).toBe(3)
  })

  it('AT-041 — options win over the instance default', () => {
    expect(memoryInternals.resolveLimit({ options: 7, instance: 11 })).toBe(7)
  })

  it('AT-041 — the instance value wins over the package default', () => {
    expect(memoryInternals.resolveLimit({ instance: 11 })).toBe(11)
  })

  it('AT-041 — nothing supplied resolves to the package default of ten', () => {
    expect(memoryInternals.resolveLimit({})).toBe(DEFAULT_MAX_SEARCH_RESULTS)
    expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(10)
  })

  it('AT-041 — a limit below one is a RangeError at construction', () => {
    expect(() => store({ maxSearchResults: 0 })).toThrow(RangeError)
    expect(() => store({ maxSearchResults: 0 })).toThrow(/maxSearchResults/)
  })

  it('AT-041 — a limit below one in options is rejected before any round trip', async () => {
    const recorder = new SetupRecorder()
    const error = await rejection(store().search('anything', { maxSearchResults: 0 }))
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toMatch(/maxSearchResults/)
    expect(recorder.probes).toEqual([])
  })

  it("AT-041 — a limit below one on a query's own limit key is rejected, naming that key", async () => {
    const recorder = new SetupRecorder()
    const error = await rejection(store().search({ text: 'anything', limit: 0 }))
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toMatch(/'limit'/)
    expect(recorder.probes).toEqual([])
  })

  it('AT-041 — a store with a ceiling sends it, and an options value overrides it', async () => {
    const target = store({ maxSearchResults: 4 })
    const collection = prepared(target)
    await target.search('dark mode')
    await target.search('dark mode', { maxSearchResults: 2 })
    expect(collection.pipelines.map((stages) => stageOf(stages, '$limit'))).toEqual([4, 2])
  })
})

describe('TS-115 — reserved metadata keys win, and the drop is logged', () => {
  const merge = memoryInternals.mergeMetadata

  it('TS-115 — a colliding caller key keeps the reserved value', () => {
    const merged = merge(
      { _scope: 'somebody-elses-scope', topic: 'cats' },
      { _scope: 'tenant-a', _id: 'abc', _search_type: 'vector', _relevance_score: 0.5 },
      { storeName: 'facts' },
    )
    expect(merged._scope).toBe('tenant-a')
    expect(merged.topic).toBe('cats')
    expect(Object.values(merged)).not.toContain('somebody-elses-scope')
  })

  it('TS-115 — non-colliding caller keys survive untouched', () => {
    const merged = merge({ topic: 'cats', source: 'chat' }, { _id: 'abc' }, { storeName: 'facts' })
    expect(merged).toEqual({ topic: 'cats', source: 'chat', _id: 'abc' })
  })

  it('TS-115 — the collision is logged once, naming the key and the store', () => {
    merge({ _id: 'spoofed' }, { _id: 'real' }, { storeName: 'facts' })
    const logged = recordsOf('reserved_key_collision')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]?.message).toContain("'_id'")
    expect(logged[0]?.message).toContain("'facts'")
  })

  it('TS-115 — the collision record carries the namespace', () => {
    merge({ _id: 'spoofed' }, { _id: 'real' }, { storeName: 'facts', namespace: 'appdb.memory' })
    expect(recordsOf('reserved_key_collision')[0]?.fields.strands_mongodb_namespace).toBe('appdb.memory')
  })

  it('TS-115 — every reserved key is defended', () => {
    for (const key of RESERVED_METADATA_KEYS) {
      expect(merge({ [key]: 'caller' }, { [key]: 'reserved' }, { storeName: 'facts' })[key]).toBe('reserved')
    }
  })
})

describe('TS-116 — no regex tier is reachable', () => {
  /** Every string literal in a module, with comments stripped first. */
  const literals = (text: string): string[] => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0])
  }

  it('TS-116 — no module emits a regex match operator, and the one regex expression stays in storage.ts', () => {
    const found = new Map<string, Set<string>>()
    for (const [name, text] of sources()) {
      for (const literal of literals(text)) {
        for (const token of literal.match(/\$regex[A-Za-z]*/g) ?? []) {
          found.set(token, (found.get(token) ?? new Set()).add(name))
        }
      }
    }
    // The storage module writes `$regexFindAll` as an object key, which this scan does not read as a literal.
    expect([...found.keys()].filter((token) => token !== '$regexFindAll')).toEqual([])
    const holders = sources()
      .filter(([, text]) => text.includes('$regexFindAll'))
      .map(([name]) => name)
    expect(holders).toEqual(['storage.ts'])
  })

  it('TS-116 — no module emits a $text operator', () => {
    const holders = sources()
      .filter(([, text]) => literals(text).some((literal) => /\$text\b/.test(literal)) || /\$text\s*:/.test(text))
      .map(([name]) => name)
    expect(holders).toEqual([])
  })
})

describe('TS-117 — writable defaults to false, and add on a read-only store names the key', () => {
  it('TS-117 — the default is read-only', () => {
    expect(store().writable).toBe(false)
  })

  it('TS-117 — configuring it makes the store writable', () => {
    expect(store({ writable: true }).writable).toBe(true)
  })

  it('TS-117 — add on a read-only store throws naming writable, before any round trip', async () => {
    const recorder = new SetupRecorder()
    const error = await rejection(store().add('a fact nobody asked to store'))
    expect(error.message).toMatch(/'writable'/)
    expect(error.message).toMatch(/'facts'/)
    expect(recorder.probes).toEqual([])
  })
})

describe('TS-118 — the mutually exclusive score bounds, rejected at construction', () => {
  it('TS-118 — both bounds together are rejected naming both keys', () => {
    expect(() => store({ minScore: 0.1, maxScore: 0.9 })).toThrow(/'minScore'.*'maxScore'/)
  })

  it('TS-118 — either bound alone constructs', () => {
    expect(store({ minScore: 0.5 }).minScore).toBe(0.5)
    expect(store({ maxScore: 0.5 }).maxScore).toBe(0.5)
  })
})

/** Queries that set both vector keys or neither. */
const BAD_QUERY_KEYS = [
  { query: { text: 'dark mode', vector: [1, 0, 0, 0] }, expected: /both/ },
  { query: { limit: 5 }, expected: /neither/ },
]

/** Filters that name an undeclared path or carry an operator key. */
const BAD_FILTERS = [
  { filter: { 'metadata.tier': 'gold' }, expected: /filterFields/ },
  { filter: { $where: 'sleep(1000)' }, expected: /\$where/ },
]

describe('TS-119 — every caller input is checked before the network', () => {
  it.each(BAD_QUERY_KEYS)('TS-119 — a query setting both or neither vector key is rejected: $expected', async (row) => {
    const recorder = new SetupRecorder()
    const error = await rejection(store().search(row.query))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toMatch(row.expected)
    expect(recorder.probes).toEqual([])
  })

  it.each(BAD_FILTERS)('TS-119 — a per-query filter is validated before the query runs: $expected', async (row) => {
    const recorder = new SetupRecorder()
    const error = await rejection(store().search({ text: 'dark mode', filter: row.filter }))
    expect(error.message).toMatch(row.expected)
    expect(recorder.probes).toEqual([])
  })

  it.each(BAD_FILTERS)('TS-119 — a configured filter is validated at construction: $expected', (row) => {
    expect(() => store({ filter: row.filter })).toThrow(row.expected)
  })
})

// ---------------------------------------------------------------------------------------------------------
// What the store sends and maps back
// ---------------------------------------------------------------------------------------------------------

describe('TS-120 — predicate out, entry back, and no document can claim another scope', () => {
  it('TS-120 — the predicate carries the scope, the store and both caller filters, in order', async () => {
    const target = store({
      config: connection({ filterFields: ['metadata.tier', 'metadata.region'] }),
      scope: 'tenant-a',
      filter: { 'metadata.tier': 'gold' },
    })
    const collection = prepared(target)
    await target.search({ text: 'dark mode', filter: { 'metadata.region': 'emea' } })
    expect(stageOf(collection.stages, '$match')).toEqual({
      $and: [
        { scope: { $eq: 'tenant-a' } },
        { store_name: { $eq: 'facts' } },
        { 'metadata.tier': 'gold' },
        { 'metadata.region': 'emea' },
      ],
    })
  })

  it('TS-120 — a stored _scope key cannot make a document report another scope', async () => {
    const target = store({ scope: 'tenant-a' })
    prepared(target, {
      documents: [
        {
          _id: 'abc',
          content: 'the user prefers dark mode',
          score: 0.9,
          metadata: { _scope: 'tenant-b', tier: 'gold' },
        },
      ],
    })
    const [entry] = await target.search('dark mode')
    expect(metadataOf(entry!)._scope).toBe('tenant-a')
    expect(metadataOf(entry!).tier).toBe('gold')
    expect(recordsOf('reserved_key_collision').some((record) => record.message.includes("'_scope'"))).toBe(true)
  })

  const UNSCORED = [
    { name: 'no score field', document: { _id: 'abc', content: 'the user prefers dark mode' } },
    { name: 'score projected null', document: { _id: 'abc', content: 'the user prefers dark mode', score: null } },
  ]

  it.each(UNSCORED)('TS-120 — an unscored document maps to zero rather than failing: $name', async (row) => {
    const target = store()
    prepared(target, { documents: [row.document] })
    const [entry] = await target.search('dark mode')
    expect(metadataOf(entry!)._relevance_score).toBe(0)
  })

  it("TS-120 — only the document's own metadata reaches the entry", async () => {
    const target = store({ scope: 'tenant-a' })
    prepared(target, {
      documents: [
        {
          _id: new ObjectId('6a96a03ca471f4a001870220'),
          content: 'the user prefers dark mode',
          scope: 'tenant-a',
          store_name: 'facts',
          content_hash: 'f'.repeat(64),
          created_at: new Date(),
          score: 1.5,
          metadata: { tier: 'gold' },
        },
      ],
    })
    const [entry] = await target.search('dark mode')
    expect(entry?.content).toBe('the user prefers dark mode')
    expect(entry?.storeName).toBe('facts')
    expect(metadataOf(entry!)).toEqual({
      tier: 'gold',
      _id: '6a96a03ca471f4a001870220',
      _relevance_score: 1.5,
      _search_type: 'text',
      _scope: 'tenant-a',
    })
  })

  it('TS-120 — an entry survives JSON, so the SDK can hand it to a model as a tool result', async () => {
    const target = store()
    prepared(target, { documents: [{ _id: new ObjectId(), content: 'x', score: new Double(0.5) }] })
    const [entry] = await target.search('dark mode')
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
    expect(metadataOf(entry!)._relevance_score).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------------------------------------

describe('TS-121 — deleting one memory: one filter out, and the ids that never reach the wire', () => {
  it("TS-121 — the filter is the read path's predicate with _id added beside $and", async () => {
    const target = store({
      config: connection({ filterFields: ['metadata.tier'] }),
      scope: 'tenant-a',
      filter: { 'metadata.tier': 'gold' },
      writable: true,
    })
    const collection = prepared(target)
    collection.deleted = 1
    const id = new ObjectId()
    expect(await target.delete(id.toHexString())).toBe(1)
    expect(collection.deletes).toEqual([
      {
        $and: [{ scope: { $eq: 'tenant-a' } }, { store_name: { $eq: 'facts' } }, { 'metadata.tier': 'gold' }],
        _id: id,
      },
    ])
  })

  it('TS-121 — the count comes from the server rather than from this method', async () => {
    const target = store({ writable: true })
    prepared(target).deleted = 7
    expect(await target.delete(new ObjectId().toHexString())).toBe(7)
  })

  const BAD_IDS = [
    { name: 'empty', id: '' },
    { name: 'short', id: 'nope' },
    { name: 'non-hex', id: 'z'.repeat(24) },
    { name: '23 characters', id: '6a96a03ca471f4a00187022' },
    { name: 'a number', id: 12 },
    { name: 'null', id: null },
    { name: '12 characters, which ObjectId would take as bytes', id: 'abcdefghijkl' },
  ]

  it.each(BAD_IDS)('TS-121 — an id that is not an ObjectId is rejected before the wire: $name', async (row) => {
    const target = store({ writable: true })
    const collection = prepared(target)
    const error = await rejection(target.delete(row.id as string))
    expect(error.message).toMatch(/'memoryId'/)
    expect(collection.deletes).toEqual([])
  })
})

describe("TS-122 — deleting every memory this store can see: the read path's predicate, nothing added", () => {
  it('TS-122 — the filter is exactly the predicate, configured filter included', async () => {
    const target = store({
      config: connection({ filterFields: ['metadata.tier'] }),
      scope: 'tenant-a',
      filter: { 'metadata.tier': 'gold' },
      writable: true,
    })
    const collection = prepared(target)
    await target.deleteAll()
    expect(collection.deletes).toEqual([
      { $and: [{ scope: { $eq: 'tenant-a' } }, { store_name: { $eq: 'facts' } }, { 'metadata.tier': 'gold' }] },
    ])
  })

  it('TS-122 — the count comes from the server', async () => {
    const target = store({ writable: true })
    prepared(target).deleted = 12
    expect(await target.deleteAll()).toBe(12)
  })
})

describe('TS-123 — deletion is a write: writable gates both deletes, before setup runs', () => {
  const CALLS = ['delete', 'deleteAll'] as const

  it.each(CALLS)('TS-123 — a read-only store refuses %s before it initializes', async (call) => {
    const recorder = new SetupRecorder()
    const target = store()
    const error = await rejection(call === 'delete' ? target.delete(new ObjectId().toHexString()) : target.deleteAll())
    expect(error.message).toMatch(/'writable'/)
    expect(memoryInternals.state(target).initialized).toBe(false)
    expect(recorder.probes).toEqual([])
  })
})

describe('TS-124 — the score bound on scores this test chose', () => {
  const documents = (): Document[] =>
    [0.9, 0.5, 0.1].map((score, index) => ({ _id: String(index), content: `fact ${index}`, score }))

  const BOUNDS = [
    { name: 'floor', bound: { minScore: 0.5 }, kept: ['fact 0', 'fact 1'] },
    { name: 'ceiling', bound: { maxScore: 0.5 }, kept: ['fact 1', 'fact 2'] },
    { name: 'floor at the lowest score', bound: { minScore: 0.1 }, kept: ['fact 0', 'fact 1', 'fact 2'] },
  ]

  it.each(BOUNDS)("TS-124 — a bound equal to a result's score keeps that result: $name", async (row) => {
    const target = store(row.bound)
    prepared(target, { documents: documents() })
    const entries = await target.search('dark mode')
    expect(entries.map((entry) => entry.content)).toEqual(row.kept)
  })

  it('TS-124 — a bound that drops something logs a debug record with the counts', async () => {
    const target = store({ minScore: 0.5 })
    prepared(target, { documents: documents() })
    await target.search('dark mode')
    const [record] = recordsOf('score_bound_applied')
    expect(record?.level).toBe('debug')
    expect(record?.message).toBe(
      'MongoDBMemoryStore: minScore 0.5 on appdb.memory kept 2 of 3 results (applied after the query).',
    )
  })
})

// ---------------------------------------------------------------------------------------------------------
// What initialize() decides, with the four lifecycle calls recorded
// ---------------------------------------------------------------------------------------------------------

/** The manual-vector half of a connection config: a client-supplied four-dimension vector. */
const MANUAL_VECTOR = { embeddingDimensions: 4, similarity: 'cosine' } as const

/** A vector for {@link MANUAL_VECTOR} stores. */
const QUERY_VECTOR = [1.0, 0.0, 0.0, 0.0]

/** The connection the fake client is registered under. */
function connectionOf(): Connection {
  const found = REGISTRY.get(client.asClient)
  expect(found).toBeDefined()
  return found as Connection
}

/** The `[level, event, tier]` of every skipped-tier record, in order. */
function skipped(): [string, unknown, unknown][] {
  return records
    .filter((record) => ['tier_building', 'tier_unavailable'].includes(String(record.fields.strands_mongodb_event)))
    .map((record) => [record.level, record.fields.strands_mongodb_event, record.fields.strands_mongodb_tier])
}

/** Make an `ensure` call with a non-zero timeout see every build finish first, as a real wait would. */
function finishOnWait(recorder: SetupRecorder, gate?: Promise<void>): void {
  const record = vi.mocked(lifecycle.ensure).getMockImplementation()
  vi.mocked(lifecycle.ensure).mockImplementation(async (db, collection, options = {}) => {
    if (options.timeoutMs) {
      if (gate !== undefined) await gate
      recorder.building.clear()
    }
    await record?.(db, collection, options)
  })
}

/** A promise and the function that settles it, as Python's `asyncio.Event`. */
function event(): { wait: Promise<void>; set: () => void } {
  let set = (): void => undefined
  const wait = new Promise<void>((done) => {
    set = done
  })
  return { wait, set }
}

/** The tier each entry reports. */
const tiersOf = (entries: { metadata?: Record<string, unknown> }[]): unknown[] =>
  entries.map((entry) => metadataOf(entry)._search_type)

describe('TS-125 — the index-ready budget comes from the config, at both call sites', () => {
  const NAMED = ['text', 'vector'] as const

  it.each(NAMED)('TS-125 — a named %s tier carries the configured budget on every call', async (searchType) => {
    const recorder = new SetupRecorder()
    await store({ config: connection({ indexReadyTimeoutMs: 7, searchType }) }).initialize()
    expect(recorder.timeouts).toEqual([7, 7])
  })

  it('TS-125 — absence resolves to the module default', async () => {
    const recorder = new SetupRecorder()
    await store({ config: connection({ searchType: 'text' }) }).initialize()
    expect(new Set(recorder.timeouts)).toEqual(new Set([READY_TIMEOUT_MS]))
  })
})

describe('TS-126 — under auto, initialize returns while indexes build and the first search waits', () => {
  it('TS-126 — auto waits only on the ordinary indexes', async () => {
    const recorder = new SetupRecorder()
    await store({ config: connection({ indexReadyTimeoutMs: 7 }) }).initialize()
    expect(recorder.timeouts[0]).toBe(7)
    expect(recorder.timeouts.slice(1)).toEqual(recorder.search.map(() => 0))
  })

  it('TS-126 — every tier still building initializes with no tiers', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual([])
    expect(memoryInternals.state(target).initialized).toBe(true)
  })

  it('TS-126 — search waits for the build with the configured budget', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store({ config: connection({ indexReadyTimeoutMs: 7 }) })
    await target.initialize()
    finishOnWait(recorder)

    const found = await target.search({ text: 'dark' })

    expect(recorder.timeouts.slice(-4, -2)).toEqual([7, 7])
    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(tiersOf(found)).toEqual(['vector'])
  })

  it('TS-126 — a retry picks up the finished build', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()

    recorder.building.clear()
    memoryInternals.setRetryAt(target, 0)
    await target.initialize()

    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(memoryInternals.state(target).tierRetryAt).toBeNull()
  })

  it('TS-126 — a refusal alongside a build waits for the build', async () => {
    const recorder = new SetupRecorder({ failing: ['vector_index'] })
    recorder.building.add('text_index')
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual([])
    finishOnWait(recorder)

    await memoryInternals.waitForATier(target)

    expect(memoryInternals.state(target).tiers).toEqual(['text'])
  })

  it('TS-126 — only refusals still throw', async () => {
    new SetupRecorder({ failing: ['vector_index', 'text_index'] })
    const error = await rejection(store().initialize())
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toMatch(/no search tier could be prepared/)
  })

  it('TS-126 — a build that never finishes fails the search', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()

    const error = await rejection(target.search({ text: 'dark' }))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toMatch(/no search tier on .* was ready/)
  })

  it('TS-126 — a ready tier is not held behind one still building', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()
    const record = vi.mocked(lifecycle.ensure).getMockImplementation()
    vi.mocked(lifecycle.ensure).mockImplementation(async (db, collection, options = {}) => {
      const name = options.search?.[0]?.name
      if (options.timeoutMs && name === 'vector_index') await new Promise(() => undefined)
      if (options.timeoutMs && name !== undefined) recorder.building.delete(name)
      await record?.(db, collection, options)
    })

    const found = await target.search({ text: 'dark' })

    expect(memoryInternals.state(target).tiers).toEqual(['text'])
    expect(tiersOf(found)).toEqual(['text'])
  })

  it('TS-126 — a fresh store logs its building tiers at info', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    await store().initialize()
    expect(skipped()).toEqual([
      ['info', 'tier_building', 'vector'],
      ['info', 'tier_building', 'text'],
    ])
  })

  it('TS-126 — a refused tier still warns', async () => {
    const recorder = new SetupRecorder({ failing: ['vector_index'] })
    recorder.building.add('text_index')
    await store().initialize()
    expect(skipped()).toEqual([
      ['warn', 'tier_unavailable', 'vector'],
      ['info', 'tier_building', 'text'],
    ])
  })

  it('TS-126 — a wait that runs out warns', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()
    records.length = 0

    expect((await rejection(target.search({ text: 'dark' }))).message).toMatch(/was ready/)

    expect(skipped()).toEqual([
      ['warn', 'tier_unavailable', 'vector'],
      ['warn', 'tier_unavailable', 'text'],
    ])
  })

  it('TS-126 — a tier still building after another came up stays at info', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()
    const record = vi.mocked(lifecycle.ensure).getMockImplementation()
    vi.mocked(lifecycle.ensure).mockImplementation(async (db, collection, options = {}) => {
      if (options.timeoutMs) recorder.building.delete('text_index')
      await record?.(db, collection, options)
    })
    records.length = 0

    await target.search({ text: 'dark' })

    expect(memoryInternals.state(target).tiers).toEqual(['text'])
    expect(skipped()).toEqual([['info', 'tier_building', 'vector']])
  })

  it('TS-126 — searches during the wait share it', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store({ config: connection({ indexReadyTimeoutMs: 7 }) })
    await target.initialize()
    const gate = event()
    finishOnWait(recorder, gate.wait)
    const calls = recorder.timeouts.length

    const first = target.search({ text: 'dark' })
    const second = target.search({ text: 'dark' })
    await tick()
    gate.set()
    const found = await Promise.all([first, second])

    expect(found.map((results) => results.length)).toEqual([1, 1])
    expect(recorder.timeouts.slice(calls).filter((timeout) => timeout === 7)).toHaveLength(2)
  })

  it('TS-126 — only the first search waits', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store({ config: connection({ indexReadyTimeoutMs: 7 }) })
    await target.initialize()
    expect(await rejection(target.search({ text: 'dark' }))).toBeInstanceOf(StorageError)
    const calls = recorder.timeouts.length

    expect((await rejection(target.search({ text: 'dark' }))).message).toMatch(/was ready/)

    expect(recorder.timeouts.slice(calls)).not.toContain(7)
  })
})

describe('TS-127 — what initialize decides: which indexes, in what order, fatal when', () => {
  it('TS-127 — auto creates both tiers vector first and prefers the vector one', async () => {
    const recorder = new SetupRecorder()
    const target = store()
    await target.initialize()
    expect(recorder.search).toEqual(['vector_index', 'text_index'])
    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(memoryInternals.pickTier(target, 'dark mode', undefined)).toBe('vector')
  })

  it('TS-127 — a named searchType creates only its own index', async () => {
    const recorder = new SetupRecorder()
    const target = store({ config: connection({ searchType: 'text' }) })
    await target.initialize()
    expect(recorder.search).toEqual(['text_index'])
    expect(memoryInternals.state(target).tiers).toEqual(['text'])
  })

  it("TS-127 — a named searchType's own tier failing is fatal and says what refused", async () => {
    new SetupRecorder({ failing: ['vector_index'] })
    const error = await rejection(store({ config: connection({ searchType: 'vector' }) }).initialize())
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('vector_index')
    expect(error.message).toContain(PRETEND_REASON)
    expect(error.message).not.toContain("'searchType' is 'auto'")
  })

  it('TS-127 — auto with every tier refused warns per tier, then throws', async () => {
    new SetupRecorder({ failing: ['vector_index', 'text_index'] })
    const target = store()
    const error = await rejection(target.initialize())
    expect(error.message).toContain('no search tier could be prepared')
    expect(records.filter((record) => record.message.includes('search tier is not available'))).toHaveLength(2)
    expect(memoryInternals.state(target).initialized).toBe(false)
  })

  it("TS-127 — the throw carries the last tier's reason rather than pointing at the log", async () => {
    new SetupRecorder({ failing: ['vector_index', 'text_index'] })
    const error = await rejection(store().initialize())
    expect(error.cause).toBeInstanceOf(StorageError)
    expect(String((error.cause as Error).message)).toContain(PRETEND_REASON)
  })

  it('TS-127 — auto landing on text warns that answers became lexical', async () => {
    new SetupRecorder({ failing: ['vector_index'] })
    const target = store()
    await target.initialize()
    const messages = records.map((record) => record.message)
    expect(memoryInternals.state(target).tiers).toEqual(['text'])
    expect(messages.some((message) => message.includes('vector search tier is not available'))).toBe(true)
    expect(messages.some((message) => message.includes('resolve to the text tier'))).toBe(true)
  })

  it('TS-127 — a deployment that cannot search warns once for ten stores', async () => {
    const recorder = new SetupRecorder({ available: false })
    const stores = Array.from({ length: 10 }, (_, index) => store({ name: `facts${index}` }))
    await Promise.all(stores.map((each) => each.initialize()))
    expect(recorder.probes).toEqual(['memory'])
    expect(records.filter((record) => record.message.includes('does not run Atlas Search'))).toHaveLength(1)
    expect(recorder.search).toEqual([])
    expect(stores.every((each) => memoryInternals.state(each).tiers.length === 0)).toBe(true)
  })

  it('TS-127 — the second initialize neither takes the lock nor redoes the setup', async () => {
    const recorder = new SetupRecorder()
    const target = store()
    const shared = connectionOf()
    let held = shared.setup
    let locks = 0
    Object.defineProperty(shared, 'setup', {
      get: () => {
        locks += 1
        return held
      },
      set: (value: Promise<void>) => {
        held = value
      },
    })

    await target.initialize()
    await target.initialize()

    expect(locks).toBe(1)
    expect(recorder.probes).toEqual(['memory'])
    expect(recorder.ordinary).toHaveLength(1)
    expect(recorder.search).toEqual(['vector_index', 'text_index'])
  })

  it('TS-127 — one store initializing twice at once does the work once', async () => {
    const recorder = new SetupRecorder()
    const target = store()
    await Promise.all([target.initialize(), target.initialize()])
    expect(recorder.probes).toEqual(['memory'])
    expect(recorder.ordinary).toHaveLength(1)
    expect(recorder.search).toEqual(['vector_index', 'text_index'])
  })

  it('TS-127 — a query with no ready tier names the build, not a missing search process', () => {
    const target = store()
    prepared(target, { tiers: [] })
    let error: unknown
    try {
      memoryInternals.pickTier(target, 'dark mode', undefined)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StorageError)
    expect((error as Error).message).toContain("was ready within 'indexReadyTimeoutMs'")
    expect((error as Error).message).not.toContain('does not run Atlas Search')
  })

  it('TS-127 — a query that no prepared tier fits names the key to add', async () => {
    const target = store({ config: connection({ searchType: 'vector', ...MANUAL_VECTOR }) })
    prepared(target, { tiers: ['vector'] })
    const error = await rejection(target.search('dark mode'))
    expect(error).not.toBeInstanceOf(StorageError)
    expect(error.message).toContain("'vector'")
    expect(error.message).toContain('embeddingDimensions')
  })
})

describe('TS-128 — the memory store refuses a collation that folds case, once per collection', () => {
  it('TS-128 — initialize refuses and says collation', async () => {
    new SetupRecorder({ refuseCollation: true })
    const error = await rejection(store().initialize())
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('collation')
  })

  it('TS-128 — the refusal precedes the probe and every index', async () => {
    const recorder = new SetupRecorder({ refuseCollation: true })
    await rejection(store().initialize())
    expect(recorder.collations).toEqual(['memory'])
    expect(recorder.probes).toEqual([])
    expect(recorder.ordinary).toEqual([])
    expect(recorder.search).toEqual([])
  })

  it('TS-128 — a collection that compares bytes is checked once and then set up', async () => {
    const recorder = new SetupRecorder()
    await store().initialize()
    expect(recorder.collations).toEqual(['memory'])
    expect(recorder.ordinary).not.toEqual([])
  })

  it('TS-128 — a refusal is not cached, so the collection can be fixed', async () => {
    const recorder = new SetupRecorder({ refuseCollation: true })
    const target = store()
    await rejection(target.initialize())
    expect(memoryInternals.state(target).initialized).toBe(false)

    recorder.refuseCollation = false
    await target.initialize()

    expect(memoryInternals.state(target).initialized).toBe(true)
    expect(recorder.collations).toEqual(['memory', 'memory'])
  })

  it('TS-128 — ten stores on one connection check once between them', async () => {
    const recorder = new SetupRecorder()
    for (let index = 0; index < 10; index += 1) await store({ name: `facts${index}` }).initialize()
    expect(recorder.collations).toEqual(['memory'])
    expect(recorder.probes).toHaveLength(1)
  })
})

describe('TS-129 — an absent collection is not a verified one', () => {
  it('TS-129 — an absent collection is read again once the indexes have created it', async () => {
    const recorder = new SetupRecorder({ absentUntilProvisioned: true })
    const target = store()
    await target.initialize()
    expect(recorder.collations).toEqual(['memory', 'memory'])
    expect(memoryInternals.state(target).initialized).toBe(true)
  })

  it('TS-129 — the read that found something is the one that caches', async () => {
    const recorder = new SetupRecorder({ absentUntilProvisioned: true })
    await store().initialize()
    await store({ name: 'others' }).initialize()
    expect(recorder.collations).toEqual(['memory', 'memory'])
  })

  it('TS-129 — a collation that appears during provisioning fails initialize', async () => {
    const recorder = new SetupRecorder({ absentUntilProvisioned: true })
    const provision = vi.mocked(lifecycle.ensure).getMockImplementation()
    vi.mocked(lifecycle.ensure).mockImplementation(async (db, collection, options) => {
      recorder.refuseCollation = true
      await provision?.(db, collection, options)
    })
    const target = store()

    const error = await rejection(target.initialize())

    expect(error.message).toContain('collation')
    expect(memoryInternals.state(target).initialized).toBe(false)
    expect(recorder.collations).toEqual(['memory', 'memory'])
  })
})

describe('TS-130 — the hybrid tier is a statement about two others', () => {
  it('TS-130 — auto prefers fusion where the deployment and both tiers allow it', async () => {
    const recorder = new SetupRecorder({ rankFusion: true })
    const target = store()
    await target.initialize()
    expect(recorder.search).toEqual(['vector_index', 'text_index'])
    expect(memoryInternals.state(target).tiers).toEqual(['hybrid', 'vector', 'text'])
    expect(memoryInternals.pickTier(target, 'dark mode', undefined)).toBe('hybrid')
  })

  it('TS-130 — a deployment without the stage resolves vector first', async () => {
    const recorder = new SetupRecorder({ rankFusion: false })
    const target = store()
    await target.initialize()
    expect(recorder.fusionProbes).toEqual(['memory'])
    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
  })

  it('TS-130 — the version is not asked for where the deployment cannot search', async () => {
    const recorder = new SetupRecorder({ available: false, rankFusion: true })
    const target = store()
    await target.initialize()
    expect(recorder.probes).toEqual(['memory'])
    expect(recorder.fusionProbes).toEqual([])
    expect(memoryInternals.state(target).tiers).toEqual([])
  })

  it('TS-130 — ten stores on one connection ask the version once', async () => {
    const recorder = new SetupRecorder({ rankFusion: true })
    const stores = Array.from({ length: 10 }, (_, index) => store({ name: `facts${index}` }))
    await Promise.all(stores.map((each) => each.initialize()))
    expect(recorder.fusionProbes).toEqual(['memory'])
    for (const each of stores) expect(memoryInternals.state(each).tiers).toEqual(['hybrid', 'vector', 'text'])
  })

  it('TS-130 — an explicit hybrid store creates both indexes', async () => {
    const recorder = new SetupRecorder({ rankFusion: true })
    const target = store({ config: connection({ searchType: 'hybrid' }) })
    await target.initialize()
    expect(recorder.search).toEqual(['vector_index', 'text_index'])
    expect(memoryInternals.state(target).tiers).toEqual(['hybrid'])
  })

  it('TS-130 — an explicit hybrid store with one tier refused throws', async () => {
    new SetupRecorder({ failing: ['vector_index'], rankFusion: true })
    const error = await rejection(store({ config: connection({ searchType: 'hybrid' }) }).initialize())
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('vector_index')
    expect(error.message).toContain(PRETEND_REASON)
  })

  it('TS-130 — an explicit hybrid store on a deployment without the stage throws', async () => {
    new SetupRecorder({ rankFusion: false })
    const error = await rejection(store({ config: connection({ searchType: 'hybrid' }) }).initialize())
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('rankFusion')
  })

  it('TS-130 — auto skips fusion where only one tier came up', async () => {
    new SetupRecorder({ failing: ['text_index'], rankFusion: true })
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['vector'])
    expect(memoryInternals.pickTier(target, 'dark mode', undefined)).toBe('vector')
  })

  it('TS-130 — a query only one tier fits falls past hybrid', async () => {
    new SetupRecorder({ rankFusion: true })
    const target = store({ config: connection({ searchType: 'auto', ...MANUAL_VECTOR }) })
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['hybrid', 'vector', 'text'])
    expect(memoryInternals.pickTier(target, 'dark mode', undefined)).toBe('text')
    expect(memoryInternals.pickTier(target, undefined, QUERY_VECTOR)).toBe('vector')
    expect(memoryInternals.pickTier(target, 'dark mode', QUERY_VECTOR)).toBe('hybrid')
  })
})

describe('TS-131 — the query shape only fusion can read', () => {
  it('TS-131 — the AutoEmbeddings path still rejects both keys before the network', async () => {
    const error = await rejection(store().search({ text: 'dark mode', vector: QUERY_VECTOR }))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toMatch(/no interpretation/)
  })

  const SINGLE = ['vector', 'text'] as const

  it.each(SINGLE)('TS-131 — a named %s store still rejects both keys before the network', async (searchType) => {
    const target = store({ config: connection({ searchType, ...MANUAL_VECTOR }) })
    const error = await rejection(target.search({ text: 'dark mode', vector: QUERY_VECTOR }))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toMatch(/no interpretation/)
  })

  it('TS-131 — a manual store that could fuse gets past the construction-time check', async () => {
    new SetupRecorder({ rankFusion: true })
    const target = store({ config: connection(MANUAL_VECTOR) })
    await target.initialize()
    const collection = prepared(target, { tiers: memoryInternals.state(target).tiers })

    const entries = await target.search({ text: 'dark mode', vector: QUERY_VECTOR })

    expect(collection.stages.map((stage) => Object.keys(stage)[0])).toEqual(['$rankFusion', '$set', '$limit'])
    expect(tiersOf(entries)).toEqual(['hybrid'])
  })

  it('TS-131 — a manual store that cannot fuse throws rather than answering from one key', async () => {
    new SetupRecorder({ rankFusion: false })
    const target = store({ config: connection(MANUAL_VECTOR) })
    await target.initialize()

    const error = await rejection(target.search({ text: 'dark mode', vector: QUERY_VECTOR }))

    expect(error).not.toBeInstanceOf(StorageError)
    expect(error.message).toContain('hybrid')
    expect(error.message).toContain('vector, text')
  })
})

describe('TS-132 — a score bound declines the better tier, and reaches the fused score when asked for', () => {
  const BOUNDS = [
    { name: 'floor', bound: { minScore: 0.7 }, named: 'minScore' },
    { name: 'ceiling', bound: { maxScore: 0.9 }, named: 'maxScore' },
  ]

  it.each(BOUNDS)('TS-132 — a bound leaves auto resolving as it did before: $name', async (row) => {
    new SetupRecorder({ rankFusion: true })
    const target = store(row.bound)
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(memoryInternals.pickTier(target, 'dark mode', undefined)).toBe('vector')
    const warnings = records.filter((record) => record.message.includes(row.named))
    expect(warnings).toHaveLength(1)
    expect((warnings[0] as LogRecord).message).toContain('hybrid')
    expect((warnings[0] as LogRecord).fields.strands_mongodb_event).toBe('bound_declined_fusion')
  })

  it('TS-132 — no bound, no warning', async () => {
    new SetupRecorder({ rankFusion: true })
    await store().initialize()
    expect(records.filter((record) => record.message.includes('minScore'))).toEqual([])
  })

  it('TS-132 — a bound is silent where fusion was never on offer', async () => {
    new SetupRecorder({ rankFusion: false })
    const target = store({ minScore: 0.7 })
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(records.filter((record) => record.message.includes('minScore'))).toEqual([])
  })

  it('TS-132 — an explicit hybrid store keeps its bound and its tier', async () => {
    new SetupRecorder({ rankFusion: true })
    const target = store({ minScore: 0.7, config: connection({ searchType: 'hybrid' }) })
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['hybrid'])
    expect(records.filter((record) => record.message.includes('minScore'))).toEqual([])
  })

  it('TS-132 — the bound reaches the fused score rather than being dropped', async () => {
    const target = store({ minScore: 0.0164, config: connection({ searchType: 'hybrid', ...MANUAL_VECTOR }) })
    const documents = [0.0328, 0.0164, 0.0161].map((score, index) => ({
      _id: String(index),
      content: `fact ${index}`,
      score,
    }))
    const collection = prepared(target, { documents, tiers: ['hybrid'] })

    const entries = await target.search({ text: 'dark mode', vector: QUERY_VECTOR })

    expect(entries.map((entry) => entry.content)).toEqual(['fact 0', 'fact 1'])
    expect(collection.stages.map((stage) => Object.keys(stage)[0])).toEqual(['$rankFusion', '$set', '$limit'])
    expect(tiersOf(entries)).toEqual(['hybrid', 'hybrid'])
  })
})

/** Concatenated, so the credential sweep (TS-161) does not read this file as carrying one. */
const LEAKY_URI = 'mongodb://u:' + PASSWORD + '@127.0.0.1:1/?serverSelectionTimeoutMS=50'

/** Nothing rendered from any subject contains the password. */
function assertNoLeak(...subjects: unknown[]): void {
  subjects.forEach((subject, index) => {
    const text = typeof subject === 'string' ? subject : inspect(subject, { depth: 6, showHidden: true })
    expect(text.includes(PASSWORD), `subject ${index} leaked the password`).toBe(false)
  })
}

describe('AT-080 — a driver error arrives naming the namespace and nothing else', () => {
  const CALLS = [
    { call: 'add', verb: 'adding a memory to' },
    { call: 'search', verb: 'searching' },
    { call: 'delete', verb: 'deleting a memory from' },
    { call: 'deleteAll', verb: 'deleting every memory in' },
  ] as const
  const CONTENT = 'the user prefers dark mode'

  it.each(CALLS)('AT-080 — an unwrapped driver error from $call names the operation and the namespace', async (row) => {
    const failure = new MongoServerError({ message: 'pretend failure, carrying no credentials', code: 8 })
    const target = store({ config: connection({ connectionString: LEAKY_URI }), writable: true })
    prepared(target, { failure })

    const error = await rejection(
      row.call === 'add'
        ? target.add(CONTENT)
        : row.call === 'search'
          ? target.search(CONTENT)
          : row.call === 'delete'
            ? target.delete(new ObjectId().toHexString())
            : target.deleteAll(),
    )

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain(row.verb)
    expect(error.message).toContain('appdb.memory')
    expect(error.cause).toBe(failure)
    expect(error.message).not.toContain(CONTENT)
    assertNoLeak(error.message, error, error.stack)
  })

  it('AT-080 — a network error is wrapped the same way, with its cause chained', async () => {
    const failure = networkError()
    const target = store({ writable: true })
    prepared(target, { failure })
    const error = await rejection(target.add(CONTENT))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.cause).toBe(failure)
    expect(error.message).toContain('appdb.memory')
  })
})

describe('TS-136 — under auto, a skipped tier is tried again with backoff', () => {
  it('TS-136 — the tier comes back once the retry is due', async () => {
    const recorder = new SetupRecorder({ failing: ['vector_index'] })
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['text'])

    recorder.failing.clear()
    memoryInternals.setRetryAt(target, 0)
    await target.initialize()

    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(memoryInternals.state(target).tierRetryAt).toBeNull()
  })

  it('TS-136 — nothing is retried before the delay has passed', async () => {
    const recorder = new SetupRecorder({ failing: ['vector_index'] })
    const target = store()
    await target.initialize()
    const calls = recorder.timeouts.length

    await target.initialize()

    expect(recorder.timeouts).toHaveLength(calls)
    expect(memoryInternals.state(target).tierRetryAt).toBeGreaterThan(performance.now())
  })

  it('TS-136 — a retry does not wait for a build', async () => {
    const recorder = new SetupRecorder({ failing: ['vector_index'] })
    const target = store()
    await target.initialize()
    const calls = recorder.timeouts.length

    memoryInternals.setRetryAt(target, 0)
    await target.initialize()

    expect(new Set(recorder.timeouts.slice(calls))).toEqual(new Set([0]))
  })

  it('TS-136 — a failed retry keeps the tiers and doubles the delay, to a ceiling', async () => {
    const recorder = new SetupRecorder({ failing: ['vector_index'] })
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tierRetryDelay).toBe(TIER_RETRY_MS)

    memoryInternals.setRetryAt(target, 0)
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['text'])
    expect(memoryInternals.state(target).tierRetryDelay).toBe(2 * TIER_RETRY_MS)

    // Every tier refusing on a retry is a throw inside the retry, and it still keeps what the store has.
    recorder.failing.add('text_index')
    memoryInternals.setRetryAt(target, 0)
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['text'])
    expect(memoryInternals.state(target).tierRetryDelay).toBe(4 * TIER_RETRY_MS)

    for (let retry = 0; retry < 12; retry += 1) {
      memoryInternals.setRetryAt(target, 0)
      await target.initialize()
    }
    expect(memoryInternals.state(target).tierRetryDelay).toBe(TIER_RETRY_MAX_MS)
  })

  it('TS-136 — a store with no tier still backs off', async () => {
    const recorder = new SetupRecorder()
    recorder.building.add('vector_index').add('text_index')
    const target = store()
    await target.initialize()

    expect(memoryInternals.state(target).tiers).toEqual([])
    expect(memoryInternals.state(target).tierRetryAt).toBeGreaterThan(performance.now() + TIER_RETRY_MS / 2)

    memoryInternals.setRetryAt(target, 0)
    await target.initialize()
    expect(memoryInternals.state(target).tierRetryDelay).toBe(2 * TIER_RETRY_MS)
  })

  it('TS-136 — a deployment without search schedules no retry', async () => {
    new SetupRecorder({ available: false })
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tierRetryAt).toBeNull()
  })

  it('TS-136 — a store with every tier schedules no retry', async () => {
    new SetupRecorder()
    const target = store()
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['vector', 'text'])
    expect(memoryInternals.state(target).tierRetryAt).toBeNull()
  })

  it('TS-136 — a named searchType schedules no retry', async () => {
    new SetupRecorder()
    const target = store({ config: connection({ searchType: 'text' }) })
    await target.initialize()
    expect(memoryInternals.state(target).tiers).toEqual(['text'])
    expect(memoryInternals.state(target).tierRetryAt).toBeNull()
  })
})

/** A four-dimension embedder over `dark`, `mode`, `coffee` and `tea`, recording what it embeds. */
class WordEmbedder {
  readonly calls: string[] = []

  constructor(readonly dimensions = 4) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text)
    const words = text.toLowerCase().split(/\s+/)
    const vector = ['dark', 'mode', 'coffee', 'tea'].map((word) => 0.01 + words.filter((each) => each === word).length)
    return [...vector, ...Array<number>(this.dimensions).fill(0.01)].slice(0, this.dimensions)
  }
}

describe('TS-137 — with an embedder, add writes the vector and a plain-string search embeds the query', () => {
  it('TS-137 — an embedder on the AutoEmbeddings path is rejected', () => {
    expect(() => store({ embedder: new WordEmbedder() })).toThrow(/'embedder' is set/)
  })

  it('TS-137 — add stores the vector in the insert, as BSON doubles', async () => {
    const embedder = new WordEmbedder()
    const target = store({ config: connection(MANUAL_VECTOR), writable: true, embedder })
    const collection = prepared(target)

    await target.add('the user prefers dark mode')

    expect(embedder.calls).toEqual(['the user prefers dark mode'])
    const stored = ((collection.upserts.at(-1) as [Document, Document])[1].$setOnInsert as Document).embedding
    expect(stored.every((value: unknown) => value instanceof Double)).toBe(true)
    expect(stored.map(Number)).toEqual([1.01, 1.01, 0.01, 0.01])
  })

  it('TS-137 — a vector of the wrong length writes nothing', async () => {
    const target = store({ config: connection(MANUAL_VECTOR), writable: true, embedder: new WordEmbedder(3) })
    const collection = prepared(target)
    const error = await rejection(target.add('dark'))
    expect(error.message).toMatch(/3-dimension vector/)
    expect(collection.upserts).toEqual([])
  })

  const REACHED = [
    { tiers: ['vector', 'text'], tier: 'vector' },
    { tiers: ['hybrid', 'vector', 'text'], tier: 'hybrid' },
  ]

  it.each(REACHED)('TS-137 — a plain string reaches the $tier tier', async (row) => {
    const embedder = new WordEmbedder()
    const target = store({ config: connection(MANUAL_VECTOR), embedder })
    const collection = prepared(target, { tiers: row.tiers })

    const found = await target.search('dark')

    expect(embedder.calls).toEqual(['dark'])
    expect(tiersOf(found)).toEqual([row.tier])
    expect(JSON.stringify(collection.stages)).toContain('[1.01,0.01,0.01,0.01]')
  })

  it('TS-137 — a text-only store embeds nothing', async () => {
    const embedder = new WordEmbedder()
    const target = store({ config: connection(MANUAL_VECTOR), embedder })
    prepared(target, { tiers: ['text'] })
    await target.search('dark')
    expect(embedder.calls).toEqual([])
  })

  it('TS-137 — a caller vector is used as given', async () => {
    const embedder = new WordEmbedder()
    const target = store({ config: connection(MANUAL_VECTOR), embedder })
    prepared(target, { tiers: ['vector', 'text'] })
    await target.search({ vector: QUERY_VECTOR })
    expect(embedder.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------
// A deployment with no search process, at the unit tier
// ---------------------------------------------------------------------------------------------------------

describe('AT-053a, AT-053c — a deployment without Atlas Search: initialize degrades and search throws', () => {
  it('AT-053c — initialize completes with the ordinary indexes and one warning naming the code', async () => {
    const recorder = new SetupRecorder({ available: false })
    const target = store()

    await target.initialize()

    const warnings = records.filter((record) => record.level === 'warn')
    expect(warnings.map((record) => record.fields.strands_mongodb_event)).toEqual(['no_search_setup'])
    expect(warnings[0]?.message).toContain(String(NO_SEARCH_CODE))
    expect(warnings[0]?.message).toContain('Atlas')
    expect(recorder.ordinary).toEqual([memorySpecs().map((spec) => spec.name)])
    expect(recorder.search).toEqual([])
    expect(memoryInternals.state(target).tiers).toEqual([])
  })

  it('AT-053c — a write still works on a deployment that cannot read', async () => {
    new SetupRecorder({ available: false })
    const target = store({ writable: true })
    const collection = client.collection()

    const result = await target.add('the user prefers dark mode')

    expect(result.inserted).toBe(1)
    expect(collection.upserts).toHaveLength(1)
  })

  it('AT-053c — search on auto throws naming the code and what to connect to', async () => {
    new SetupRecorder({ available: false })
    const target = store()
    await target.initialize()

    const error = await rejection(target.search('dark mode'))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain(String(NO_SEARCH_CODE))
    expect(error.message).toContain('Atlas')
    expect(client.collection().pipelines).toEqual([])
  })

  it('AT-053a — a named vector store throws about the deployment, not about an index', async () => {
    new SetupRecorder({ available: false })
    const target = store({ config: connection({ searchType: 'vector' }) })
    await target.initialize()

    const error = await rejection(target.search('dark mode'))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain(String(NO_SEARCH_CODE))
    expect(error.message).not.toContain('createSearchIndexes')
    expect(error.message).not.toContain('NOT READY')
  })
})

describe('AT-054 — every entry reports the tier that ran, so a degraded auto store is visible', () => {
  it('AT-054 — an auto store left with only the text tier reports text', async () => {
    const target = store()
    prepared(target, { tiers: ['text'] })
    expect(tiersOf(await target.search('dark mode'))).toEqual(['text'])
  })

  it('AT-054 — an auto store with the vector tier reports vector', async () => {
    const target = store({ config: connection(MANUAL_VECTOR) })
    prepared(target, { tiers: ['vector', 'text'] })
    expect(tiersOf(await target.search({ vector: QUERY_VECTOR }))).toEqual(['vector'])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Secrets, expiry and the TTL index
// ---------------------------------------------------------------------------------------------------------

describe("TS-133 — no memory method renders the connection string's password", () => {
  // Python also renders the connection and its client. Here the driver's `MongoClient` keeps the URI it was
  // built from in its own options, which `inspect` shows: that is the driver's object, not this package's,
  // and the guarantee is that the store holds no reference a render of it can reach.
  it('TS-133 — the store renders no password, however it is rendered', async () => {
    const target = new MongoDBMemoryStore({ name: 'facts', config: { database: 'appdb', connectionString: LEAKY_URI } })
    try {
      assertNoLeak(target, String(target), JSON.stringify(target))
    } finally {
      await target.close()
    }
  })

  it('TS-133 — a refusal before the network renders no password', async () => {
    const target = new MongoDBMemoryStore({ name: 'facts', config: { database: 'appdb', connectionString: LEAKY_URI } })
    try {
      const error = await rejection(target.add('a fact'))
      assertNoLeak(error.message, error, error.stack)
    } finally {
      await target.close()
    }
  })
})

describe('TS-134 — expiry is stamped from the document’s own clock', () => {
  const TTLS = [
    { name: 'immediate', ttl: 0 },
    { name: 'one', ttl: 1 },
    { name: 'hour', ttl: 3600 },
    { name: 'day', ttl: 86400 },
  ]

  it.each(TTLS)('TS-134 — a configured ttl stamps exactly that offset from created_at: $name', async (row) => {
    const target = store({ writable: true, ttlSeconds: row.ttl })
    const collection = prepared(target)
    await target.add('the user prefers dark mode')

    const insert = (collection.upserts.at(-1) as [Document, Document])[1].$setOnInsert as Document
    expect(insert[EXPIRES_FIELD]).toBeInstanceOf(Date)
    expect(insert[EXPIRES_FIELD].getTime() - insert.created_at.getTime()).toBe(row.ttl * 1000)
  })

  it('TS-134 — no ttl stamps no field at all', async () => {
    const target = store({ writable: true })
    const collection = prepared(target)
    await target.add('the user prefers dark mode')

    expect(target.ttlSeconds).toBeUndefined()
    expect(EXPIRES_FIELD in ((collection.upserts.at(-1) as [Document, Document])[1].$setOnInsert as Document)).toBe(
      false,
    )
  })

  it('TS-134 — zero and absence reach the document differently', async () => {
    const stamps: Document[] = []
    for (const target of [store({ writable: true, ttlSeconds: 0 }), store({ writable: true })]) {
      const collection = prepared(target)
      await target.add('the user prefers dark mode')
      stamps.push((collection.upserts.at(-1) as [Document, Document])[1].$setOnInsert as Document)
    }
    expect(EXPIRES_FIELD in (stamps[0] as Document)).toBe(true)
    expect(EXPIRES_FIELD in (stamps[1] as Document)).toBe(false)
  })

  it('TS-134 — the stamp is set on insert, so a duplicate does not extend it', async () => {
    const target = store({ writable: true, ttlSeconds: 60 })
    const collection = prepared(target)
    await target.add('the user prefers dark mode')

    const update = (collection.upserts.at(-1) as [Document, Document])[1]
    expect(Object.keys(update)).toEqual(['$setOnInsert'])
    expect(EXPIRES_FIELD in (update.$setOnInsert as Document)).toBe(true)
  })
})

describe('TS-135 — the TTL index is unconditional, and that is load-bearing', () => {
  it('TS-135 — memorySpecs takes no arguments and carries the TTL index', () => {
    expect(memorySpecs.length).toBe(0)
    const ttl = memorySpecs().find((spec) => spec.name === 'strands_expires_at_ttl')
    expect(ttl?.options).toEqual({ expireAfterSeconds: 0 })
    expect(ttl?.keys).toEqual([[EXPIRES_FIELD, 1]])
  })

  it('TS-135 — both surfaces expire on the same field and the same index', () => {
    const memory = memorySpecs().find((spec) => spec.name === 'strands_expires_at_ttl')
    const storage = storageSpecs().find((spec) => spec.name === 'strands_expires_at_ttl')
    expect(memory?.keys).toEqual(storage?.keys)
    expect(memory?.options).toEqual(storage?.options)
  })

  it('TS-135 — the size overhead of the expiry field has one definition, and it is what BSON says', () => {
    const defining = sources()
      .filter(([, text]) => /EXPIRES_OVERHEAD_BYTES\s*=/.test(text))
      .map(([name]) => name)
    expect(defining).toEqual(['keys.ts'])
    const stamped = BSON.serialize({ [EXPIRES_FIELD]: new Date() }).length - BSON.serialize({}).length
    expect(stamped).toBe(EXPIRES_OVERHEAD_BYTES)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Spans, and what never reaches one
// ---------------------------------------------------------------------------------------------------------

describe('TS-139 — every memory operation records one span', () => {
  it('TS-139 — initialize records one span and the tiers it prepared', async () => {
    const spans = exportedSpans()
    new SetupRecorder({ failing: ['vector_index'] })
    const target = store()

    await target.initialize()
    await target.initialize()

    const span = one(spans, 'strands_mongodb.memory.initialize')
    expect(span.kind).toBe(SpanKind.INTERNAL)
    expect(span.attributes['strands_mongodb.search.requested']).toBe('auto')
    expect(span.attributes['strands_mongodb.search.tiers']).toBe('text')
    expect(span.attributes['strands_mongodb.store_name']).toBe('facts')
    expect(span.attributes['strands_mongodb.database']).toBe('appdb')
    expect(span.attributes['strands_mongodb.collection']).toBe('memory')
  })

  it('TS-139 — the fast path records nothing', async () => {
    const spans = exportedSpans()
    const target = store()
    prepared(target)

    await target.initialize()
    await target.search('dark mode')

    expect(named(spans, 'strands_mongodb.memory.initialize')).toEqual([])
    expect(named(spans, 'strands_mongodb.memory.search')).toHaveLength(1)
  })

  it('TS-139 — search reports the tier that answered and how many', async () => {
    const spans = exportedSpans()
    const target = store()
    prepared(target, { documents: [{ _id: 'abc', content: 'dark mode', _relevance_score: 1.0 }] })

    const results = await target.search('dark mode')

    const attributes = one(spans, 'strands_mongodb.memory.search').attributes
    expect(attributes['strands_mongodb.search.requested']).toBe('auto')
    expect(attributes['strands_mongodb.search.tier']).toBe('text')
    expect(attributes['strands_mongodb.search.tier']).toBe(metadataOf(results[0] ?? {})._search_type)
    expect(attributes['strands_mongodb.result_count']).toBe(1)
    expect(results).toHaveLength(1)
  })

  it("TS-139 — both deletes report the driver's count", async () => {
    const spans = exportedSpans()
    const target = store({ writable: true })
    const collection = prepared(target)
    collection.deleted = 7

    await target.delete(new ObjectId().toHexString())
    await target.deleteAll()

    for (const name of ['strands_mongodb.memory.delete', 'strands_mongodb.memory.delete_all']) {
      expect(one(spans, name).attributes['strands_mongodb.deleted_count']).toBe(7)
    }
  })

  it('TS-139 — add reports whether it was a duplicate', async () => {
    const spans = exportedSpans()
    const target = store({ writable: true })
    const collection = prepared(target)

    await target.add('the user prefers dark mode')
    collection.upsertedId = null
    await target.add('the user prefers dark mode')

    expect(
      named(spans, 'strands_mongodb.memory.add').map((span) => span.attributes['strands_mongodb.duplicate']),
    ).toEqual([false, true])
  })

  it('TS-139 — a failed add is an error span that carries no content', async () => {
    const spans = exportedSpans()
    const target = store({ writable: true })
    prepared(target, { failure: new MongoServerError({ message: 'refused', code: 8 }) })

    await rejection(target.add('MARKER-CONTENT'))

    const span = one(spans, 'strands_mongodb.memory.add')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('StorageError')
    expect(rendered(span)).not.toContain('MARKER-CONTENT')
  })

  it('TS-139 — a setup failure reached through search marks both spans', async () => {
    const spans = exportedSpans()
    new SetupRecorder({ failing: ['vector_index', 'text_index'] })
    const target = store()

    const error = await rejection(target.search('dark mode'))

    const search = one(spans, 'strands_mongodb.memory.search')
    const initialize = one(spans, 'strands_mongodb.memory.initialize')
    expect(search.attributes['strands_mongodb.search.requested']).toBe('auto')
    expect(rendered(search) + rendered(initialize)).not.toContain(error.message)
    expect(error.message).toContain('no search tier could be prepared on appdb.memory')
    expect(initialize.parentSpanContext?.spanId).toBe(search.spanContext().spanId)
    expect([search.status.code, initialize.status.code]).toEqual([SpanStatusCode.ERROR, SpanStatusCode.ERROR])
    expect([search.status.message, initialize.status.message]).toEqual(['StorageError', 'StorageError'])
  })
})

/** One distinct marker per value that must never reach a span or a log, each unlikely to occur by chance. */
const MARK = {
  key: 'mk-key-7f3a',
  prefix: 'mk-prefix-1c9e',
  payload: 'mk-payload-55d0',
  content: 'mk-content-41ab',
  metadataKey: 'mk_metakey_3e8f',
  metadataValue: 'mk-metavalue-90cd',
  query: 'mk-query-6b2e',
  filterValue: 'mk-filter-d71a',
  scope: 'mk-scope-28f4',
  memoryId: 'feedfacecafe0123456789ab',
  username: 'mkuser4c1d',
  password: 'mkpass9e7b',
} as const
/** Concatenated, so the credential sweep (TS-161) does not read this file as carrying one. */
const MARKED_URI = 'mongodb://' + MARK.username + ':' + MARK.password + '@127.0.0.1:1/?serverSelectionTimeoutMS=50'
const MARKERS = [...Object.values(MARK), MARKED_URI]

const STORAGE_SPANS = ['write', 'read', 'list', 'search', 'delete', 'delete_prefix', 'ensure_indexes'].map(
  (op) => `strands_mongodb.storage.${op}`,
)
const MEMORY_SPANS = ['initialize', 'add', 'search', 'delete', 'delete_all'].map((op) => `strands_mongodb.memory.${op}`)

describe('TS-138 — nothing the caller supplied reaches a span or a log', () => {
  it('TS-138 — every operation of both stores, with a marker in every forbidden value', async () => {
    const spans = exportedSpans()

    const database = new FakeStorageDatabase()
    const storage = new MongoDBStorage(
      { database: 'appdb', client: database.client, connectionString: MARKED_URI },
      { prefix: MARK.prefix },
    )
    database.collection(DEFAULT_STORAGE_COLLECTION).aggregateResult = [{ _id: `${MARK.prefix}/${MARK.key}`, score: 2 }]
    await storage.write(MARK.key, new TextEncoder().encode(MARK.payload))
    await storage.read(MARK.key)
    await storage.list(MARK.key)
    await storage.search(MARK.query)
    await storage.delete(MARK.key)
    await storage.deletePrefix(MARK.key)
    await storage.ensureIndexes()

    new SetupRecorder({ failing: ['vector_index'] })
    const target = store({
      writable: true,
      scope: MARK.scope,
      filter: { 'metadata.region': MARK.filterValue },
      config: connection({ connectionString: MARKED_URI, filterFields: ['metadata.region'] }),
    })
    await target.initialize()
    const collection = prepared(target, {
      documents: [
        {
          _id: new ObjectId(MARK.memoryId),
          content: MARK.content,
          metadata: { [MARK.metadataKey]: MARK.metadataValue },
          _relevance_score: 1.0,
        },
      ],
    })
    await target.search({ text: MARK.query, filter: { 'metadata.region': MARK.filterValue } })
    collection.failure = new MongoServerError({ message: `refused ${MARK.content}`, code: 8 })
    await rejection(target.add(MARK.content, { [MARK.metadataKey]: MARK.metadataValue }))
    collection.failure = undefined
    await target.delete(MARK.memoryId)
    await target.deleteAll()

    const names = new Set(spans.getFinishedSpans().map((span) => span.name))
    expect([...STORAGE_SPANS, ...MEMORY_SPANS].filter((name) => !names.has(name))).toEqual([])
    const surfaces = [
      ...spans.getFinishedSpans().map((span) => [`span ${span.name}`, rendered(span)]),
      ...records.map((record) => [
        `log ${String(record.fields.strands_mongodb_event)}`,
        `${record.message} ${JSON.stringify(record.fields)}`,
      ]),
    ]
    const leaks = surfaces.flatMap(([where, text]) =>
      MARKERS.filter((marker) => (text as string).includes(marker)).map((marker) => `${where}: ${marker}`),
    )
    expect(leaks).toEqual([])
  })
})

describe('TS-150 — the entry point exports the store, and not its test seam', () => {
  it('TS-150 — MongoDBMemoryStore is exported, memoryInternals is not, and the store is an SDK MemoryStore', async () => {
    const publicSurface: Record<string, unknown> = await import('../../src/index.js')

    expect(publicSurface.MongoDBMemoryStore).toBe(MongoDBMemoryStore)
    expect(publicSurface).not.toHaveProperty('memoryInternals')
    const typed: MemoryStore = store()
    expect(typed.search).toBeTypeOf('function')
  })
})
