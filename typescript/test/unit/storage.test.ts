/**
 * `MongoDBStorage` against a fake database injected through `config.client`.
 *
 * Ports the fake-backed half of `python/tests/test_storage.py` and the storage spans of
 * `python/tests/test_telemetry.py`. What a fake cannot show, that a server agrees, is
 * `test/contract/storage.test.ts`.
 *
 * The checklist ids are used as they are. The Python ids that are not checklist items lead with `TS-` ids:
 * AT-034 and AT-044c are TS-065, AT-030 is TS-066, AT-039 TS-067, AT-037 TS-068, AT-020 and AT-035's unit
 * companions TS-069, AT-014's storage half TS-070, AT-032a and AT-032c TS-071, AT-229 TS-072, AT-236 TS-073,
 * AT-121 and AT-123 TS-074, AT-126 TS-075, AT-124 TS-076, AT-176 TS-077, AT-192 TS-078, AT-202 and AT-205
 * TS-079, AT-226 TS-080, the fake's parity with the driver TS-081, and AT-026b TS-082.
 *
 * AT-208, nothing the caller supplied reaching a span or a log, drives both stores in one test and lands
 * with the memory store.
 */
import { inspect } from 'node:util'

import { SpanKind } from '@opentelemetry/api'
import { StorageError } from '@strands-agents/sdk'
import type { Storage } from '@strands-agents/sdk'
import {
  KeywordSearchStrategy,
  type SearchStrategy,
  type StorageSearchResult,
} from '@strands-agents/sdk/storage/search'
import { AggregationCursor, BSON, Collection, Db, FindCursor, MongoClient } from 'mongodb'
import type { Document } from 'mongodb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { REGISTRY, resolve } from '../../src/client.js'
import * as lifecycle from '../../src/index-lifecycle.js'
import { DOCUMENT_OVERHEAD_BYTES, EXPIRES_OVERHEAD_BYTES } from '../../src/keys.js'
import { MongoDBStorage } from '../../src/storage.js'
import type { MongoDBConfig, MongoDBStorageOptions } from '../../src/types.js'
import { DEFAULT_STORAGE_COLLECTION, EXPIRES_FIELD, MAX_DOCUMENT_BYTES, READY_TIMEOUT_MS } from '../../src/types.js'
import { FakeCursor, FakeStorageCollection, FakeStorageDatabase } from '../support/fake-storage.js'
import { networkError } from '../support/fake-indexes.js'
import { exportedSpans, named, one, rendered } from '../support/spans.js'

// A pass-through mock, so the AT-126 test can read the arguments `ensure` was given while every other
// test runs the real function.
vi.mock('../../src/index-lifecycle.js', async (original) => {
  const actual = await original<typeof import('../../src/index-lifecycle.js')>()
  return { ...actual, ensure: vi.fn(actual.ensure) }
})

/** The SDK's marker for an already-scoped storage, by its registered name, since the SDK does not export it. */
const NAMESPACED = Symbol.for('strands.storage.namespaced')

/** The password the leak tests look for. */
const PASSWORD = 'SUPERSECRET'

/** A connection string carrying {@link PASSWORD}, built here so no file holds one with credentials. */
const LEAKY_URI = 'mongodb://appuser:' + PASSWORD + '@127.0.0.1:1/appdb'

