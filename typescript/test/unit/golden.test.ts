/**
 * The golden vectors: what the Python package computes for fixed inputs, which the TypeScript code must match.
 *
 * `test/fixtures/golden.json` is produced by `scripts/golden.py`, run by hand against the Python package. A TS
 * store and a Python store pointed at one collection must agree on every `_id` and every range they scan, so a
 * difference here is a split between the two packages, not a style question.
 */
import { readFileSync } from 'node:fs'

import { StorageError } from '@strands-agents/sdk'
import { BSON, MongoClient, ObjectId } from 'mongodb'
import type { Document } from 'mongodb'
import { describe, expect, it } from 'vitest'

import {
  abbreviate,
  encodedSize,
  idFor,
  instancePrefix,
  normalizeKey,
  normalizePrefix,
  rangeFor,
  successor,
} from '../../src/keys.js'
import type { VectorMode } from '../../src/indexes.js'
import { memoryInternals, MongoDBMemoryStore } from '../../src/memory-store.js'
import { hybridStages, textStages, vectorStages } from '../../src/pipeline.js'
import { tokenize } from '../../src/tokenize.js'

/** A computed value, or the error Python raised instead. */
type Outcome<T> = { value: T } | { error: string; type: string }

interface Golden {
  normalizeKey: (Outcome<string> & { input: string })[]
  normalizePrefix: (Outcome<string> & { input: string })[]
  idFor: (Outcome<string> & { prefix: string; key: string; instancePrefix: string })[]
  rangeFor: (Outcome<object> & { prefix: string; query: string })[]
  successor: { input: string; value: string | null }[]
  abbreviate: { input: string; value: string }[]
  encodedSize: { id: string; dataLength: number; expires: boolean; value: number }[]
  tokenize: { input: string; value: string[] }[]
  pipelines: { name: string; value: unknown[] }[]
  contentHash: { input: string; value: string }[]
  memoryAdd: MemoryAdd[]
}

/** One `add`, and the upsert Python's `add` sent for it. */
interface MemoryAdd {
  name: string
  content: string
  scope?: string
  metadata?: Record<string, BSON.Document>
  ttlSeconds?: number
  embedder?: boolean
  /** Canonical extended JSON, which names every BSON type. */
  selector: Document
  operator: string
  keys: string[]
  /** The inserted fields, less `created_at` and `expires_at`, which hold the clock. */
  inserted: Document
  createdAt: string
  expiresAfterMs: number | null
}

const golden = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8')) as Golden

/** The `database.collection` `scripts/golden.py` builds its storage instances on. */
const TARGET = 'agents.storage'

/**
 * Python's messages open with the package name, and this package's open with the class name (design §5.4).
 * Everything after the opening is the same sentence, so that much is compared.
 */
function asTypeScript(message: string): string {
  return message.replace(/^strands_mongodb: /, 'MongoDBStorage: ')
}

/** Assert `run` matches a Python outcome: the same value, or a `StorageError` with the same message. */
function expectOutcome<T>(run: () => T, expected: Outcome<T>): void {
  if ('value' in expected) {
    expect(run()).toEqual(expected.value)
    return
  }
  expect(expected.type).toBe('StorageError')
  expect(run).toThrow(StorageError)
  expect(run).toThrow(asTypeScript(expected.error))
}

/** Compare by code point, which is how Python's `sorted` orders the tokens it wrote. */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

