/**
 * Key and prefix normalisation, the byte ceiling, the prefix join and the `_id` range, ported from the AT-018,
 * AT-019 and AT-026b classes of `python/tests/test_storage.py` and from the helpers they exercise.
 *
 * Python imports the SDK's private normalisers; TypeScript cannot, because the SDK's `exports` map forbids the
 * deep path. So `src/keys.ts` carries a copy, and the `TS-011` tests hold the copy to the original by driving the
 * SDK's own `InMemoryStorage`, which calls the real normalisers, over the same inputs.
 */
import { StorageError } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import { BSON } from 'mongodb'
import { describe, expect, it } from 'vitest'

import {
  abbreviate,
  DOCUMENT_OVERHEAD_BYTES,
  encodedSize,
  EXPIRES_OVERHEAD_BYTES,
  idFor,
  instancePrefix,
  normalizeKey,
  normalizePrefix,
  rangeFor,
  successor,
  type IdRange,
} from '../../src/keys.js'
import { MAX_KEY_BYTES } from '../../src/types.js'

const TARGET = 'agents.storage'

/** Whether `id` falls in `range`, compared by code point as MongoDB's binary comparison does. */
function inRange(id: string, range: IdRange): boolean {
  const bounds = range._id
  if (bounds === undefined) return true
  if (compareCodePoints(id, bounds.$gte) < 0) return false
  return bounds.$lt === undefined || compareCodePoints(id, bounds.$lt) < 0
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0) ?? 0)
  const right = Array.from(b, (c) => c.codePointAt(0) ?? 0)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

describe('AT-018 — keys are normalised before they become ids', () => {
  it.each(['a//b', '/a/b', 'a/b/', '//a//b//'])(
    'AT-018 — the spelling %j reaches the driver as the one id a/b',
    (key) => {
      expect(idFor('', key, TARGET)).toBe('a/b')
    },
  )

  it.each(['', '/', '//'])('AT-018 — the empty key %j throws StorageError', (key) => {
    expect(() => idFor('', key, TARGET)).toThrow(StorageError)
    expect(() => idFor('', key, TARGET)).toThrow(/empty/)
  })

  it.each(['a/../b', '..', '../a'])('AT-018 — the key %j with a .. segment throws StorageError', (key) => {
    expect(() => idFor('', key, TARGET)).toThrow(StorageError)
    expect(() => idFor('', key, TARGET)).toThrow(/\.\./)
  })

  it('AT-018 — a backslash throws, as on every shipped backend', () => {
    expect(() => idFor('', 'a\\b', TARGET)).toThrow(/backslash/)
  })

  it('AT-018 — the namespace prefix is prepended after normalisation', () => {
    expect(idFor(instancePrefix('tenant-a'), '/sessions//abc', TARGET)).toBe('tenant-a/sessions/abc')
  })
})

describe('AT-019 — a prefix argument is normalised by the prefix rule, which keeps its trailing slash', () => {
  it.each([
    ['a//b', 'a/b'],
    ['/a/b', 'a/b'],
    ['a/b/', 'a/b/'],
    ['//a//', 'a/'],
  ])('AT-019 — the lower bound for %j is %j', (query, expected) => {
    expect(rangeFor('', query)._id?.$gte).toBe(expected)
  })

  it('AT-019 — an empty prefix on an unprefixed instance is an unbounded query, not an error', () => {
    expect(rangeFor('', '')).toEqual({})
  })

  it('AT-019 — a .. segment in a prefix throws StorageError', () => {
    expect(() => rangeFor('', 'a/../b')).toThrow(StorageError)
    expect(() => rangeFor('', 'a/../b')).toThrow(/\.\./)
  })

  it('AT-019 — a trailing slash stays significant, so sessions/ excludes sessions-archive', () => {
    const range = rangeFor('', 'sessions/')

    expect(inRange('sessions/abc', range)).toBe(true)
    expect(inRange('sessions-archive/abc', range)).toBe(false)
  })

  it('AT-019 — the namespace prefix bounds the range as well', () => {
    expect(rangeFor(instancePrefix('tenant-a'), 'sessions/')._id?.$gte).toBe('tenant-a/sessions/')
    expect(rangeFor(instancePrefix('tenant-a'), '')._id?.$gte).toBe('tenant-a/')
  })
})

