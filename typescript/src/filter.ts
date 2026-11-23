/**
 * Caller-filter validation and scope composition, shared by the search paths.
 *
 * Ported from `python/src/strands_mongodb/_filter.py`. Three guards and one composer, all pure functions:
 * nothing here connects or does I/O, so the security guards are tested without a deployment.
 *
 * The guards are separate because they answer different questions with different remedies: what a key is (a
 * string with no leading `$`), what a value does (no regex), and whether the index declared the field. One
 * combined pass would give one message for three unrelated problems.
 *
 * Python walks every `Mapping`, list and tuple, because those are what pymongo's bson encodes. The guards here
 * walk what js-bson 7 encodes as a document or an array, read from its serializer: `toBSON()` is called
 * first wherever it is defined; an array is an array; a `Map` is a document of its entries, whose keys need not
 * be strings; and any other object that is not a `Date`, bytes, a `RegExp` or a BSON value is a document of its
 * own enumerable string keys, class instances and null-prototype objects included. A guard that walked plain
 * objects only would pass `{ tier: new Map([['$ne', 'gold']]) }`, which reaches the server as
 * `{ tier: { $ne: 'gold' } }` and matches every document whose tier is not gold.
 *
 * `toBSON()` is judged by what it returns when the guard calls it. One that returns something different on a
 * later call, when the driver encodes the query, is outside what any validator can see.
 *
 * Messages start with `strands_mongodb: ` rather than a class name, as Python's do, because both stores share
 * this module. A wrong key or value is a `TypeError`, as the design's error table has it; an undeclared field
 * is a plain `Error`, since the filter is well formed and the index is what lacks it.
 *
 * Internal: not exported from the entry point.
 *
 * @packageDocumentation
 */
import type { Document } from 'mongodb'

import { BAKED_IN_FILTER_FIELDS, repr } from './indexes.js'

export { BAKED_IN_FILTER_FIELDS }

/** The store a composed predicate is confined to. */
export interface FilterScope {
  /** The store's scope. Never taken from caller input; an absent scope resolves to a sentinel upstream. */
  readonly scope: string
  /** The store's name, isolating it from other stores in the same collection. */
  readonly storeName: string
}

/** A composed predicate: the scope term, the store term, then each non-empty caller filter. */
export interface ComposedFilter {
  readonly $and: Document[]
}

/** The shape every message below describes. */
const SHAPE = "A filter is a document of field path to exact value, such as {'metadata.tier': 'gold'}."

/**
 * An operator key or a non-string key, at any depth.
 *
 * @param key - The refused key.
 * @returns The message.
 */
const INVALID_KEY = (key: unknown): string =>
  `strands_mongodb: invalid filter key ${repr(key)}. MongoDB operator keys and non-string keys are not allowed ` +
  `anywhere in a filter, at any depth. ${SHAPE}`

/**
 * A regex as the value of a field.
 *
 * @param key - The field that carries it.
 * @returns The message.
 */
const REGEX_VALUE = (key: string): string =>
  `strands_mongodb: invalid filter value for ${repr(key)}: a regular expression. A filter is a document of ` +
  'field path to exact value, and a regex is matched as a pattern rather than compared, so it would select ' +
  `documents this filter does not name. Pass the literal value to match, such as {${repr(key)}: 'gold'}.`

/** A regex as an array element, where there is no field to name. */
const REGEX_IN_ARRAY =
  'strands_mongodb: invalid filter value: a regular expression inside an array. A filter is a document of ' +
  'field path to exact value, at any depth, and a regex is matched as a pattern rather than compared.'

/**
 * Fields the index does not declare filterable.
 *
 * @param undeclared - Every undeclared field, sorted.
 * @param declared - Every declared field, sorted.
 * @returns The message.
 */
const UNDECLARED = (undeclared: readonly string[], declared: readonly string[]): string =>
  `strands_mongodb: filter field(s) ${undeclared.map(repr).join(', ')} are not declared filterable on this ` +
  'index, and the server rejects a filter over an undeclared path. Filterable here: ' +
  `${declared.join(', ') || 'none'}. Add the field to 'filterFields' in MongoDBConfig and recreate the index ` +
  'to filter on it.'

/**
 * A top-level value js-bson would not encode as a document. Python's type hints rule this out; JavaScript
 * callers can pass anything.
 *
 * @param value - The value passed as the filter.
 * @returns The message.
 */
const NOT_A_DOCUMENT = (value: unknown): string =>
  `strands_mongodb: invalid filter, ${kindOf(value)}: a filter is a document of field path to exact value, ` +
  "such as {'metadata.tier': 'gold'}."

