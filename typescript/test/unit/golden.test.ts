/**
 * The golden vectors: what the Python package computes for fixed inputs, which the TypeScript code must match.
 *
 * `test/fixtures/golden.json` is produced by `scripts/golden.py`, run by hand against the Python package. A TS
 * store and a Python store pointed at one collection must agree on every `_id` and every range they scan, so a
 * difference here is a split between the two packages, not a style question.
 */
import { readFileSync } from 'node:fs'

import { StorageError } from '@strands-agents/sdk'
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

describe('TS-013 — the golden file covers what it claims to', () => {
  it('TS-013 — every section has vectors, and both a rejection and an accepted key are present', () => {
    for (const section of Object.values(golden).filter(Array.isArray)) expect(section.length).toBeGreaterThan(0)

    expect(golden.idFor.some((vector) => 'error' in vector)).toBe(true)
    expect(golden.idFor.some((vector) => 'value' in vector)).toBe(true)
    expect(golden.normalizeKey.some((vector) => 'error' in vector)).toBe(true)
  })
})
