/**
 * Caller-filter validation and scope composition.
 *
 * Ports `python/tests/test_filter.py`. Isolation between scopes is a predicate in a query rather than a
 * database boundary, so a caller filter that widened the read scope, or one that silently failed to narrow
 * it, would return another scope's memories. These tests pin the guards that prevent both.
 *
 * AT-049 and AT-050a/b/c are checklist items 23 and 24 and keep their ids. AT-179, the guards covering every
 * container js-bson encodes as a document and refusing every regex, is TS-097. AT-051, composition, is
 * TS-098. TS-099 has no Python counterpart: what JavaScript lets a caller pass that Python's type hints rule
 * out, a top-level filter that is not a document and a filter that contains itself, and the single list of
 * baked-in fields shared with the index definition.
 */
import { BSON, BSONRegExp, DBRef, Decimal128, ObjectId } from 'mongodb'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { BAKED_IN_FILTER_FIELDS, compose, validate } from '../../src/filter.js'
import {
  BAKED_IN_FILTER_FIELDS as INDEX_BAKED_IN,
  declaredFilterFields,
  vectorIndexDefinition,
} from '../../src/indexes.js'
import { UNSCOPED } from '../../src/types.js'

/** The paths the vector index always declares, before any caller-supplied `filterFields`. */
const BAKED_IN = ['scope', 'store_name']

/** Validate against `declared`, the baked-in paths by default. */
const check = (filter: unknown, declared: readonly string[] = BAKED_IN): void =>
  validate(filter, { declaredFields: declared })

