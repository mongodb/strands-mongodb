/**
 * `MongoDBVectorSearchStrategy` against the storage fake: what the strategy sends.
 *
 * Ports the unit classes of `python/tests/test_vector_search.py`. What a deployment with `mongot` does with it,
 * the prefix pre-filter and the score, is `test/integration/vector-search.test.ts`.
 *
 * None of Python's ids here is a checklist item, so each leads with a `TS-` id: AT-237 is TS-090, AT-238
 * TS-091, AT-239 TS-092 and AT-240 TS-093. Two have no Python counterpart: `remove`, which only the TypeScript
 * strategy has, is TS-095, and the vector's components going over the wire as BSON doubles, which Python's
 * `float()` guarantees and a JavaScript number does not, is TS-096. The integration tier is TS-094.
 */
import { StorageError } from '@strands-agents/sdk'
import type { SearchStrategy, StorageSearchResult } from '@strands-agents/sdk/storage/search'
import { Binary, BSON, Double } from 'mongodb'
import type { Document } from 'mongodb'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { REGISTRY } from '../../src/client.js'
import * as publicSurface from '../../src/index.js'
import * as lifecycle from '../../src/index-lifecycle.js'
import { SearchIndexSpec } from '../../src/indexes.js'
import { MongoDBStorage } from '../../src/storage.js'
import type { MongoDBStorageOptions } from '../../src/types.js'
import { DEFAULT_STORAGE_COLLECTION, DEFAULT_VECTOR_INDEX_NAME, MAX_DIMENSIONS } from '../../src/types.js'
import {
  ancestors,
  DEFAULT_STORAGE_VECTOR_INDEX_NAME,
  MongoDBVectorSearchStrategy,
  type MongoDBVectorSearchStrategyOptions,
} from '../../src/vector-search.js'
import { FakeStorageCollection, FakeStorageDatabase } from '../support/fake-storage.js'

// `ensure` is replaced by a recorder, so TS-093 can read the specs it was handed without a fake of the
// search-index calls. Everything else in the module is the real code, the collation check included.
vi.mock('../../src/index-lifecycle.js', async (original) => {
  const actual = await original<typeof import('../../src/index-lifecycle.js')>()
  return { ...actual, ensure: vi.fn(async () => {}) }
})

const VOCABULARY = ['dark', 'mode', 'coffee', 'tea'] as const

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The vector as the strategy sends it: every component a BSON double. */
const doubles = (...values: number[]): Double[] => values.map((value) => new Double(value))

/** A deterministic embedder: one dimension per word in {@link VOCABULARY}, plus a floor so no vector is zero. */
class BagOfWordsEmbedder {
  readonly calls: string[] = []

  constructor(readonly dimensions: number = VOCABULARY.length) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text)
    const words = text.toLowerCase().split(/\s+/)
    const vector = VOCABULARY.map((word) => 0.01 + words.filter((found) => found === word).length)
    return [...vector, ...Array<number>(this.dimensions).fill(0.01)].slice(0, this.dimensions)
  }
}

/** A strategy over {@link BagOfWordsEmbedder}, with any option overridden. */
function strategy(
  embedder: { embed(text: string): Promise<number[]> } = new BagOfWordsEmbedder(),
  overrides: Partial<MongoDBVectorSearchStrategyOptions> = {},
): MongoDBVectorSearchStrategy {
  return new MongoDBVectorSearchStrategy({
    embedder,
    dimensions: VOCABULARY.length,
    similarity: 'cosine',
    ...overrides,
  })
}