describe('TS-010 — the instance prefix ends in exactly one slash', () => {
  it.each(['tenant-a', 'tenant-a/', '/tenant-a', 'tenant-a//'])('TS-010 — %j becomes tenant-a/', (prefix) => {
    expect(instancePrefix(prefix)).toBe('tenant-a/')
  })

  it.each(['', '/', '//'])('TS-010 — %j means no prefix', (prefix) => {
    expect(instancePrefix(prefix)).toBe('')
  })

  it('TS-010 — a .. segment in the instance prefix throws StorageError', () => {
    expect(() => instancePrefix('a/../b')).toThrow(StorageError)
  })
})

describe('TS-010 — the key ceiling is counted in UTF-8 bytes, prefix included', () => {
  it('TS-010 — a key of exactly the ceiling is accepted, and one byte more is not', () => {
    expect(idFor('', 'k'.repeat(MAX_KEY_BYTES), TARGET)).toHaveLength(MAX_KEY_BYTES)
    expect(() => idFor('', 'k'.repeat(MAX_KEY_BYTES + 1), TARGET)).toThrow(StorageError)
  })

  it('TS-010 — the message names the byte count, the limit and the collection, and abbreviates the key', () => {
    expect(() => idFor('', 'k'.repeat(MAX_KEY_BYTES + 1), TARGET)).toThrow(
      `MongoDBStorage: the key '${'k'.repeat(60)}[+965 more]' encodes to 1025 bytes, over the 1024-byte ` +
        `limit this package applies to keys in agents.storage. The limit is counted in UTF-8 bytes rather ` +
        `than characters.`,
    )
  })

  it('TS-010 — a multi-byte key fails on bytes long before it reaches 1024 characters', () => {
    // 'é' is two bytes, so 513 of them is 1026 bytes in 513 characters.
    expect(() => idFor('', 'é'.repeat(513), TARGET)).toThrow(/1026 bytes/)
  })

  it('TS-010 — the prefix counts towards the ceiling', () => {
    const prefix = instancePrefix('tenant-a')

    expect(() => idFor(prefix, 'k'.repeat(MAX_KEY_BYTES - prefix.length + 1), TARGET)).toThrow(StorageError)
  })
})

describe('TS-010 — the range bound is an encodable successor', () => {
  it.each([
    ['a', 'b'],
    ['session/', 'session0'],
    ['ké', 'kê'],
    // U+D7FF increments into the surrogate block, which BSON cannot encode. Nothing sorts between U+D7FF and
    // U+E000, so the jump keeps the bound exact.
    ['퟿', ''],
    // U+10FFFF has no successor, so the character to its left is incremented instead.
    ['a\u{10ffff}', 'b'],
  ])('TS-010 — the successor of %j is %j', (text, expected) => {
    expect(successor(text)).toBe(expected)
  })

  it('TS-010 — a prefix made only of U+10FFFF has no upper bound', () => {
    expect(successor('\u{10ffff}\u{10ffff}')).toBeNull()
    expect(rangeFor('', '\u{10ffff}')).toEqual({ _id: { $gte: '\u{10ffff}' } })
  })

  it('TS-010 — a supplementary character is incremented as one code point, not as two UTF-16 units', () => {
    expect(successor('a\u{1f600}')).toBe('a\u{1f601}')
  })

  it.each(['a', 'session/', 'ké', '퟿', 'a\u{10ffff}', '\u{10ffff}', '\u{1f600}'])(
    'TS-010 — every bound emitted for %j survives the BSON encoder',
    (prefix) => {
      const range = rangeFor('', prefix)
      const bytes = BSON.serialize(range)
      // A lone surrogate is replaced with U+FFFD on encode, so a round trip is the test, not the absence of a
      // throw.
      expect(BSON.deserialize(bytes)).toEqual(range)
    },
  )
})

describe('TS-010 — a key in an error message is abbreviated by code point', () => {
  it('TS-010 — sixty characters are kept whole', () => {
    expect(abbreviate('k'.repeat(60))).toBe('k'.repeat(60))
  })

  it('TS-010 — longer keys keep sixty and count the rest', () => {
    expect(abbreviate('k'.repeat(61))).toBe(`${'k'.repeat(60)}[+1 more]`)
  })

  it('TS-010 — a supplementary character counts once, as in Python', () => {
    expect(abbreviate('\u{1f600}'.repeat(61))).toBe(`${'\u{1f600}'.repeat(60)}[+1 more]`)
  })
})