describe('TS-013 — key handling matches the Python package', () => {
  it.each(golden.normalizeKey)('TS-013 — normalizeKey($input)', ({ input, ...expected }) => {
    expectOutcome(() => normalizeKey(input), expected)
  })

  it.each(golden.normalizePrefix)('TS-013 — normalizePrefix($input)', ({ input, ...expected }) => {
    expectOutcome(() => normalizePrefix(input), expected)
  })

  it.each(golden.idFor)('TS-013 — the _id of $key under the prefix $prefix', ({ prefix, key, ...rest }) => {
    const { instancePrefix: joined, ...expected } = rest

    expect(instancePrefix(prefix)).toBe(joined)
    expectOutcome(() => idFor(joined, key, TARGET), expected)
  })

  it.each(golden.rangeFor)('TS-013 — the range scanned for $query under the prefix $prefix', (vector) => {
    const { prefix, query, ...expected } = vector

    expectOutcome(() => rangeFor(instancePrefix(prefix), query), expected)
  })

  it.each(golden.successor)('TS-013 — successor($input)', ({ input, value }) => {
    expect(successor(input)).toBe(value)
  })

  it.each(golden.abbreviate)('TS-013 — abbreviate($input)', ({ input, value }) => {
    expect(abbreviate(input)).toBe(value)
  })

  it.each(golden.encodedSize)('TS-013 — encodedSize($id, $dataLength, $expires)', (vector) => {
    expect(encodedSize(vector.id, vector.dataLength, vector.expires)).toBe(vector.value)
  })
})

describe('TS-013 — the tokenizer matches the Python SDK', () => {
  it.each(golden.tokenize)('TS-013 — tokenize($input)', ({ input, value }) => {
    expect([...tokenize(input)].sort(byCodePoint)).toEqual(value)
  })
})

const AUTO_EMBED: VectorMode = { autoEmbed: true, model: 'voyage-4' }
const MANUAL: VectorMode = { autoEmbed: false, dimensions: 4, similarity: 'cosine' }
const FILTER = { $and: [{ scope: 's' }, { 'metadata.tier': 'gold' }] }
const QUERY_VECTOR = [1, 0.5, 0, 0]

/** The TypeScript call for each case `scripts/golden.py` writes under `pipelines`, keyed by its name. */
const PIPELINES = new Map<string, () => unknown[]>([
  ['vector, autoEmbed', () => vectorStages({ mode: AUTO_EMBED, indexName: 'v', limit: 5, queryText: 'dark mode' })],
  [
    'vector, autoEmbed, filtered',
    () =>
      vectorStages({
        mode: AUTO_EMBED,
        indexName: 'v',
        limit: 5,
        queryText: 'dark mode',
        queryFilter: FILTER,
        oversamplingFactor: 3,
      }),
  ],
  ['vector, manual', () => vectorStages({ mode: MANUAL, indexName: 'v', limit: 5, queryVector: QUERY_VECTOR })],
  [
    'vector, manual, filtered, unscored',
    () =>
      vectorStages({
        mode: MANUAL,
        indexName: 'v',
        limit: 5,
        queryVector: QUERY_VECTOR,
        queryFilter: FILTER,
        score: false,
      }),
  ],
  ['text', () => textStages({ queryText: 'dark mode', indexName: 't', limit: 5 })],
  ['text, filtered', () => textStages({ queryText: 'dark mode', indexName: 't', limit: 5, queryFilter: FILTER })],
  [
    'text, filtered, unscored',
    () => textStages({ queryText: 'dark mode', indexName: 't', limit: 5, queryFilter: FILTER, score: false }),
  ],
  [
    'hybrid, autoEmbed, filtered',
    () =>
      hybridStages({
        mode: AUTO_EMBED,
        vectorIndexName: 'v',
        textIndexName: 't',
        queryText: 'dark mode',
        limit: 5,
        queryFilter: FILTER,
      }),
  ],
  [
    'hybrid, manual',
    () =>
      hybridStages({
        mode: MANUAL,
        vectorIndexName: 'v',
        textIndexName: 't',
        queryText: 'dark mode',
        queryVector: QUERY_VECTOR,
        limit: 5,
        oversamplingFactor: 2,
      }),
  ],
])