/** A store over a fresh fake, and that fake's collection. */
function unit(options: MongoDBStorageOptions = {}): { storage: MongoDBStorage; collection: FakeStorageCollection } {
  const database = new FakeStorageDatabase()
  const storage = new MongoDBStorage({ database: database.databaseName, client: database.client }, options)
  return { storage, collection: database.collection(options.collection ?? DEFAULT_STORAGE_COLLECTION) }
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

beforeEach(() => {
  REGISTRY.clear()
  vi.mocked(lifecycle.ensure).mockClear()
})

/**
 * AT-237's cases: an option, and what the message must say. A named table because the gate's static scan reads
 * an `it.each` title only when the call's argument has no parentheses in it.
 */
const OUT_OF_RANGE: ReadonlyArray<[string, Partial<MongoDBVectorSearchStrategyOptions>, string]> = [
  ['no dimensions', { dimensions: 0 }, "'dimensions' is 0"],
  ['too many dimensions', { dimensions: MAX_DIMENSIONS + 1 }, "'dimensions'"],
  ['fractional dimensions', { dimensions: 1.5 }, "'dimensions' is 1.5"],
  ['an unknown similarity', { similarity: 'manhattan' as never }, "'similarity' is 'manhattan'"],
  ['no results', { maxResults: 0 }, "'maxResults'"],
  ['no oversampling', { oversamplingFactor: 0 }, "'oversamplingFactor'"],
  ['too many candidates', { maxResults: 101, oversamplingFactor: 100 }, 'numCandidates would be 10100'],
]

describe('TS-090 — every bound the server would enforce later is enforced at construction', () => {
  it.each(OUT_OF_RANGE)('TS-090 — %s throws a RangeError', (_, overrides, message) => {
    expect(() => strategy(undefined, overrides)).toThrow(RangeError)
    expect(() => strategy(undefined, overrides)).toThrow(message)
  })

  it('TS-090 — the message names the class, as the SDK stores do', () => {
    expect(() => strategy(undefined, { dimensions: 0 })).toThrow(/^MongoDBVectorSearchStrategy: /)
  })

  it('TS-090 — the index spec declares the vector and the prefix filter', () => {
    const spec = strategy(undefined, { dimensions: 4, similarity: 'euclidean', indexName: 'v' }).indexSpec()

    expect(spec).toBeInstanceOf(SearchIndexSpec)
    expect(spec.name).toBe('v')
    expect(spec.type).toBe('vectorSearch')
    expect(spec.definition).toEqual({
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 4, similarity: 'euclidean' },
        { type: 'filter', path: 'prefixes' },
      ],
    })
  })

  it("TS-090 — the default index name differs from the memory store's", () => {
    expect(strategy().indexSpec().name).toBe(DEFAULT_STORAGE_VECTOR_INDEX_NAME)
    expect(DEFAULT_STORAGE_VECTOR_INDEX_NAME).toBe('storage_vector_index')
    expect(DEFAULT_STORAGE_VECTOR_INDEX_NAME).not.toBe(DEFAULT_VECTOR_INDEX_NAME)
  })

  it('TS-090 — the entry point exports the strategy and its default index name', () => {
    expect(publicSurface).toMatchObject({ MongoDBVectorSearchStrategy, DEFAULT_STORAGE_VECTOR_INDEX_NAME })
  })

  it('TS-090 — it is a SearchStrategy over MongoDBStorage, and any object with embed is an embedder', () => {
    expectTypeOf<MongoDBVectorSearchStrategy>().toExtend<SearchStrategy<MongoDBStorage>>()
    const typed: SearchStrategy<MongoDBStorage> = strategy({ embed: async (text) => [text.length, 0, 0, 0] })
    expect(typed.index).toBeTypeOf('function')
  })
})

/** Values that are stored but never embedded: empty, and not UTF-8. */
const UNEMBEDDABLE: ReadonlyArray<[string, Uint8Array]> = [
  ['an empty value', new Uint8Array()],
  ['a value that is not UTF-8', Uint8Array.of(0xff, 0xfe)],
]