/** A collation that folds case and accents, as `listCollections` reports one. */
const CASE_INSENSITIVE: Document = {
  locale: 'en',
  caseLevel: false,
  caseFirst: 'off',
  strength: 2,
  numericOrdering: false,
  alternate: 'non-ignorable',
  maxVariable: 'punct',
  normalization: false,
  backwards: false,
  version: '57.1',
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A store, its fake database and its fake collection. */
interface Unit {
  readonly storage: MongoDBStorage
  readonly database: FakeStorageDatabase
  readonly collection: FakeStorageCollection
}

/** A store over a fresh fake, with any option or config key overridden. */
function unit(
  options: MongoDBStorageOptions = {},
  config: Partial<MongoDBConfig> = {},
  database = new FakeStorageDatabase(),
): Unit {
  const storage = new MongoDBStorage({ database: database.databaseName, client: database.client, ...config }, options)
  return { storage, database, collection: database.collection(options.collection ?? DEFAULT_STORAGE_COLLECTION) }
}

/** Put documents straight into the fake, as if another writer had. */
function seed(collection: FakeStorageCollection, ...ids: string[]): void {
  for (const id of ids) collection.documents.set(id, { _id: id, data: bytes(id) })
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

/** Copied from the SDK's `resolveNamespace`, which it does not export, so the test asks what the SDK asks. */
function resolveNamespace(storage: Storage, prefix: string): Storage {
  if (NAMESPACED in storage) return storage
  if (storage.namespace !== undefined) return storage.namespace(prefix)
  throw new Error('the SDK would wrap this storage in its own view')
}

beforeEach(() => {
  REGISTRY.clear()
  vi.mocked(lifecycle.ensure).mockClear()
})

describe('TS-065 — the SDK Storage contract is satisfied structurally', () => {
  it('TS-065 — the store types as a Storage and every method returns a promise', async () => {
    const { storage } = unit()
    const typed: Storage = storage
    expect(typed.write('a', bytes('x'))).toBeInstanceOf(Promise)
    expect(typed.read('a')).toBeInstanceOf(Promise)
    expect(typed.list('')).toBeInstanceOf(Promise)
    expect(typed.delete('a')).toBeInstanceOf(Promise)
    expect(typed.search?.('a')).toBeInstanceOf(Promise)
    await Promise.resolve()
  })

  it('TS-065 — forSandbox is absent, so the context offloader falls back rather than calling a stub', () => {
    expect('forSandbox' in unit().storage).toBe(false)
  })
})

describe('TS-066 / TS-067 — namespace returns a real store, marked as already scoped', () => {
  it('TS-066 — the result is a MongoDBStorage with deletePrefix, and carries the SDK marker', () => {
    const scoped = unit().storage.namespace('tenant-a')
    expect(scoped).toBeInstanceOf(MongoDBStorage)
    expect(typeof scoped.deletePrefix).toBe('function')
    expect((scoped as unknown as Record<symbol, unknown>)[NAMESPACED]).toBe(true)
  })

  it('TS-066 — an unscoped store carries no marker, or the SDK would never scope it', () => {
    expect(NAMESPACED in unit().storage).toBe(false)
  })

  it('TS-067 — through the SDK resolver, an unscoped store is scoped once and a scoped one is kept', () => {
    const { storage } = unit()
    const scoped = resolveNamespace(storage, 'memory') as MongoDBStorage
    expect(scoped).not.toBe(storage)
    expect(scoped.prefix).toBe('memory/')
    expect(resolveNamespace(scoped, 'memory')).toBe(scoped)
  })

  it('TS-066 — namespaces nest, and keep the collection and the TTL', () => {
    const { storage } = unit({ collection: 'transcripts', ttlSeconds: 60 })
    const nested = storage.namespace('tenant-a').namespace('sessions')
    expect(nested.prefix).toBe('tenant-a/sessions/')
    expect(nested.collectionName).toBe('transcripts')
    expect(nested.ttlSeconds).toBe(60)
  })

  it('TS-066 — a namespace shares the connection rather than opening another', () => {
    const { storage } = unit()
    storage.namespace('a').namespace('b')
    expect(REGISTRY.size).toBe(1)
  })

  it.each(['tenant-a', 'tenant-a/', '/tenant-a', 'tenant-a//'])(
    'TS-066 — the prefix %j normalises to one key space',
    (prefix) => {
      expect(unit({ prefix }).storage.prefix).toBe('tenant-a/')
      expect(unit().storage.namespace(prefix).prefix).toBe('tenant-a/')
    },
  )
})

describe("AT-018 — keys are normalised the SDK's way before they become ids", () => {
  it.each(['a//b', '/a/b', 'a/b/', '//a//b//'])('AT-018 — %j is stored as a/b', async (key) => {
    const { storage, collection } = unit()
    await storage.write(key, bytes('x'))
    expect([...collection.documents.keys()]).toEqual(['a/b'])
  })

  it('AT-018 — a key written under one spelling reads back under another', async () => {
    const { storage } = unit()
    await storage.write('a//b', bytes('x'))
    expect(await storage.read('/a/b/')).toEqual(bytes('x'))
  })

  it.each(['', '/', '//'])('AT-018 — %j is empty once normalised, and nothing is sent', async (key) => {
    const { storage, collection, database } = unit()
    const error = await rejection(storage.write(key, bytes('x')))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('empty')
    expect(collection.calls).toEqual([])
    expect(database.listCollectionsCalls).toBe(0)
  })

  it("AT-018 — a '..' segment is refused by write, read and delete", async () => {
    const { storage, collection } = unit()
    for (const call of [
      () => storage.write('a/../b', bytes('x')),
      () => storage.read('a/../b'),
      () => storage.delete('a/../b'),
    ]) {
      expect(await rejection(call())).toBeInstanceOf(StorageError)
    }
    expect(collection.calls).toEqual([])
  })

  it('AT-018 — read and delete normalise too', async () => {
    const { storage, collection } = unit()
    await storage.read('//a//b//')
    await storage.delete('a//b')
    expect(collection.calls.map(([, args]) => args[0])).toEqual([{ _id: 'a/b' }, { _id: 'a/b' }])
  })

  it('AT-018 — the instance prefix is applied after normalising the key', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a' })
    await storage.write('//a//b', bytes('x'))
    expect([...collection.documents.keys()]).toEqual(['tenant-a/a/b'])
  })
})

describe('AT-019 — list and deletePrefix normalise their argument as a prefix', () => {
  it.each([
    ['a//b', 'a/b'],
    ['/a/b', 'a/b'],
    ['a/b/', 'a/b/'],
  ])('AT-019 — %j scans from %j', async (query, lower) => {
    const { storage, collection } = unit()
    await storage.list(query)
    expect((collection.calls[0]?.[1][0] as Document)._id.$gte).toBe(lower)
  })

  it("AT-019 — list('') sends an empty filter and returns every key", async () => {
    const { storage, collection } = unit()
    seed(collection, 'b', 'a')
    expect(await storage.list('')).toEqual(['a', 'b'])
    expect(collection.calls[0]?.[1][0]).toEqual({})
  })

  it("AT-019 — a '..' segment is refused, and nothing is sent", async () => {
    const { storage, collection } = unit()
    expect(await rejection(storage.list('a/../b'))).toBeInstanceOf(StorageError)
    expect(await rejection(storage.deletePrefix('a/../b'))).toBeInstanceOf(StorageError)
    expect(collection.calls).toEqual([])
  })

  it('AT-019 — deletePrefix normalises its prefix the same way', async () => {
    const { storage, collection } = unit()
    await storage.deletePrefix('//a//')
    expect((collection.calls[0]?.[1][0] as Document)._id.$gte).toBe('a/')
  })

  it("AT-019 — a trailing slash is significant: 'sessions/' does not match 'sessions-archive/x'", async () => {
    const { storage, collection } = unit()
    seed(collection, 'sessions/abc', 'sessions-archive/x')
    expect(await storage.list('sessions/')).toEqual(['sessions/abc'])
    expect(await storage.list('sessions')).toEqual(['sessions-archive/x', 'sessions/abc'])
  })

  it('AT-019 — a namespace prefix bounds the range', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a' })
    await storage.list('')
    expect(collection.calls[0]?.[1][0]).toEqual({ _id: { $gte: 'tenant-a/', $lt: 'tenant-a0' } })
  })
})