/** A filter reachable from itself, which js-bson refuses to encode and a walk would never finish. */
const CIRCULAR =
  'strands_mongodb: invalid filter: it contains itself. A filter is a tree of field path to exact value, and ' +
  'a circular structure cannot be encoded as BSON.'

/**
 * Check a caller-supplied filter against all three guards.
 *
 * A valid filter is a document from declared field paths to exact values:
 *
 * - Every key, at any depth (inside nested documents, Maps and arrays), is a string not starting with `$`. So
 *   no operators: no `$and`, `$or`, `$ne`, `$in`, `$where`, `$expr`.
 * - No value, at any depth, is a regex (`RegExp` or `BSONRegExp`).
 * - Every top-level key is in `declaredFields`. Dotted paths such as `'metadata.tier'` are allowed when
 *   declared exactly so.
 *
 * The order is part of the contract: operator keys, then regex values, then undeclared fields. `{ $where: … }`
 * is both forbidden and undeclared, and a caller told to declare `$where` in `filterFields` might try to.
 *
 * @param callerFilter - The filter as the caller supplied it. Not modified.
 * @param options - `declaredFields`: the paths the index declares filterable, baked-in ones included.
 * @throws TypeError when the filter is not a document, contains itself, or has an operator or non-string key
 *   or a regex value anywhere.
 * @throws Error when a top-level field is not declared filterable.
 */
export function validate(callerFilter: unknown, options: { readonly declaredFields: Iterable<string> }): void {
  const entries = documentEntries(callerFilter)
  if (entries === undefined) throw new TypeError(NOT_A_DOCUMENT(callerFilter))
  rejectOperatorKeys(callerFilter)
  rejectRegexValues(callerFilter)
  rejectUndeclaredFields(
    entries.map(([key]) => key as string),
    options.declaredFields,
  )
}

/**
 * Compose caller filters with the scope predicate as a conjunction.
 *
 * `$and` rather than a merged object: `{ ...scopePredicate, ...callerFilter }` would let a caller's `scope`
 * key overwrite the store's. Under `$and` a caller term can only narrow, and a contradictory one matches
 * nothing. Each caller filter stays its own term, since merging two would need a `$and` that {@link validate}
 * rejects.
 *
 * Does not validate: callers run {@link validate} first.
 *
 * @param store - The scope and store name the predicate confines the query to.
 * @param callerFilters - Validated filters, in the order they should appear. `undefined`, `null` and an empty
 *   filter add no term.
 * @returns The scope term, then the store term, then every non-empty caller filter, deep-copied into plain
 *   objects so the caller's filters and the predicate share no structure. BSON values are kept as they are.
 * @throws TypeError when a caller filter is not a document.
 */
export function compose(store: FilterScope, ...callerFilters: unknown[]): ComposedFilter {
  const terms: Document[] = [{ scope: { $eq: store.scope } }, { store_name: { $eq: store.storeName } }]
  for (const callerFilter of callerFilters) {
    if (callerFilter === undefined || callerFilter === null) continue
    const entries = documentEntries(callerFilter)
    if (entries === undefined) throw new TypeError(NOT_A_DOCUMENT(callerFilter))
    // Deep, so mutating a nested value after composing cannot alter a query already in flight.
    if (entries.length > 0) terms.push(copyEntries(entries))
  }
  return { $and: terms }
}

/**
 * Throw if any key at any depth starts with `$` or is not a string.
 *
 * Only keys are checked: a key is what MQL dispatches on, and a value is data (the string `'$where'` as a value
 * is just a string). Arrays are walked too. A document inside an array is an equality operand to `$match`
 * rather than an operator position, but that is the server's guarantee, not this function's.
 */
function rejectOperatorKeys(callerFilter: unknown): void {
  walk(callerFilter, (key, _value, inArray) => {
    if (!inArray && (typeof key !== 'string' || key.startsWith('$'))) throw new TypeError(INVALID_KEY(key))
  })
}

/**
 * Throw if any value at any depth is a regex.
 *
 * Given a regex, `$match` and `$eq` pattern-match instead of comparing: `{ tier: /^gol/ }` matches a document
 * whose tier is `'gold'`. The operator guard cannot catch it, because there is no `$` key.
 */
function rejectRegexValues(callerFilter: unknown): void {
  walk(callerFilter, (key, value, inArray) => {
    if (isRegex(value)) throw new TypeError(inArray ? REGEX_IN_ARRAY : REGEX_VALUE(key as string))
  })
}