describe('TS-091 — write stores the vector on the document it just replaced', () => {
  it('TS-091 — a write sets the vector and every ancestor prefix', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a', searchStrategy: strategy() })

    await storage.write('notes/dark.md', bytes('dark mode'))

    expect(collection.namesCalled).toEqual(['replaceOne', 'updateOne'])
    const [, [filter, update]] = collection.calls.at(-1) as [string, [Document, Document]]
    expect(filter).toEqual({ _id: 'tenant-a/notes/dark.md', data: bytes('dark mode') })
    expect(update).toEqual({
      $set: { embedding: doubles(1.01, 1.01, 0.01, 0.01), prefixes: ['tenant-a/', 'tenant-a/notes/'] },
    })
  })

  it('TS-091 — a slower write does not put its vector on a newer value', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    class SlowForDark extends BagOfWordsEmbedder {
      override async embed(text: string): Promise<number[]> {
        const vector = super.embed(text)
        if (text === 'dark') await gate
        return vector
      }
    }
    const embedder = new SlowForDark()
    const { storage, collection } = unit({ searchStrategy: strategy(embedder) })

    const slow = storage.write('k', bytes('dark'))
    await vi.waitFor(() => expect(embedder.calls).toContain('dark'))
    await storage.write('k', bytes('tea'))
    release()
    await slow

    expect(collection.documents.get('k')?.data).toEqual(bytes('tea'))
    expect(collection.documents.get('k')?.embedding).toEqual(
      (await new BagOfWordsEmbedder().embed('tea')).map((value) => new Double(value)),
    )
  })

  it.each(UNEMBEDDABLE)('TS-091 — %s is stored but not embedded', async (_, data) => {
    const embedder = new BagOfWordsEmbedder()
    const { storage, collection } = unit({ searchStrategy: strategy(embedder) })

    await storage.write('k', data)

    expect(collection.namesCalled).toEqual(['replaceOne'])
    expect(embedder.calls).toEqual([])
    expect(collection.documents.get('k')?.data).toEqual(data)
  })

  it('TS-091 — a leading byte-order mark is kept, as Python decodes it', async () => {
    const embedder = new BagOfWordsEmbedder()
    const { storage } = unit({ searchStrategy: strategy(embedder) })

    await storage.write('k', Uint8Array.of(0xef, 0xbb, 0xbf, ...bytes('tea')))

    expect(embedder.calls).toEqual(['﻿tea'])
  })

  it('TS-091 — a vector of the wrong length fails the write after storing the value', async () => {
    const { storage, collection } = unit({ searchStrategy: strategy(new BagOfWordsEmbedder(3)) })

    const error = await rejection(storage.write('k', bytes('dark')))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('3-dimension vector')
    expect(error.cause).toBeInstanceOf(RangeError)
    expect(collection.documents.get('k')?.data).toEqual(bytes('dark'))
    expect(collection.namesCalled).not.toContain('updateOne')
  })

  it.each([
    ['k', []],
    ['a/k', ['a/']],
    ['a/b/c', ['a/', 'a/b/']],
  ])('TS-091 — the ancestors of %s are every slash-terminated prefix', (id, expected) => {
    expect(ancestors(id)).toEqual(expected)
  })
})

describe("TS-092 — one $vectorSearch aggregation, pre-filtered to the storage's prefix", () => {
  it('TS-092 — an unprefixed store sends no filter', async () => {
    const { storage, collection } = unit({
      searchStrategy: strategy(undefined, { maxResults: 3, oversamplingFactor: 5 }),
    })
    collection.aggregateResult = [{ _id: 'notes/a', data: new Binary(bytes('dark')), score: 0.9 }]

    const found = await storage.search('dark')

    expect(collection.pipelines).toEqual([
      [
        {
          $vectorSearch: {
            index: DEFAULT_STORAGE_VECTOR_INDEX_NAME,
            path: 'embedding',
            queryVector: doubles(1.01, 0.01, 0.01, 0.01),
            numCandidates: 15,
            limit: 3,
          },
        },
        { $project: { data: 1, score: { $meta: 'vectorSearchScore' } } },
      ],
    ])
    expect(found).toEqual([{ key: 'notes/a', score: 0.9, data: bytes('dark') } satisfies StorageSearchResult])
    // A plain `Uint8Array`, not the driver's `Buffer` view, as `read` returns.
    expect(found[0]?.data?.constructor).toBe(Uint8Array)
  })

  it('TS-092 — a prefixed store filters on its prefix and strips it', async () => {
    const { storage, collection } = unit({ prefix: 'tenant-a', searchStrategy: strategy() })
    collection.aggregateResult = [{ _id: 'tenant-a/notes/a', data: new Binary(bytes('x')), score: 1 }]

    const found = await storage.search('dark')

    expect((collection.pipelines[0]?.[0] as Document).$vectorSearch.filter).toEqual({
      prefixes: { $eq: 'tenant-a/' },
    })
    expect(found.map((result) => [result.key, typeof result.score])).toEqual([['notes/a', 'number']])
  })

  it('TS-092 — a result with no score scores 0', async () => {
    const { storage, collection } = unit({ searchStrategy: strategy() })
    collection.aggregateResult = [{ _id: 'a', data: new Binary(bytes('x')) }]

    expect((await storage.search('dark'))[0]?.score).toBe(0)
  })

  it.each(['', '   '])('TS-092 — the blank query %j embeds nothing and sends nothing', async (query) => {
    const embedder = new BagOfWordsEmbedder()
    const { storage, collection } = unit({ searchStrategy: strategy(embedder) })

    expect(await storage.search(query)).toEqual([])
    expect(embedder.calls).toEqual([])
    expect(collection.calls).toEqual([])
  })

  it('TS-092 — a query vector of the wrong length fails before anything is sent', async () => {
    const { storage, collection } = unit({ searchStrategy: strategy(new BagOfWordsEmbedder(3)) })

    const error = await rejection(storage.search('dark'))

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain("the embedder returned a 3-dimension vector and 'dimensions' is 4")
    expect(collection.calls).toEqual([])
  })
})