describe('TS-082 — the range bound is an encodable successor', () => {
  it.each(['a', 'session/', 'ké', '퟿', 'a\u{10ffff}', '\u{10ffff}'])(
    'TS-082 — the filter for %j encodes as BSON',
    async (query) => {
      const { storage, collection } = unit()
      await storage.list(query)
      expect(() => BSON.serialize(collection.calls[0]?.[1][0] as Document)).not.toThrow()
    },
  )

  it('TS-082 — U+D7FF bounds at U+E000, skipping the surrogates', async () => {
    const { storage, collection } = unit()
    await storage.list('퟿')
    expect((collection.calls[0]?.[1][0] as Document)._id.$lt).toBe('')
  })

  it('TS-082 — U+10FFFF alone has no upper bound, and after a character it carries left', async () => {
    const { storage, collection } = unit()
    await storage.list('\u{10ffff}')
    await storage.list('a\u{10ffff}')
    expect((collection.calls[0]?.[1][0] as Document)._id).toEqual({ $gte: '\u{10ffff}' })
    expect((collection.calls[1]?.[1][0] as Document)._id.$lt).toBe('b')
  })
})

describe('TS-069 — the calls each method issues, and the document write builds', () => {
  it('TS-069 — write is one upserting replaceOne', async () => {
    const { storage, collection } = unit()
    await storage.write('a/b', bytes('payload'))
    expect(collection.namesCalled).toEqual(['replaceOne'])
    expect(collection.calls[0]?.[1][0]).toEqual({ _id: 'a/b' })
    expect(collection.calls[0]?.[1][2]).toEqual({ upsert: true })
  })

  it('TS-069 — the document carries the payload and a Date, and no expiry without a TTL', async () => {
    const { storage, collection } = unit()
    await storage.write('a/b', bytes('payload'))
    const document = collection.documents.get('a/b') as Document
    expect(new Uint8Array(document.data as Uint8Array)).toEqual(bytes('payload'))
    expect(document.updated_at).toBeInstanceOf(Date)
    expect(EXPIRES_FIELD in document).toBe(false)
  })

  it('TS-069 — a TTL writes the field the TTL index watches, the TTL ahead of the timestamp', async () => {
    const { storage, collection } = unit({ ttlSeconds: 60 })
    await storage.write('a/b', bytes('payload'))
    const document = collection.documents.get('a/b') as Document
    expect((document[EXPIRES_FIELD] as Date).getTime() - (document.updated_at as Date).getTime()).toBe(60_000)
  })

  it('TS-069 — read returns a plain Uint8Array, not a Buffer', async () => {
    const { storage } = unit()
    await storage.write('a/b', bytes('payload'))
    const found = await storage.read('a/b')
    expect(found).toEqual(bytes('payload'))
    expect(Buffer.isBuffer(found)).toBe(false)
    expect(found?.constructor).toBe(Uint8Array)
  })

  it('AT-021 — a read of an absent key is one findOne and null, not an error', async () => {
    const { storage, collection } = unit()
    expect(await storage.read('a/b')).toBeNull()
    expect(collection.namesCalled).toEqual(['findOne'])
  })

  it('TS-069 — delete is one deleteOne, and an absent key is not an error', async () => {
    const { storage, collection } = unit()
    await storage.delete('a/b')
    expect(collection.namesCalled).toEqual(['deleteOne'])
  })

  it('TS-069 — list projects only the id and sorts ascending', async () => {
    const { storage, collection } = unit()
    await storage.list('a/')
    expect(collection.calls[0]?.[1][1]).toEqual({ projection: { _id: 1 } })
    expect((collection.cursors[0] as FakeCursor).sortCalls).toEqual([{ _id: 1 }])
  })

  it('TS-069 — list strips the namespace prefix and keeps the query prefix', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a' })
    seed(collection, 'tenant-a/sessions/abc')
    expect(await storage.list('sessions/')).toEqual(['sessions/abc'])
  })

  it('TS-069 — deletePrefix is one deleteMany returning the count', async () => {
    const { storage, collection } = unit()
    seed(collection, 'a/one', 'a/two', 'b/three')
    expect(await storage.deletePrefix('a/')).toBe(2)
    expect(collection.namesCalled).toEqual(['deleteMany'])
  })
})

describe('TS-068 — the key ceiling is 1024 UTF-8 bytes, prefix included', () => {
  it('TS-068 — 1024 bytes is accepted', async () => {
    const { storage } = unit()
    await storage.write('k'.repeat(1024), bytes('x'))
  })

  it('TS-068 — 1025 bytes is refused naming both numbers, and nothing is sent', async () => {
    const { storage, collection } = unit()
    const error = await rejection(storage.write('k'.repeat(1025), bytes('x')))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('1025')
    expect(error.message).toContain('1024')
    expect(collection.calls).toEqual([])
  })

  it('TS-068 — bytes are counted, not characters', async () => {
    const error = await rejection(unit().storage.write('é'.repeat(600), bytes('x')))
    expect(error.message).toContain('1200')
  })

  it('TS-068 — the prefix counts', async () => {
    const error = await rejection(unit({ prefix: 'tenant-a' }).storage.write('k'.repeat(1020), bytes('x')))
    expect(error).toBeInstanceOf(StorageError)
  })

  it('TS-068 — the message abbreviates the key rather than repeating 1025 characters of it', async () => {
    const error = await rejection(unit().storage.write('k'.repeat(1025), bytes('x')))
    expect(error.message).not.toContain('k'.repeat(61))
    expect(error.message).toContain(`${'k'.repeat(60)}[+965 more]`)
    expect(error.message.length).toBeLessThan(300)
  })

  it('TS-068 — read and delete check it too', async () => {
    const { storage, collection } = unit()
    expect(await rejection(storage.read('k'.repeat(1025)))).toBeInstanceOf(StorageError)
    expect(await rejection(storage.delete('k'.repeat(1025)))).toBeInstanceOf(StorageError)
    expect(collection.calls).toEqual([])
  })
})