describe('TS-010 — the encoded size is computed without encoding', () => {
  it('TS-010 — the overheads are the ones Python pins', () => {
    expect(DOCUMENT_OVERHEAD_BYTES).toBe(46)
    expect(EXPIRES_OVERHEAD_BYTES).toBe(20)
  })

  it.each([
    ['a', 0, false],
    ['tenant-a/sessions/abc', 1000, false],
    ['ké/日本語', 17, true],
    ['\u{1f600}', 3, true],
  ])('TS-010 — the arithmetic for %j with %i bytes (expires: %s) equals the BSON encoder', (key, size, expires) => {
    const now = new Date()
    const document: Record<string, unknown> = {
      _id: key,
      data: new BSON.Binary(new Uint8Array(size)),
      updated_at: now,
    }
    if (expires) document.expires_at = now

    expect(encodedSize(key, size, expires)).toBe(BSON.calculateObjectSize(document))
  })
})

/** What a backend did with an input: the key it stored or listed, or the message it threw. */
type Outcome = { ok: string | string[] } | { error: string }

async function outcome(run: () => Promise<string | string[]> | string | string[]): Promise<Outcome> {
  try {
    return { ok: await run() }
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError)
    return { error: (error as Error).message }
  }
}

const KEYS = [
  'a',
  'a/b',
  'a//b',
  '/a/b/',
  '//a//b//',
  'a/./b',
  'a/.../b',
  '...',
  '.hidden',
  'ké/日本語',
  ' a / b ',
  '',
  '/',
  '//',
  '..',
  'a/..',
  '../a',
  'a/../b',
  'a\\b',
  '\\',
]

const PREFIXES = ['', '/', 'a', 'a/', 'a//', '/a', '//a//b//', 'a/b', 'k', 'ké/', '..', 'a/../b', 'a/..', 'a\\b']

const STORED = ['a', 'a/b', 'a/b/c', 'ab', 'a-b', 'ké/日本語', 'k', 'z']

describe("TS-011 — the key copies agree with the SDK's own normalisers", () => {
  it.each(KEYS)(
    'TS-011 — the key %j is stored as InMemoryStorage stores it, or rejected with its message',
    async (key) => {
      const memory = new InMemoryStorage()
      const expected = await outcome(async () => {
        await memory.write(key, new Uint8Array())
        return memory.list('')
      })

      expect(await outcome(() => [normalizeKey(key)])).toEqual(expected)
    },
  )

  it.each(PREFIXES)(
    'TS-011 — the prefix %j selects what InMemoryStorage lists, or is rejected alike',
    async (prefix) => {
      const memory = new InMemoryStorage()
      for (const key of STORED) await memory.write(key, new Uint8Array())

      const expected = await outcome(() => memory.list(prefix))
      const actual = await outcome(() => {
        const range = rangeFor('', prefix)
        return STORED.filter((key) => inRange(key, range)).sort()
      })

      expect(actual).toEqual(expected)
    },
  )

  it.each(PREFIXES)('TS-011 — normalizePrefix(%j) is what InMemoryStorage matches with', async (prefix) => {
    const memory = new InMemoryStorage()
    for (const key of STORED) await memory.write(key, new Uint8Array())

    const expected = await outcome(() => memory.list(prefix))
    const actual = await outcome(() => {
      const normalized = normalizePrefix(prefix)
      return STORED.filter((key) => key.startsWith(normalized)).sort()
    })

    expect(actual).toEqual(expected)
  })

  it.each(['tenant-a', 'tenant-a/', '/tenant-a', 'tenant-a//', '', '/', 'a//b/'])(
    'TS-011 — the namespace %j joins keys as InMemoryStorage.namespace does',
    async (prefix) => {
      const memory = new InMemoryStorage()
      await memory.namespace(prefix).write('/sessions//abc', new Uint8Array())

      expect([idFor(instancePrefix(prefix), '/sessions//abc', TARGET)]).toEqual(await memory.list(''))
    },
  )
})