/** The message `check` throws, or a failure if it throws nothing. */
function messageOf(filter: unknown, declared: readonly string[] = BAKED_IN): string {
  try {
    check(filter, declared)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the filter to be rejected')
}

const TOP_LEVEL_OPERATORS = ['$where', '$expr', '$function', '$accumulator', '$or', '$and', '$nor', '$jsonSchema']

/**
 * Map keys that are not strings, each with its name for the title. A plain object cannot hold one, since
 * JavaScript turns every property key but a symbol into a string, and js-bson skips symbol properties.
 */
const NON_STRING_KEYS: ReadonlyArray<readonly [string, unknown]> = [
  ['1', 1],
  ['2.5', 2.5],
  ['null', null],
  ['true', true],
  ['an array', [1, 2]],
  ['a symbol', Symbol('key')],
]

describe('AT-050a — a top-level operator key is rejected by name', () => {
  it.each(TOP_LEVEL_OPERATORS)('AT-050a — %s is rejected with a TypeError naming it', (operator) => {
    expect(() => check({ [operator]: 'anything' })).toThrow(TypeError)
    expect(messageOf({ [operator]: 'anything' })).toContain(`'${operator}'`)
  })

  it('AT-050a — the message names the offending key and the shape a filter takes', () => {
    const message = messageOf({ $where: 'sleep(1000)' })

    expect(message).toMatch(/^strands_mongodb: invalid filter key '\$where'\./)
    expect(message).toContain("{'metadata.tier': 'gold'}")
  })
})

describe('AT-050b — an operator key is rejected at any depth, inside objects and arrays', () => {
  it('AT-050b — an operator nested one level down is rejected', () => {
    // `{ a: { $ne: null } }` matches every document where `a` holds anything: a narrowing filter turned
    // into a match-all, and the canonical bypass of a top-level-only check.
    expect(() => check({ a: { $ne: null } }, ['a'])).toThrow(/\$ne/)
  })

  it('AT-050b — an operator nested three levels down is rejected', () => {
    expect(() => check({ a: { b: { c: { $gt: 1 } } } }, ['a'])).toThrow(/\$gt/)
  })

  it('AT-050b — an operator inside an array is rejected', () => {
    // Defence in depth: in a `$match` a document inside an array is an equality operand, not an operator
    // position. That is a property of `$match`, though, not of this function.
    expect(() => check({ a: [{ $where: 'sleep(1000)' }] }, ['a'])).toThrow(/\$where/)
  })

  it('AT-050b — an operator inside a nested array is rejected', () => {
    expect(() => check({ a: [[{ $expr: {} }]] }, ['a'])).toThrow(/\$expr/)
  })

  it('AT-050b — an array of plain values is allowed, including one of clean documents', () => {
    expect(() => check({ tier: ['gold', 'silver'] }, ['tier'])).not.toThrow()
    expect(() => check({ tier: [] }, ['tier'])).not.toThrow()
    expect(() => check({ tier: [{ nested: 'ok' }] }, ['tier'])).not.toThrow()
  })

  it('AT-050b — a dollar sign that is not the first character is allowed', () => {
    // A check written as `key.includes('$')` passes every test above and rejects a valid field name.
    expect(() => check({ price$usd: 10 }, ['price$usd'])).not.toThrow()
  })

  it('AT-050b — a benign operator such as $gt is rejected too, because there is no allow-list', () => {
    expect(() => check({ age: { $gt: 5 } }, ['age'])).toThrow(/\$gt/)
  })

  it("AT-050b — a string value of '$where' is data, not an operator", () => {
    expect(() => check({ note: '$where' }, ['note'])).not.toThrow()
  })
})

describe('AT-050c — a non-string key is rejected', () => {
  it.each(NON_STRING_KEYS)('AT-050c — a Map key of %s is rejected with a TypeError', (_, key) => {
    expect(() => check(new Map([[key, 'x']]))).toThrow(TypeError)
    expect(() => check(new Map([[key, 'x']]))).toThrow(/invalid filter key/)
  })

  it('AT-050c — a non-string key nested in a document is rejected', () => {
    expect(() => check({ a: new Map([[1, 'x']]) }, ['a'])).toThrow(/invalid filter key 1\./)
  })
})

describe('TS-097 — the guards walk everything js-bson encodes as a document, and refuse every regex', () => {
  class Wrapper {
    constructor(readonly tier: unknown) {}
  }

  const withToBSON = (encoded: unknown): object => ({ toBSON: () => encoded })

  /** A container of each kind js-bson encodes as a subdocument, holding `{ $ne: 'gold' }`. */
  const DOCUMENT_FLAVOURS: ReadonlyArray<readonly [string, unknown]> = [
    ['Map', new Map([['$ne', 'gold']])],
    ['class instance', Object.assign(Object.create(Wrapper.prototype) as object, { $ne: 'gold' })],
    ['null-prototype object', Object.assign(Object.create(null) as object, { $ne: 'gold' })],
    ['toBSON result', withToBSON({ $ne: 'gold' })],
  ]

  it.each(DOCUMENT_FLAVOURS)('TS-097 — js-bson encodes a %s exactly as a plain object', (_, flavour) => {
    // The premise of walking it: what reaches the server is `{ tier: { $ne: 'gold' } }` either way.
    expect(BSON.serialize({ tier: flavour })).toEqual(BSON.serialize({ tier: { $ne: 'gold' } }))
  })

  it.each(DOCUMENT_FLAVOURS)('TS-097 — an operator inside a %s value is rejected', (_, flavour) => {
    expect(() => check({ tier: flavour }, ['tier'])).toThrow(/\$ne/)
  })

  it('TS-097 — an operator in a document inside a Map inside an array is rejected', () => {
    expect(() => check({ tier: [new Map([['inner', { $ne: 'gold' }]])] }, ['tier'])).toThrow(/\$ne/)
  })

  it('TS-097 — an object whose toBSON returns operators is judged by what it returns', () => {
    const honest = { toBSON: () => ({ level: 'gold' }), $ne: 'not encoded' }

    expect(() => check({ tier: honest }, ['tier'])).not.toThrow()
    expect(() => check(withToBSON({ $where: 'x' }))).toThrow(/\$where/)
  })

  it('TS-097 — a Map, a class instance and a toBSON object are accepted as the filter itself', () => {
    expect(() => check(new Map([['scope', 'tenant-a']]))).not.toThrow()
    expect(() => check(new Wrapper('gold'), ['tier'])).not.toThrow()
    expect(() => check(withToBSON({ scope: 'tenant-a' }))).not.toThrow()
  })

  it('TS-097 — a clean document value of any kind is still allowed', () => {
    expect(() => check({ tier: new Map([['level', 'gold']]) }, ['tier'])).not.toThrow()
    expect(() => check({ tier: new Wrapper('gold') }, ['tier'])).not.toThrow()
  })

  it('TS-097 — BSON values, dates and bytes are leaves, not documents to walk', () => {
    const leaves = {
      id: new ObjectId(),
      at: new Date(0),
      bytes: new Uint8Array([36]),
      amount: Decimal128.fromString('1.5'),
      ref: new DBRef('other', new ObjectId()),
    }

    expect(() => check(leaves, Object.keys(leaves))).not.toThrow()
  })

  it("TS-097 — a RegExp value is rejected with a TypeError naming the field and 'regular expression'", () => {
    expect(() => check({ tier: /^gol/ }, ['tier'])).toThrow(TypeError)
    const message = messageOf({ tier: /^gol/ }, ['tier'])

    expect(message).toMatch(/^strands_mongodb: invalid filter value for 'tier': a regular expression\./)
    expect(message).toContain("{'tier': 'gold'}")
  })

  it('TS-097 — a RegExp from another realm is rejected, as js-bson encodes it as one', () => {
    const foreign = runInNewContext('/^gol/') as unknown

    expect(foreign instanceof RegExp).toBe(false)
    expect(() => check({ tier: foreign }, ['tier'])).toThrow(/regular expression/)
  })

  it('TS-097 — a BSONRegExp, and a subclass of it, are rejected', () => {
    class Sneaky extends BSONRegExp {}

    expect(() => check({ tier: new BSONRegExp('^gol') }, ['tier'])).toThrow(/regular expression/)
    expect(() => check({ tier: new Sneaky('^gol') }, ['tier'])).toThrow(/regular expression/)
  })

  it('TS-097 — a regex a toBSON returns is rejected', () => {
    expect(() => check({ tier: withToBSON(/^gol/) }, ['tier'])).toThrow(/regular expression/)
  })

  it('TS-097 — a regex nested in a document, a Map or an array is rejected', () => {
    expect(() => check({ tier: { level: /x/ } }, ['tier'])).toThrow(/'level': a regular expression/)
    expect(() => check({ tier: new Map([['level', /x/]]) }, ['tier'])).toThrow(/'level': a regular expression/)
    expect(() => check({ tier: ['gold', /x/] }, ['tier'])).toThrow(/a regular expression inside an array/)
  })

  it('TS-097 — a string that looks like a pattern is still a string', () => {
    expect(() => check({ tier: '^gol.*$' }, ['tier'])).not.toThrow()
    expect(() => check({ tier: ['^gol', 'silver'] }, ['tier'])).not.toThrow()
  })

  it('TS-097 — the operator key is the message when a filter has both faults', () => {
    const message = messageOf({ tier: { $ne: /x/ } }, ['tier'])

    expect(message).toContain('$ne')
    expect(message).not.toContain('regular expression')
  })
})

describe('AT-049 — a filter on a field the index does not declare is rejected before querying', () => {
  it('AT-049 — an undeclared field throws a plain Error naming the field', () => {
    expect(() => check({ 'metadata.foo': 'x' })).toThrow(/'metadata\.foo'/)
    let caught: unknown
    try {
      check({ 'metadata.foo': 'x' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(TypeError)
    expect(caught).not.toBeInstanceOf(RangeError)
  })

  it('AT-049 — the message names what is declared and the config key that declares more', () => {
    const message = messageOf({ 'metadata.foo': 'x' })

    expect(message).toBe(
      "strands_mongodb: filter field(s) 'metadata.foo' are not declared filterable on this index, and the " +
        'server rejects a filter over an undeclared path. Filterable here: scope, store_name. Add the field ' +
        "to 'filterFields' in MongoDBConfig and recreate the index to filter on it.",
    )
  })

  it('AT-049 — a declared field passes, alongside the baked-in ones', () => {
    expect(() => check({ 'metadata.tier': 'gold' }, [...BAKED_IN, 'metadata.tier'])).not.toThrow()
  })

  it('AT-049 — the baked-in fields are filterable without being configured', () => {
    expect(() => check({ scope: 'tenant-a' })).not.toThrow()
    expect(() => check({ store_name: 'facts' })).not.toThrow()
  })

  it('AT-049 — every undeclared field is named, sorted, not only the first', () => {
    const message = messageOf({ 'metadata.tier': 1, region: 2, created_at: 3 }, ['scope'])

    expect(message).toContain("'created_at', 'metadata.tier', 'region' are not declared")
  })

  it('AT-049 — nothing declared reads as none', () => {
    expect(messageOf({ region: 1 }, [])).toContain('Filterable here: none.')
  })

  it('AT-049 — only top-level keys are field paths, as MQL reads a document value as exact equality', () => {
    expect(() => check({ metadata: { tier: 'gold' } }, ['metadata'])).not.toThrow()
    expect(() => check({ metadata: { tier: 'gold' } }, ['metadata.tier'])).toThrow(/'metadata'/)
  })

  it("AT-049 — a Map's keys are its field paths", () => {
    expect(() => check(new Map([['region', 'eu']]))).toThrow(/'region'/)
  })

  it('AT-049 — an empty filter is accepted', () => {
    expect(() => check({}, [])).not.toThrow()
    expect(() => check(new Map(), [])).not.toThrow()
  })

  it('AT-049 — the operator guard runs before the declared-field guard', () => {
    const message = messageOf({ $where: 'sleep(1000)' }, [])

    expect(message).toContain('$where')
    expect(message).not.toContain('filterFields')
  })
})

describe('TS-098 — a caller filter cannot widen the scope', () => {
  const STORE = { scope: 'tenant-a', storeName: 'facts' }
  const SCOPE_TERM = { scope: { $eq: 'tenant-a' } }
  const STORE_TERM = { store_name: { $eq: 'facts' } }

  it('TS-098 — the scope and store predicates are present with no caller filter at all', () => {
    expect(compose(STORE)).toEqual({ $and: [SCOPE_TERM, STORE_TERM] })
    expect(compose(STORE, undefined, null)).toEqual({ $and: [SCOPE_TERM, STORE_TERM] })
  })

  it('TS-098 — a caller filter is conjoined, never merged', () => {
    expect(compose(STORE, { 'metadata.tier': 'gold' })).toEqual({
      $and: [SCOPE_TERM, STORE_TERM, { 'metadata.tier': 'gold' }],
    })
  })

  it("TS-098 — a caller filter naming scope adds a term and leaves the store's in place", () => {
    expect(compose(STORE, { scope: 'tenant-b' }).$and).toEqual([SCOPE_TERM, STORE_TERM, { scope: 'tenant-b' }])
  })

  it('TS-098 — each caller filter stays its own term, in order', () => {
    expect(compose(STORE, { a: 1 }, { b: 2 }).$and).toEqual([SCOPE_TERM, STORE_TERM, { a: 1 }, { b: 2 }])
  })

  it('TS-098 — an empty caller filter adds no term', () => {
    expect(compose(STORE, {}, new Map()).$and).toEqual([SCOPE_TERM, STORE_TERM])
  })

  it('TS-098 — the scope term comes first', () => {
    expect(compose(STORE, { 'metadata.tier': 'gold' }).$and[0]).toEqual(SCOPE_TERM)
  })

  it("TS-098 — the caller's filter is not mutated", () => {
    const caller = { 'metadata.tier': 'gold' }

    compose(STORE, caller)

    expect(caller).toEqual({ 'metadata.tier': 'gold' })
  })

  it("TS-098 — the composed predicate shares no structure with the caller's filter, at any depth", () => {
    const caller = { metadata: { tier: ['gold'] }, at: new Date(0), bytes: new Uint8Array([1]) }
    const composed = compose(STORE, caller)

    caller.metadata.tier.push('bronze')
    caller.at.setTime(1)
    caller.bytes[0] = 2

    expect(composed.$and[2]).toEqual({ metadata: { tier: ['gold'] }, at: new Date(0), bytes: new Uint8Array([1]) })
  })

  it('TS-098 — a Map or toBSON filter becomes a plain document that encodes the same', () => {
    const viaMap = compose(STORE, new Map<string, unknown>([['tier', new Map([['level', 'gold']])]]))
    const viaToBSON = compose(STORE, { toBSON: () => ({ tier: { level: 'gold' } }) })

    expect(viaMap.$and[2]).toEqual({ tier: { level: 'gold' } })
    expect(BSON.serialize(viaToBSON)).toEqual(BSON.serialize(viaMap))
  })

  it('TS-098 — a BSON value survives the copy as itself', () => {
    const id = new ObjectId()
    const term = compose(STORE, { ref: id }).$and[2] as { ref: unknown }

    expect(term.ref).toBeInstanceOf(ObjectId)
    expect(BSON.serialize(term)).toEqual(BSON.serialize({ ref: id }))
  })

  it('TS-098 — the unscoped sentinel composes like any other scope', () => {
    expect(compose({ scope: UNSCOPED, storeName: 'facts' }).$and[0]).toEqual({ scope: { $eq: UNSCOPED } })
  })
})

/** Top-level values that are not a document, each with what it is called in the message. */
const NOT_A_DOCUMENT: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['a string', 'scope'],
  ['a number', 1],
  ['an array', [{ scope: 'a' }]],
  ['a Date', new Date(0)],
  ['a RegExp', /x/],
  ['bytes', new Uint8Array([1])],
  ['an ObjectId', new ObjectId()],
]

describe('TS-099 — what JavaScript lets a caller pass that a Python mapping rules out', () => {
  it.each(NOT_A_DOCUMENT)('TS-099 — %s as the whole filter is rejected with a TypeError', (_, filter) => {
    expect(() => check(filter)).toThrow(TypeError)
    expect(() => check(filter)).toThrow(/a filter is a document of field path to exact value/)
  })

  it('TS-099 — a filter that contains itself is rejected rather than walked forever', () => {
    const circular: Record<string, unknown> = { scope: 'a' }
    circular.self = { again: circular }

    expect(() => check(circular, ['scope', 'self'])).toThrow(TypeError)
    expect(() => check(circular, ['scope', 'self'])).toThrow(/contains itself/)
  })

  it('TS-099 — the same object twice, side by side, is not a cycle', () => {
    const shared = { level: 'gold' }

    expect(() => check({ a: shared, b: [shared, shared] }, ['a', 'b'])).not.toThrow()
  })

  it('TS-099 — the baked-in fields are one list, shared with the index definition', () => {
    expect(BAKED_IN_FILTER_FIELDS).toBe(INDEX_BAKED_IN)
    expect(BAKED_IN_FILTER_FIELDS).toEqual(BAKED_IN)
    expect(declaredFilterFields()).toEqual([...BAKED_IN_FILTER_FIELDS])
  })

  it('TS-099 — every field compose writes is one the index declares filterable', () => {
    const declared = vectorIndexDefinition({ autoEmbed: false, dimensions: 4, similarity: 'cosine' })
      .fields.filter((field) => field.type === 'filter')
      .map((field) => field.path)
    const written = compose({ scope: 's', storeName: 'n' }).$and.flatMap((term) => Object.keys(term))

    expect(written).toEqual([...BAKED_IN_FILTER_FIELDS])
    expect(declared).toEqual(expect.arrayContaining(written))
  })
})