describe('AT-038a — the size preflight agrees with the BSON encoder', () => {
  it.each([
    ['an empty payload', 'k', 0, undefined],
    ['one byte', 'k', 1, undefined],
    ['a two-byte key', 'é', 3, undefined],
    ['a four-byte key', '😀', 3, undefined],
    ['a 1024-byte key and 4 MiB', 'k'.repeat(1024), 4 * 1024 * 1024, undefined],
    ['a TTL', 'k', 3, 60],
    ['a large payload and a TTL', 'k'.repeat(100), 4 * 1024 * 1024, 60],
  ])('AT-038a — %s', async (_label, key, length, ttlSeconds) => {
    const { storage, collection } = unit(ttlSeconds === undefined ? {} : { ttlSeconds })
    await storage.write(key, new Uint8Array(length))
    const document = collection.calls[0]?.[1][1] as Document
    const expires = ttlSeconds !== undefined
    const predicted =
      DOCUMENT_OVERHEAD_BYTES + new TextEncoder().encode(key).length + length + (expires ? EXPIRES_OVERHEAD_BYTES : 0)
    expect(BSON.calculateObjectSize(document)).toBe(predicted)
  })

  it('AT-038a — a document exactly at the ceiling is accepted', async () => {
    const { storage, collection } = unit()
    const length = MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_BYTES - 3
    await storage.write('a/b', new Uint8Array(length))
    expect(collection.namesCalled).toEqual(['replaceOne'])
  })

  it('AT-038a — one byte over is refused naming the key, the size and the limit, and nothing is sent', async () => {
    const { storage, collection } = unit()
    const length = MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_BYTES - 3 + 1
    const error = await rejection(storage.write('a/b', new Uint8Array(length)))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("'a/b'")
    expect(error.message).toContain(String(MAX_DOCUMENT_BYTES + 1))
    expect(error.message).toContain(String(MAX_DOCUMENT_BYTES))
    expect(collection.calls).toEqual([])
  })

  it('AT-038a — a TTL lowers the payload allowed by the size of the expiry field', async () => {
    const length = MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_BYTES - 3
    expect(await rejection(unit({ ttlSeconds: 60 }).storage.write('a/b', new Uint8Array(length)))).toBeInstanceOf(
      StorageError,
    )
  })

  it('AT-038a — the limit is the BSON one, 16 MiB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(16_777_216)
  })
})

describe('AT-022 / AT-036 — driver failures become StorageError, with the cause chained', () => {
  const calls: Array<[string, (storage: MongoDBStorage) => Promise<unknown>]> = [
    ['write', (storage) => storage.write('a/b', bytes('x'))],
    ['read', (storage) => storage.read('a/b')],
    ['delete', (storage) => storage.delete('a/b')],
    ['list', (storage) => storage.list('a/')],
    ['deletePrefix', (storage) => storage.deletePrefix('a/')],
    ['search', (storage) => storage.search('a b')],
  ]

  it.each(calls)('AT-022 — %s wraps the driver error, and the cause is the same object', async (_name, call) => {
    const { storage, collection } = unit()
    const failure = networkError()
    collection.error = failure
    const error = await rejection(call(storage))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.cause).toBe(failure)
    expect(error.message).toContain('appdb.storage')
  })

  it('AT-036 — a failure while the cursor drains is wrapped too', async () => {
    const { storage, collection } = unit({ collection: 'transcripts' })
    seed(collection, 'a/one')
    collection.iterationError = networkError()
    const error = await rejection(storage.list('a/'))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.cause).toBe(collection.iterationError)
    expect(error.message).toContain('appdb.transcripts')
  })

  it('AT-036 — the storage message and the index message end in the same sentence', async () => {
    const { storage, collection } = unit()
    collection.error = networkError()
    const fromStorage = await rejection(storage.read('a/b'))
    const fromIndexes = await rejection(storage.ensureIndexes())
    expect(fromStorage.message).toMatch(/^MongoDBStorage: reading 'a\/b' in appdb\.storage failed: socket timed out$/)
    expect(fromIndexes.message).toMatch(/^strands_mongodb: .* failed: socket timed out$/)
  })

  it('AT-036 — an error that is not the driver’s passes through as the same object', async () => {
    const { storage, collection } = unit()
    const failure = new TypeError('not a driver error')
    collection.error = failure
    expect(await rejection(storage.read('a/b'))).toBe(failure)
  })

  it('AT-036 — a failed collation read is a StorageError naming the namespace', async () => {
    const { storage, database } = unit()
    database.listError = networkError()
    const error = await rejection(storage.read('a/b'))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.cause).toBe(database.listError)
    expect(error.message).toContain('appdb.storage')
  })
})