describe('TS-013 — the search pipelines match the Python package, key order included', () => {
  // The server reads a stage's keys in order only where it must, but a byte-identical pipeline is what lets a
  // query logged by one package be compared with the other's, so the serialized form is what is asserted.
  it.each(golden.pipelines)('TS-013 — the $name pipeline', ({ name, value }) => {
    const build = PIPELINES.get(name)
    expect(build, `no TypeScript case for ${name}`).toBeDefined()
    expect(JSON.stringify(build?.())).toBe(JSON.stringify(value))
  })

  it('TS-013 — every TypeScript case has a Python vector', () => {
    expect([...PIPELINES.keys()].sort()).toEqual(golden.pipelines.map(({ name }) => name).sort())
  })
})

/** The bag-of-words embedder `scripts/golden.py` uses. */
const wordEmbedder = {
  async embed(text: string): Promise<number[]> {
    const words = text.toLowerCase().split(/\s+/)
    return ['dark', 'mode', 'coffee', 'tea'].map((word) => 0.01 + words.filter((found) => found === word).length)
  },
}

/** The one upsert the TypeScript `add` sends for `vector`, through a client that records it. */
async function upsertFor(vector: MemoryAdd): Promise<[Document, Document]> {
  const upserts: [Document, Document][] = []
  const collection = {
    async updateOne(selector: Document, update: Document): Promise<Document> {
      upserts.push([selector, update])
      return { upsertedId: new ObjectId() }
    },
  }
  const client = { options: {}, appendMetadata: () => undefined, db: () => ({ collection: () => collection }) }
  const store = new MongoDBMemoryStore({
    name: 'facts',
    writable: true,
    ...(vector.scope === undefined ? {} : { scope: vector.scope }),
    ...(vector.ttlSeconds === undefined ? {} : { ttlSeconds: vector.ttlSeconds }),
    ...(vector.embedder === true ? { embedder: wordEmbedder } : {}),
    config: {
      database: 'agents',
      client: client as unknown as MongoClient,
      ...(vector.embedder === true ? { embeddingDimensions: 4, similarity: 'cosine' as const } : {}),
    },
  })
  memoryInternals.prepare(store, [])
  await store.add(vector.content, vector.metadata)
  expect(upserts).toHaveLength(1)
  return upserts[0] as [Document, Document]
}

/** `value` as canonical extended JSON, as `scripts/golden.py` writes it. */
const canonical = (value: Document): Document => BSON.EJSON.serialize(value, { relaxed: false })

describe('TS-013 — the memory document matches the Python package, BSON types included', () => {
  it.each(golden.contentHash)('TS-013 — content_hash, case $#', ({ input, value }) => {
    expect(memoryInternals.contentHash(input)).toBe(value)
  })

  it.each(golden.memoryAdd)('TS-013 — the upsert for the $name case', async (vector) => {
    const [selector, update] = await upsertFor(vector)

    expect(canonical(selector)).toEqual(vector.selector)
    expect(Object.keys(update)).toEqual([vector.operator])
    const inserted = { ...(update[vector.operator] as Document) }
    expect(Object.keys(inserted)).toEqual(vector.keys)
    const createdAt = inserted.created_at as Date
    const expiresAt = inserted.expires_at as Date | undefined
    delete inserted.created_at
    delete inserted.expires_at
    expect(canonical(inserted)).toEqual(vector.inserted)
    expect(Object.keys(canonical({ createdAt }).createdAt as Document)).toEqual([vector.createdAt])
    expect(expiresAt === undefined ? null : expiresAt.getTime() - createdAt.getTime()).toBe(vector.expiresAfterMs)
  })
})

describe('TS-013 — the golden file covers what it claims to', () => {
  it('TS-013 — every section has vectors, and both a rejection and an accepted key are present', () => {
    for (const section of Object.values(golden).filter(Array.isArray)) expect(section.length).toBeGreaterThan(0)

    expect(golden.idFor.some((vector) => 'error' in vector)).toBe(true)
    expect(golden.idFor.some((vector) => 'value' in vector)).toBe(true)
    expect(golden.normalizeKey.some((vector) => 'error' in vector)).toBe(true)
  })
})