describe('TS-093 — ensureIndexes provisions the strategy’s vector index alongside the ordinary ones', () => {
  const searchSpecs = (): unknown[] =>
    vi.mocked(lifecycle.ensure).mock.calls.map(([, , options]) => (options as { search: unknown }).search)

  it('TS-093 — the vector index is passed to ensure', async () => {
    const configured = strategy(undefined, { indexName: 'v' })

    await unit({ searchStrategy: configured }).storage.ensureIndexes()
    await unit().storage.ensureIndexes()

    expect(searchSpecs()).toEqual([[configured.indexSpec()], []])
  })

  it('TS-093 — any strategy with an index spec gets its index', async () => {
    const spec = new SearchIndexSpec('text', { mappings: { dynamic: true } }, 'search')
    const textStrategy = { indexSpec: () => spec, search: async () => [] }

    await unit({ searchStrategy: textStrategy }).storage.ensureIndexes()

    expect(searchSpecs()).toEqual([[spec]])
  })
})

describe('TS-095 — remove exists, as on the SDK’s S3VectorSearchStrategy, and does nothing', () => {
  it('TS-095 — remove sends nothing, and delete takes the vector with the document', async () => {
    const configured = strategy()
    const { storage, collection } = unit({ searchStrategy: configured })
    await storage.write('k', bytes('tea'))
    collection.calls.length = 0

    await expect(configured.remove(storage, 'k')).resolves.toBeUndefined()
    expect(collection.calls).toEqual([])

    await storage.delete('k')
    expect(collection.documents.has('k')).toBe(false)
  })
})

describe("TS-096 — every vector component is a BSON double, as Python's float() makes it", () => {
  const integral = { embed: async () => [1, 0, 2, 3] }

  it('TS-096 — an integer-valued component is stored as a double, not an int32', async () => {
    const { storage, collection } = unit({ searchStrategy: strategy(integral) })

    await storage.write('k', bytes('tea'))

    // Read from the call, not the fake's copy, which `structuredClone` has stripped of its class.
    const [, [, update]] = collection.calls.at(-1) as [string, [Document, Document]]
    const embedding = update.$set.embedding as unknown[]
    expect(embedding).toEqual(doubles(1, 0, 2, 3))
    expect(embedding.every((value) => value instanceof Double)).toBe(true)
    // The bytes on the wire: element type 0x01, a double, where a plain `1` would be 0x10, an int32.
    expect(BSON.serialize({ v: embedding })[11]).toBe(0x01)
  })

  it('TS-096 — the query vector is sent as doubles too', async () => {
    const { storage, collection } = unit({ searchStrategy: strategy(integral) })

    await storage.search('tea')

    const sent = (collection.pipelines[0]?.[0] as Document).$vectorSearch.queryVector as unknown[]
    expect(sent.every((value) => value instanceof Double)).toBe(true)
  })
})