describe("TS-070 — no storage method renders the connection string's password", () => {
  const assertNoLeak = (...subjects: unknown[]): void => {
    subjects.forEach((subject, index) => {
      const text = typeof subject === 'string' ? subject : inspect(subject, { depth: 6, showHidden: true })
      expect(text.includes(PASSWORD), `subject ${index} leaked the password`).toBe(false)
    })
  }

  it.each(['write', 'read', 'delete', 'list', 'deletePrefix', 'search'] as const)(
    'TS-070 — a wrapped driver failure from %s renders no password',
    async (name) => {
      const { storage, collection } = unit({}, { connectionString: LEAKY_URI })
      collection.error = networkError()
      const error = await rejection(name === 'write' ? storage.write('a/b', bytes('payload')) : storage[name]('a/b'))
      expect(error).toBeInstanceOf(StorageError)
      assertNoLeak(error.message, error, error.stack)
    },
  )

  it('TS-070 — the store, its namespace and its connection render no password', async () => {
    const config: MongoDBConfig = { database: 'appdb', connectionString: LEAKY_URI }
    const storage = new MongoDBStorage(config)
    try {
      assertNoLeak(storage, storage.namespace('tenant-a'), String(storage), JSON.stringify(storage))
    } finally {
      await storage.close()
    }
  })

  it.each([
    ['a long key', 'k'.repeat(1025), 1],
    ['a large payload', 'a/b', 17 * 1024 * 1024],
    ['an empty key', '', 1],
    ['a traversal', 'a/../b', 1],
  ])('TS-070 — %s is refused without rendering the password', async (_label, key, length) => {
    const storage = new MongoDBStorage({ database: 'appdb', connectionString: LEAKY_URI })
    try {
      const error = await rejection(storage.write(key, new Uint8Array(length)))
      expect(error).toBeInstanceOf(StorageError)
      assertNoLeak(error.message, error)
    } finally {
      await storage.close()
    }
  })
})

describe('TS-071 — search is one aggregation over the keys', () => {
  it('TS-071 — one aggregate, and its stages', async () => {
    const { storage, collection } = unit()
    await storage.search('dark mode')
    expect(collection.namesCalled).toEqual(['aggregate'])
    expect((collection.pipelines[0] as Document[]).map((stage) => Object.keys(stage)[0])).toEqual([
      '$project',
      '$match',
      '$sort',
    ])
  })

  it('TS-071 — a prefix bounds the scan with a range match first', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a' })
    await storage.search('dark')
    expect(collection.pipelines[0]?.[0]).toEqual({ $match: { _id: { $gte: 'tenant-a/', $lt: 'tenant-a0' } } })
  })

  it('TS-072 — the prefix is cut off by code point before the key is tokenized', async () => {
    const { storage, collection } = unit({ prefix: 'ténant-a' })
    await storage.search('dark')
    const project = collection.pipelines[0]?.[1] as Document
    expect(JSON.stringify(project)).toContain(JSON.stringify({ $substrCP: ['$_id', 9, { $strLenCP: '$_id' }] }))
  })

  it('TS-071 — the key is tokenized with the Unicode class, never \\w', async () => {
    const { storage, collection } = unit()
    await storage.search('dark')
    const text = JSON.stringify(collection.pipelines[0])
    expect(text).toContain(JSON.stringify('[\\p{L}\\p{N}_]+'))
    expect(text).not.toContain('\\\\w')
  })

  it('TS-071 — the query tokens are lowercased, deduplicated and sorted', async () => {
    const { storage, collection } = unit()
    await storage.search('mode Dark DARK')
    const project = collection.pipelines[0]?.[0] as Document
    const intersection = project.$project.score.$size.$setIntersection as unknown[]
    expect(intersection[1]).toEqual(['dark', 'mode'])
  })

  it('TS-071 — the last two stages drop non-matches and order by score, then key', async () => {
    const { storage, collection } = unit()
    await storage.search('dark')
    expect(collection.pipelines[0]?.slice(-2)).toEqual([
      { $match: { score: { $gt: 0 } } },
      { $sort: { score: -1, _id: 1 } },
    ])
  })

  it('TS-071 — the pipeline reads only the key, never the payload', async () => {
    const { storage, collection } = unit()
    await storage.search('dark')
    const text = JSON.stringify(collection.pipelines[0])
    expect(text).not.toContain('$data')
    expect(text).toContain('$_id')
    expect(text).toContain('$$this.match')
  })

  it.each(['', '   ', '!!! ---', '\n\t'])(
    'TS-071 — the query %j has no tokens and costs no round trip',
    async (query) => {
      const { storage, collection, database } = unit()
      expect(await storage.search(query)).toEqual([])
      expect(collection.calls).toEqual([])
      expect(database.listCollectionsCalls).toBe(0)
    },
  )

  it('TS-071 — results strip the prefix, carry a number score and no data', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a' })
    collection.aggregateResult = [{ _id: 'tenant-a/notes/dark', score: 2 }]
    const results = await storage.search('dark')
    expect(results).toEqual([{ key: 'notes/dark', score: 2 }])
    expect(typeof results[0]?.score).toBe('number')
    expect(results[0]?.data).toBeUndefined()
  })

  it('TS-071 — a failed search names the query and the namespace', async () => {
    const { storage, collection } = unit()
    collection.error = networkError()
    const error = await rejection(storage.search('dark'))
    expect(error.message).toContain("MongoDBStorage: searching 'dark' in appdb.storage failed:")
  })
})

/** A strategy that records what the store hands it and answers a fixed result. */
class RecordingStrategy implements SearchStrategy<MongoDBStorage> {
  readonly indexed: Array<[MongoDBStorage, string, Uint8Array]> = []
  readonly searched: Array<[MongoDBStorage, string]> = []

  constructor(
    private readonly results: StorageSearchResult[] = [],
    private readonly error?: Error,
  ) {}

  async index(storage: MongoDBStorage, key: string, data: Uint8Array): Promise<void> {
    this.indexed.push([storage, key, data])
    if (this.error !== undefined) throw this.error
  }

  async search(storage: MongoDBStorage, query: string): Promise<StorageSearchResult[]> {
    this.searched.push([storage, query])
    if (this.error !== undefined) throw this.error
    return this.results
  }
}