/**
 * Throw if a top-level key is not declared filterable.
 *
 * mongot rejects such a filter itself, with code 8. This runs first so the message names the config key to
 * edit and what is filterable now, without a round trip. Top-level keys only is exact: the operator guard has
 * already refused `$and` and `$or`, so no field path can sit lower, and a document value is exact equality on
 * the key above it.
 */
function rejectUndeclaredFields(keys: readonly string[], declaredFields: Iterable<string>): void {
  const declared = new Set(declaredFields)
  const undeclared = [...new Set(keys.filter((key) => !declared.has(key)))].sort()
  if (undeclared.length > 0) throw new Error(UNDECLARED(undeclared, [...declared].sort()))
}

/**
 * Visit every key and value below `container`, depth first, a key before what it holds.
 *
 * @param container - A document or array, or anything else, which has nothing below it.
 * @param visit - Called with each key, or array index, and the value as js-bson would encode it.
 * @param ancestors - The containers above this one, to refuse a cycle.
 * @throws TypeError when a container is reachable from itself.
 */
function walk(
  container: unknown,
  visit: (key: unknown, value: unknown, inArray: boolean) => void,
  ancestors: Set<object> = new Set(),
): void {
  const inArray = Array.isArray(container)
  const entries: Array<[unknown, unknown]> | undefined = inArray
    ? (container as unknown[]).map((item, index) => [index, item])
    : documentEntries(container)
  if (entries === undefined) return
  if (ancestors.has(container as object)) throw new TypeError(CIRCULAR)
  ancestors.add(container as object)
  for (const [key, raw] of entries) {
    const value = encodedForm(raw)
    visit(key, value, inArray)
    walk(value, visit, ancestors)
  }
  ancestors.delete(container as object)
}

/**
 * The entries js-bson writes for `value` if it encodes it as a document, or `undefined` if it does not.
 *
 * Values are returned as found, before their own `toBSON()`: {@link encodedForm} applies that.
 */
function documentEntries(value: unknown): Array<[unknown, unknown]> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isLeaf(value)) return undefined
  if (isMap(value)) return [...value.entries()]
  const target: unknown = hasToBSON(value) ? value.toBSON() : value
  if (typeof target !== 'object' || target === null) return []
  return Object.keys(target).map((key) => [key, (target as Record<string, unknown>)[key]])
}

/** `value` after the `toBSON()` js-bson calls on every value that defines one. */
function encodedForm(value: unknown): unknown {
  return hasToBSON(value) ? value.toBSON() : value
}

/**
 * A plain copy of a document's entries, at every depth.
 *
 * Not `structuredClone`, which strips a BSON value's class and so changes what it encodes as.
 */
function copyEntries(entries: ReadonlyArray<[unknown, unknown]>): Document {
  return Object.fromEntries(entries.map(([key, value]) => [key as string, copyValue(encodedForm(value))]))
}

/** A copy of one value, sharing nothing mutable with it. */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => copyValue(encodedForm(item)))
  const entries = documentEntries(value)
  if (entries !== undefined) return copyEntries(entries)
  if (isDate(value)) return new Date(value.getTime())
  if (isBytes(value)) return new Uint8Array(value)
  return value
}

/** Whether js-bson encodes `value` as a value of its own rather than walking it: a BSON value, date, bytes or regex. */
function isLeaf(value: object): boolean {
  return (value as { _bsontype?: unknown })._bsontype != null || isDate(value) || isBytes(value) || isRegex(value)
}

/**
 * Whether `value` reaches the server as a BSON regex: a `RegExp` from any realm, or a `BSONRegExp` or any
 * subclass of one, whose `_bsontype` getter it inherits.
 */
function isRegex(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (
    value instanceof RegExp ||
    Object.prototype.toString.call(value) === '[object RegExp]' ||
    (value as { _bsontype?: unknown })._bsontype === 'BSONRegExp'
  )
}

function isDate(value: unknown): value is Date {
  return value instanceof Date || Object.prototype.toString.call(value) === '[object Date]'
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || Object.prototype.toString.call(value) === '[object Uint8Array]'
}

/** js-bson's test: an instance of `Map`, or anything tagged as one. */
function isMap(value: object): value is Map<unknown, unknown> {
  return value instanceof Map || (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === 'Map'
}

function hasToBSON(value: unknown): value is { toBSON(): unknown } {
  return typeof (value as { toBSON?: unknown } | null | undefined)?.toBSON === 'function'
}

/** How {@link NOT_A_DOCUMENT} names a value. */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value !== 'object') return `a ${typeof value}`
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name
  return typeof name === 'string' && name !== '' ? `an instance of ${name}` : 'an object'
}