describe('TS-073 — a configured search strategy is called on write and on search', () => {
  it('TS-073 — index receives the store itself, the key without the prefix and the bytes', async () => {
    const strategy = new RecordingStrategy()
    const { storage } = unit({ prefix: 'tenant-a', searchStrategy: strategy })
    await storage.write('notes/one.md', bytes('hello'))
    expect(strategy.indexed).toEqual([[storage, 'notes/one.md', bytes('hello')]])
    expect(strategy.indexed[0]?.[0]).toBe(storage)
  })

  it('TS-073 — an indexing failure is reported, and the document stays written', async () => {
    const strategy = new RecordingStrategy([], new Error('index down'))
    const { storage, collection } = unit({ searchStrategy: strategy })
    const error = await rejection(storage.write('notes/one.md', bytes('hello')))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain(
      "wrote 'notes/one.md' in appdb.storage but indexing it for search failed: index down",
    )
    expect(error.cause).toBeInstanceOf(Error)
    expect(collection.documents.has('notes/one.md')).toBe(true)
  })

  it('TS-073 — a strategy with no index method only writes', async () => {
    const { storage, collection } = unit({ searchStrategy: { search: async () => [] } })
    await storage.write('a', bytes('x'))
    expect(collection.namesCalled).toEqual(['replaceOne'])
  })

  it("TS-073 — search returns the strategy's results and sends nothing of its own", async () => {
    const results = [{ key: 'a', score: 1 }]
    const strategy = new RecordingStrategy(results)
    const { storage, collection } = unit({ searchStrategy: strategy })
    expect(await storage.search('q')).toBe(results)
    expect(strategy.searched).toEqual([[storage, 'q']])
    expect(collection.calls).toEqual([])
  })

  it('TS-073 — a strategy failure that is not a StorageError is wrapped with the namespace', async () => {
    const strategy = new RecordingStrategy([], new Error('boom'))
    const error = await rejection(unit({ searchStrategy: strategy }).storage.search('q'))
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toBe('MongoDBStorage: searching in appdb.storage failed: boom')
  })

  it("TS-073 — a strategy's StorageError passes through as the same object", async () => {
    const failure = new StorageError('already reported')
    const strategy = new RecordingStrategy([], failure)
    expect(await rejection(unit({ searchStrategy: strategy }).storage.search('q'))).toBe(failure)
  })

  it("TS-073 — the SDK's KeywordSearchStrategy finds a word in a payload, which the default search cannot", async () => {
    const database = new FakeStorageDatabase()
    const keyword = unit({ searchStrategy: KeywordSearchStrategy }, {}, database).storage
    const plain = unit({}, {}, database).storage
    await keyword.write('memory/m/user-preferences.md', bytes('prefers dark mode'))
    expect((await keyword.search('dark')).map((result) => result.key)).toEqual(['memory/m/user-preferences.md'])
    expect(await plain.search('dark')).toEqual([])
  })

  it('TS-073 — a namespace shares the strategy, and hands it keys relative to itself', async () => {
    const strategy = new RecordingStrategy()
    const scoped = unit({ searchStrategy: strategy }).storage.namespace('memory')
    await scoped.write('x.md', bytes('x'))
    expect(scoped.prefix).toBe('memory/')
    expect(strategy.indexed[0]?.[0]).toBe(scoped)
    expect(strategy.indexed[0]?.[1]).toBe('x.md')
  })
})

describe('TS-074 — ensureIndexes is explicit and idempotent', () => {
  it('TS-074 — it creates the TTL index on expires_at with expireAfterSeconds 0', async () => {
    const { storage, collection } = unit()
    await storage.ensureIndexes()
    expect(collection.indexes.find((index) => index.name === 'strands_expires_at_ttl')).toMatchObject({
      key: { expires_at: 1 },
      expireAfterSeconds: 0,
    })
  })

  it('TS-074 — a second call reads and creates nothing', async () => {
    const { storage, collection } = unit()
    await storage.ensureIndexes()
    await storage.ensureIndexes()
    expect(collection.namesCalled.filter((name) => name === 'createIndexes')).toHaveLength(1)
    expect(collection.namesCalled.filter((name) => name === 'indexInformation')).toHaveLength(2)
  })

  it('TS-074 — with ensureIndexes false it verifies, naming the index and the command, and creates nothing', async () => {
    const { storage, collection } = unit({}, { ensureIndexes: false })
    const error = await rejection(storage.ensureIndexes())
    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('strands_expires_at_ttl')
    expect(error.message).toContain('createIndexes')
    expect(collection.namesCalled).not.toContain('createIndexes')
  })
})

describe('TS-075 — the index-ready budget reaches ensure', () => {
  it('TS-075 — indexReadyTimeoutMs is passed through', async () => {
    await unit({}, { indexReadyTimeoutMs: 7 }).storage.ensureIndexes()
    expect(vi.mocked(lifecycle.ensure).mock.calls[0]?.[2]?.timeoutMs).toBe(7)
  })

  it('TS-075 — unset, it is the default', async () => {
    await unit().storage.ensureIndexes()
    expect(vi.mocked(lifecycle.ensure).mock.calls[0]?.[2]?.timeoutMs).toBe(READY_TIMEOUT_MS)
  })
})

describe('TS-076 — no ordinary operation touches an index', () => {
  it('TS-076 — the six operations call exactly the six data methods', async () => {
    const { storage, collection } = unit()
    await storage.write('a', bytes('x'))
    await storage.read('a')
    await storage.delete('a')
    await storage.list('')
    await storage.search('a')
    await storage.deletePrefix('')
    expect(new Set(collection.namesCalled)).toEqual(
      new Set(['replaceOne', 'findOne', 'deleteOne', 'find', 'aggregate', 'deleteMany']),
    )
    expect(lifecycle.ensure).not.toHaveBeenCalled()
  })
})

/** Every key operation, as `[name, call]`, which the collation check must cover. */
const KEY_OPERATIONS: Array<[string, (storage: MongoDBStorage) => Promise<unknown>]> = [
  ['write', (storage) => storage.write('k', bytes('x'))],
  ['read', (storage) => storage.read('k')],
  ['delete', (storage) => storage.delete('k')],
  ['list', (storage) => storage.list('')],
  ['search', (storage) => storage.search('q')],
  ['deletePrefix', (storage) => storage.deletePrefix('')],
  ['ensureIndexes', (storage) => storage.ensureIndexes()],
]

describe('TS-077 — a key space needs a collection that compares bytes', () => {
  const folded = (): Unit => unit({}, {}, new FakeStorageDatabase({ collation: CASE_INSENSITIVE }))

  it('TS-077 — the operations checked are every async method but close', () => {
    const asyncMethods = Object.getOwnPropertyNames(MongoDBStorage.prototype).filter(
      (name) =>
        (Object.getOwnPropertyDescriptor(MongoDBStorage.prototype, name)?.value as unknown)?.constructor?.name ===
        'AsyncFunction',
    )
    expect(new Set(asyncMethods)).toEqual(new Set([...KEY_OPERATIONS.map(([name]) => name), 'close']))
  })

  it.each(KEY_OPERATIONS)('TS-077 — %s refuses a case-folding collection before any call', async (_name, call) => {
    const { storage, collection } = folded()
    expect(await rejection(call(storage))).toBeInstanceOf(StorageError)
    expect(collection.calls).toEqual([])
  })

  it.each([
    ['no collation', new FakeStorageDatabase()],
    ['the simple locale', new FakeStorageDatabase({ collation: { locale: 'simple' } })],
    ['an absent collection', new FakeStorageDatabase({ absent: true })],
  ])('TS-077 — %s is accepted', async (_label, database) => {
    const { storage } = unit({}, {}, database)
    await storage.write('k', bytes('x'))
    expect(await storage.read('k')).toEqual(bytes('x'))
  })

  it('TS-077 — a verified collection is asked once, filtered to its own name', async () => {
    const { storage, database } = unit()
    for (const [, call] of KEY_OPERATIONS) await call(storage)
    expect(database.listCollectionsFilters).toEqual([{ name: 'storage' }])
  })

  it('TS-077 — the cache is on the connection, so a namespace does not ask again', async () => {
    const { storage, database } = unit()
    await storage.read('k')
    await storage.namespace('tenant-a').read('k')
    expect(database.listCollectionsCalls).toBe(1)
  })

  it('TS-077 — the message names the namespace, the locale and the remedy', async () => {
    const error = await rejection(folded().storage.read('k'))
    expect(error.message).toContain('appdb.storage')
    expect(error.message).toContain("'en'")
    expect(error.message).toContain('simple')
    expect(error.message).toContain('cannot be changed')
  })

  it('TS-077 — close still works after a refusal', async () => {
    const { storage } = folded()
    await rejection(storage.read('k'))
    await storage.close()
    expect(REGISTRY.size).toBe(0)
  })
})

describe('TS-078 — an absent collection is not a verified one', () => {
  it('TS-078 — two reads of an absent collection ask twice', async () => {
    const { storage, database } = unit({}, {}, new FakeStorageDatabase({ absent: true }))
    await storage.read('k')
    await storage.read('k')
    expect(database.listCollectionsCalls).toBe(2)
  })

  it('TS-078 — a collection created case-folded after an absent read is refused on the next operation', async () => {
    const { storage, database } = unit({}, {}, new FakeStorageDatabase({ absent: true }))
    await storage.read('k')
    database.absent = false
    database.collation = CASE_INSENSITIVE
    expect((await rejection(storage.read('k'))).message).toContain("'en'")
  })

  it('TS-078 — a collection that exists is still cached', async () => {
    const { storage, database } = unit()
    await storage.read('k')
    await storage.read('k')
    expect(database.listCollectionsCalls).toBe(1)
  })

  it("TS-078 — the re-reading stops once the store's first write has created the collection", async () => {
    const { storage, database } = unit({}, {}, new FakeStorageDatabase({ absent: true }))
    await storage.read('k')
    await storage.write('k', bytes('x'))
    database.absent = false
    await storage.read('k')
    await storage.read('k')
    expect(database.listCollectionsCalls).toBe(3)
  })
})

describe('TS-079 — every storage operation records one span', () => {
  it('TS-079 — each operation is one internal span on its namespace', async () => {
    const spans = exportedSpans()
    const { storage, collection } = unit({ collection: 'sessions' })
    collection.aggregateResult = [{ _id: 'notes/a', score: 2 }]

    await storage.write('notes/a', bytes('x'))
    await storage.read('notes/a')
    await storage.list('notes/')
    await storage.search('dark mode')
    await storage.delete('notes/a')
    await storage.deletePrefix('notes/')
    await storage.ensureIndexes()

    const found = spans.getFinishedSpans().filter((span) => span.name.startsWith('strands_mongodb.storage.'))
    expect(found.map((span) => span.name)).toEqual(
      ['write', 'read', 'list', 'search', 'delete', 'delete_prefix', 'ensure_indexes'].map(
        (op) => `strands_mongodb.storage.${op}`,
      ),
    )
    for (const span of found) {
      expect(span.kind).toBe(SpanKind.INTERNAL)
      expect(span.attributes['strands_mongodb.database']).toBe('appdb')
      expect(span.attributes['strands_mongodb.collection']).toBe('sessions')
      expect(Object.keys(span.attributes).filter((key) => key.startsWith('db.'))).toEqual([])
    }
  })

  it('TS-079 — each outcome is a count or a flag', async () => {
    const spans = exportedSpans()
    const { storage, collection } = unit()
    collection.aggregateResult = [{ _id: 'notes/a', score: 2 }]
    await storage.write('notes/a', bytes('x'))
    await storage.write('notes/b', bytes('y'))

    await storage.read('notes/a')
    await storage.read('notes/missing')
    await storage.list('notes/')
    await storage.search('dark mode')
    await storage.delete('notes/a')
    await storage.deletePrefix('notes/')

    const attribute = (name: string, key: string): unknown[] => named(spans, name).map((span) => span.attributes[key])
    expect(attribute('strands_mongodb.storage.read', 'strands_mongodb.found')).toEqual([true, false])
    expect(attribute('strands_mongodb.storage.list', 'strands_mongodb.result_count')).toEqual([2])
    expect(attribute('strands_mongodb.storage.search', 'strands_mongodb.result_count')).toEqual([1])
    expect(attribute('strands_mongodb.storage.delete', 'strands_mongodb.deleted_count')).toEqual([1])
    expect(attribute('strands_mongodb.storage.delete_prefix', 'strands_mongodb.deleted_count')).toEqual([1])
  })

  it('TS-079 — a driver failure is recorded as the error the caller sees, without the key', async () => {
    const spans = exportedSpans()
    const { storage, collection } = unit()
    collection.error = networkError()
    await rejection(storage.read('notes/a'))
    const span = one(spans, 'strands_mongodb.storage.read')
    expect(span.status.message).toBe('StorageError')
    expect(rendered(span)).not.toContain('notes/a')
  })
})

describe('TS-080 — construction', () => {
  it('TS-080 — a negative TTL is refused, and nothing is registered', () => {
    const database = new FakeStorageDatabase()
    expect(() => new MongoDBStorage({ database: 'appdb', client: database.client }, { ttlSeconds: -1 })).toThrow(
      RangeError,
    )
    expect(REGISTRY.size).toBe(0)
  })

  it('TS-080 — a TTL of zero is accepted: expire at the next sweep', () => {
    expect(unit({ ttlSeconds: 0 }).storage.ttlSeconds).toBe(0)
  })

  it('TS-080 — the collection defaults to storage, and the database is the config one', () => {
    const { storage } = unit()
    expect(storage.collectionName).toBe(DEFAULT_STORAGE_COLLECTION)
    expect(storage.databaseName).toBe('appdb')
  })

  it('TS-080 — a config naming no connection is refused at construction', () => {
    expect(() => new MongoDBStorage({ database: 'appdb' })).toThrow(TypeError)
  })

  it('TS-080 — a prefix with a traversal is refused at construction', () => {
    expect(() => unit({ prefix: 'a/../b' })).toThrow(StorageError)
  })

  it('TS-080 — close releases the registry entry and leaves an injected client open', async () => {
    const { storage, database } = unit()
    const closing = vi.spyOn(database.client, 'close')
    await storage.close()
    expect(REGISTRY.size).toBe(0)
    expect(closing).not.toHaveBeenCalled()
  })

  it('TS-080 — await using closes the store', async () => {
    const database = new FakeStorageDatabase()
    {
      await using storage = new MongoDBStorage({ database: 'appdb', client: database.client })
      expect(storage).toBeInstanceOf(MongoDBStorage)
      expect(REGISTRY.size).toBe(1)
    }
    expect(REGISTRY.size).toBe(0)
  })

  it('TS-080 — the connection gains a set for verified collections', () => {
    const database = new FakeStorageDatabase()
    expect(resolve({ database: 'appdb', client: database.client }, 'MongoDBStorage').binaryKeys).toEqual(new Set())
  })
})

describe('TS-081 — the fake matches the driver', () => {
  const methodOf = (prototype: object, name: string): unknown => (prototype as Record<string, unknown>)[name]

  it('TS-081 — every collection method the store calls exists on the real class', () => {
    for (const name of [
      'replaceOne',
      'updateOne',
      'findOne',
      'deleteOne',
      'deleteMany',
      'find',
      'aggregate',
      'indexInformation',
      'createIndexes',
    ]) {
      expect(typeof methodOf(Collection.prototype, name), name).toBe('function')
      expect(typeof methodOf(FakeStorageCollection.prototype, name), name).toBe('function')
    }
    expect(typeof methodOf(Db.prototype, 'listCollections')).toBe('function')
    expect(typeof methodOf(FakeStorageDatabase.prototype, 'listCollections')).toBe('function')
  })

  it('TS-081 — find, aggregate and listCollections return cursors synchronously, and sort returns the cursor', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:1/')
    try {
      const db = client.db('d')
      const found = db.collection('c').find({}, { projection: { _id: 1 } })
      expect(found).toBeInstanceOf(FindCursor)
      expect(found.sort({ _id: 1 })).toBe(found)
      expect(typeof found[Symbol.asyncIterator]).toBe('function')
      expect(db.collection('c').aggregate([])).toBeInstanceOf(AggregationCursor)
      const listed = db.listCollections({ name: 'c' })
      expect(listed).not.toBeInstanceOf(Promise)
      expect(typeof listed[Symbol.asyncIterator]).toBe('function')
      await Promise.all([found.close(), listed.close()])
    } finally {
      await client.close()
    }
  })

  it('TS-081 — the fake cursors behave the same way', () => {
    const collection = new FakeStorageCollection('c', 'd')
    const cursor = collection.find({})
    expect(cursor.sort({ _id: 1 })).toBe(cursor)
    expect(typeof cursor[Symbol.asyncIterator]).toBe('function')
    expect(collection.aggregate([])).not.toBeInstanceOf(Promise)
    expect(new FakeStorageDatabase().listCollections({ name: 'c' })).not.toBeInstanceOf(Promise)
  })

  it('TS-081 — both collections name their database and themselves', () => {
    expect(Object.getOwnPropertyDescriptor(Collection.prototype, 'dbName')?.get).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(Collection.prototype, 'collectionName')?.get).toBeDefined()
    const fake = new FakeStorageDatabase().collection('storage')
    expect([fake.dbName, fake.collectionName]).toEqual(['appdb', 'storage'])
  })

  it('TS-081 — the delete result carries the count deletePrefix reads', async () => {
    expect(await new FakeStorageCollection('c', 'd').deleteMany({})).toHaveProperty('deletedCount', 0)
  })
})
