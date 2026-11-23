/**
 * Bringing a collection's indexes to the declared state, and probing what the deployment can do.
 *
 * Ported from the second half of `python/src/strands_mongodb/_indexes.py`: `ensure`, `search_support` and
 * `rank_fusion_support`, with the containment rule that decides whether a reported search definition covers
 * the declared one. `require_binary_comparison` and `read_collation` arrive with the storage surface that
 * calls them.
 *
 * Messages keep Python's `strands_mongodb: ` prefix rather than a class name. This module is shared by both
 * stores and does not know which one called it, and the commands in the messages are byte for byte the
 * ones Python prints.
 *
 * Nothing here drops or alters an existing index. Each conflict is reported with the commands that resolve
 * it, because an index this package did not create may be serving queries it knows nothing about.
 *
 * @packageDocumentation
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { StorageError } from '@strands-agents/sdk'
import { MongoError, MongoServerError } from 'mongodb'
import type { Collection, Db, Document } from 'mongodb'

import { type IndexSpec, type SearchIndexSpec, dropIndexCommand, pythonJson, readiness, repr } from './indexes.js'
import { type SpanAttributes, annotate, eventFields, logger, span } from './telemetry.js'
import {
  POLL_INTERVAL_MS,
  RANK_FUSION_MIN_MAJOR,
  READY_TIMEOUT_MS,
  SEARCH_UNSUPPORTED_CODES,
  SIMPLE_LOCALE,
} from './types.js'

/** The server code for an operation on a collection that does not exist. */
const COLLECTION_ABSENT = 26

/** The server code for creating a collection that already exists. */
const NAMESPACE_EXISTS = 48

/** What {@link searchSupport} found: whether search answered, and if not, the code it answered with. */
export interface SearchSupport {
  readonly available: boolean
  readonly code?: number
}

/** What {@link ensure} is asked to do. */
export interface EnsureOptions {
  /** Ordinary and TTL indexes, from `storageSpecs` or `memorySpecs`. */
  readonly ordinary?: readonly IndexSpec[]
  /** Atlas Search indexes, from `memorySearchSpecs`. */
  readonly search?: readonly SearchIndexSpec[]
  /** Whether missing indexes may be created. `false` verifies, and still waits for a build somebody started. */
  readonly create?: boolean
  /** Milliseconds to wait for search builds, in total across all of them. */
  readonly timeoutMs?: number
  /** Milliseconds between readiness reads. */
  readonly intervalMs?: number
}

/** A search index exists but did not report `READY` within the timeout. */
export class SearchIndexNotReady extends StorageError {
  constructor(message: string) {
    super(message)
    this.name = 'SearchIndexNotReady'
  }
}

/**
 * Report whether this deployment can run Atlas Search at all, and on what evidence.
 *
 * Probed with `listSearchIndexes` because `buildInfo` cannot tell: `mongo:8` and an Atlas CLI local
 * deployment both report empty `modules` and only the second has search, while enterprise 7.0.12 reports
 * `modules: ['enterprise']` and has none.
 *
 * @param collection - The collection whose deployment to probe. Need not exist.
 * @returns `available: true` if the deployment answers the call, or `available: false` with the code it
 *   answered with, when that code is one of `SEARCH_UNSUPPORTED_CODES`.
 * @throws StorageError when the call fails for any other reason, including authentication. A bad password
 *   must not read as "no search".
 */
export function searchSupport(collection: Collection): Promise<SearchSupport> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'search'), async () => {
    try {
      // One document is enough to answer, and `return` closes the cursor rather than draining it.
      const cursor = collection.listSearchIndexes()[Symbol.asyncIterator]()
      try {
        await cursor.next()
      } finally {
        await cursor.return?.()
      }
    } catch (error) {
      if (!(error instanceof MongoError)) throw error
      const code = serverCode(error)
      if (code !== undefined && SEARCH_UNSUPPORTED_CODES.has(code)) return { available: false, code }
      // Code 26, a collection that does not exist, still means the call worked.
      if (code !== COLLECTION_ABSENT) {
        throw new StorageError(PROBE_FAILED(namespaceOf(collection), error), { cause: error })
      }
    }
    return { available: true }
  })
}

/**
 * Report whether this deployment can run `$rankFusion`.
 *
 * Unlike {@link searchSupport} this reads `buildInfo`, because `$rankFusion` is a `mongod` stage and
 * `mongod`'s version decides it. `versionArray` avoids parsing suffixes such as `-rc1`.
 *
 * Every failure reads as `false`. The answer only picks between two working search tiers, so a wrong
 * `false` costs ranking quality while a wrong `true` makes every search fail.
 *
 * @param db - The database to send `buildInfo` to.
 * @param collection - The collection the probe is for, which the span names. Need not exist.
 * @returns `true` if the server reports major version `RANK_FUSION_MIN_MAJOR` or later.
 */
export function rankFusionSupport(db: Db, collection: Collection): Promise<boolean> {
  return span('strands_mongodb.indexes.probe', probeAttributes(collection, 'rank_fusion'), async () => {
    let buildInfo: unknown
    try {
      buildInfo = await db.command({ buildInfo: 1 })
    } catch (error) {
      if (error instanceof MongoError) return false
      throw error
    }
    if (typeof buildInfo !== 'object' || buildInfo === null) return false
    const version = (buildInfo as Document).versionArray
    if (!Array.isArray(version) || version.length === 0) return false
    const major: unknown = version[0]
    return typeof major === 'number' && Number.isInteger(major) && major >= RANK_FUSION_MIN_MAJOR
  })
}

/**
 * Bring a collection's indexes to the declared state, or explain what is stopping that.
 *
 * Safe to call on every `initialize()`: when everything is in place it costs one read for the ordinary
 * indexes plus one per search index, and no writes.
 *
 * @param db - The collection's database, which creates the collection before a search index is created.
 *   The driver's `Collection` has no public accessor for it.
 * @param collection - The collection to index.
 * @param options - What to ensure, whether creating is allowed, and how long to wait.
 * @throws StorageError when an existing index conflicts with a declared one, a search build has failed,
 *   something is missing and `create` is `false`, or a driver call fails. A driver error is the `cause`.
 * @throws SearchIndexNotReady when a search build does not finish inside `timeoutMs`.
 */
export function ensure(db: Db, collection: Collection, options: EnsureOptions = {}): Promise<void> {
  const { ordinary = [], search = [], create = true } = options
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const attributes: SpanAttributes = {
    ...namespaceAttributes(collection),
    'strands_mongodb.indexes.mode': create ? 'ensure' : 'verify',
  }
  // A counter the helpers add to, so the span still gets the count when one of them throws part way.
  const created = { count: 0 }
  return span('strands_mongodb.indexes.ensure', attributes, async () => {
    try {
      if (ordinary.length > 0) await ensureOrdinary(collection, ordinary, create, created)
      if (search.length > 0) await ensureSearch(db, collection, search, { create, timeoutMs, intervalMs }, created)
    } finally {
      annotate('strands_mongodb.indexes.created', created.count)
    }
  })
}

/** Create or verify the ordinary indexes, matching on the key list. */
async function ensureOrdinary(
  collection: Collection,
  specs: readonly IndexSpec[],
  create: boolean,
  created: { count: number },
): Promise<void> {
  const namespace = namespaceOf(collection)
  const present = await guard(`reading indexes on ${namespace}`, () => readIndexes(collection))
  // Several indexes can share a key list (identity is keys plus collation), so keep all of them.
  const byKeys = new Map<string, Document[]>()
  for (const found of present) {
    const keys = keyList(found.key as Document)
    byKeys.set(keys, [...(byKeys.get(keys) ?? []), found])
  }

  const missing: IndexSpec[] = []
  for (const spec of specs) {
    const matches = byKeys.get(keyList(spec.key))
    if (matches === undefined) missing.push(spec)
    else checkMatches(collection.collectionName, namespace, spec, matches)
  }

  if (missing.length === 0) return
  if (!create) throw new StorageError(MISSING_ORDINARY(collection.collectionName, namespace, missing))

  logger.info(
    eventFields('creating_indexes', { namespace }),
    CREATING_INDEXES(missing.length, namespace, missing.map((spec) => spec.name).join(', ')),
  )
  // One call for all of them. The server tolerates concurrent identical creates (10 at once: no failures,
  // one index).
  await guard(`creating indexes on ${namespace}`, () =>
    collection.createIndexes(missing.map((spec) => spec.description() as never)),
  )
  created.count += missing.length
}

/** A key document as a comparable string of its entries, in order. */
function keyList(key: Document): string {
  return JSON.stringify(Object.entries(key))
}

/** The locale of a reported collation that does not compare byte for byte, or undefined when it does. */
function foldingLocale(found: Document): string | undefined {
  const collation: unknown = found.collation
  if (typeof collation !== 'object' || collation === null) return undefined
  const locale = (collation as Document).locale
  return locale === SIMPLE_LOCALE ? undefined : String(locale)
}

/**
 * Check every existing index over a declared index's keys, not just one.
 *
 * A unique index under a folding collation is refused wherever it appears: the server enforces its folded
 * uniqueness even beside a correct index. Otherwise one usable match is enough, and the others are somebody
 * else's business. When none is usable, the first match's refusal is the one reported.
 */
function checkMatches(collectionName: string, namespace: string, spec: IndexSpec, matches: Document[]): void {
  if (!spec.dateOnly) {
    for (const found of matches) {
      const locale = foldingLocale(found)
      if (locale !== undefined && found.unique) {
        throw new StorageError(FOLDED_CONSTRAINT(collectionName, namespace, spec, found.name as string, locale))
      }
    }
  }
  let first: StorageError | undefined
  for (const found of matches) {
    const refusal = refusalOf(collectionName, namespace, spec, found)
    if (refusal === undefined) return
    first ??= refusal
  }
  // The caller never passes an empty `matches`, so `first` is set here.
  throw first as StorageError
}

/** Why one matched index cannot serve the spec, or undefined if it can. */
function refusalOf(
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  found: Document,
): StorageError | undefined {
  const foundName = found.name as string
  if (!spec.dateOnly) {
    const locale = foldingLocale(found)
    if (locale !== undefined) {
      return new StorageError(FOLDING_COLLATION(collectionName, namespace, spec, foundName, locale))
    }
  }
  // Only options this package sets are compared. `v`, `background`, `hidden` and anything else the server
  // or another tool added are ignored.
  for (const [option, wanted] of Object.entries(spec.options)) {
    if (option in found && isDeepStrictEqual(found[option], wanted)) continue
    const actual = option in found ? repr(found[option]) : 'absent'
    return new StorageError(OPTION_MISMATCH(collectionName, namespace, spec, foundName, option, actual, wanted))
  }
  return undefined
}

/** Create or verify the search indexes, then wait for anything still building. */
async function ensureSearch(
  db: Db,
  collection: Collection,
  specs: readonly SearchIndexSpec[],
  options: { create: boolean; timeoutMs: number; intervalMs: number },
  created: { count: number },
): Promise<void> {
  const namespace = namespaceOf(collection)
  const collectionName = collection.collectionName
  const found = new Map<string, Document | undefined>()
  for (const spec of specs) found.set(spec.name, await readSearchIndex(collection, spec.name, namespace))

  const missing: SearchIndexSpec[] = []
  const waiting: SearchIndexSpec[] = []
  for (const spec of specs) {
    const document = found.get(spec.name)
    if (document === undefined) {
      missing.push(spec)
      continue
    }
    const state = readiness(String(document.status ?? ''))
    if (state === 'failed') throw new StorageError(BUILD_FAILED(collectionName, namespace, spec, document))
    checkDefinition(collectionName, namespace, spec, document)
    if (state !== 'ready') waiting.push(spec)
  }

  if (missing.length > 0) {
    if (!options.create) throw new StorageError(MISSING_SEARCH(collectionName, namespace, missing))
    // `createSearchIndexes` on a missing collection fails with code 26, unlike `createIndexes`, which
    // creates it implicitly.
    await createCollection(db, collectionName, namespace)
    for (const spec of missing) {
      logger.info(eventFields('creating_search_index', { namespace }), CREATING_SEARCH_INDEX(spec, namespace))
      await guard(`creating search index ${repr(spec.name)} on ${namespace}`, () =>
        collection.createSearchIndex({ name: spec.name, type: spec.type, definition: spec.definition as Document }),
      )
      created.count += 1
    }
    waiting.push(...missing)
  }

  if (waiting.length === 0) return
  // Thrown after the wait span closes: a timeout is the wait's outcome (`timed_out`, status unset), and the
  // error belongs to the `ensure` span.
  const stuck = await span('strands_mongodb.indexes.wait', namespaceAttributes(collection), async () => {
    const result = await waitUntilReady(collection, waiting, namespace, options)
    annotate('strands_mongodb.indexes.outcome', result === undefined ? 'ready' : 'timed_out')
    return result
  })
  if (stuck !== undefined) throw new SearchIndexNotReady(NOT_READY(options.timeoutMs, stuck, namespace, collectionName))
}

/** Read one search index by name, or undefined if it is not there. */
async function readSearchIndex(collection: Collection, name: string, namespace: string): Promise<Document | undefined> {
  try {
    for await (const document of collection.listSearchIndexes(name)) return document
  } catch (error) {
    if (!(error instanceof MongoError)) throw error
    // Code 26: a collection that does not exist has no indexes.
    if (serverCode(error) !== COLLECTION_ABSENT) {
      throw new StorageError(READ_FAILED(name, namespace, error), { cause: error })
    }
  }
  return undefined
}

/**
 * Check that an existing search index's definition covers the declared one.
 *
 * The server would refuse a different definition under the same name with code 68, but only on creation.
 * This catches the mismatch on the warm path too, where nothing is created.
 */
function checkDefinition(collectionName: string, namespace: string, spec: SearchIndexSpec, document: Document): void {
  const definition: unknown = document.latestDefinition
  if (definition === undefined || definition === null) return
  const gap = definitionGap(spec.definition, definition)
  if (gap === undefined) return
  throw new StorageError(DEFINITION_GAP(collectionName, namespace, spec, gap, definition))
}

/** Whether `value` is a plain object rather than a list or a scalar. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Describe the first place `found` fails to cover `wanted`, or undefined if it covers it.
 *
 * Containment, not equality, because mongot rewrites a `search` index's `latestDefinition`: it collapses
 * the one-element list in `mappings.fields.<field>` into the object it held and fills in `indexOptions`,
 * `store` and `norms`. Equality would fail on a text index this package just created.
 *
 * A declared object is covered when every key it declares is present and covered. A declared one-element
 * list is covered by an object reported in its place. A declared list is covered when each of its entries
 * is covered by some reported entry, in any order.
 */
function definitionGap(wanted: unknown, found: unknown, path = 'definition'): string | undefined {
  if (isObject(wanted)) {
    if (!isObject(found)) return `${path} is ${repr(found)} where this package declared the object ${repr(wanted)}`
    for (const [key, value] of Object.entries(wanted)) {
      if (!(key in found)) return `${path}.${key} is absent, and this package declared ${repr(value)}`
      const gap = definitionGap(value, found[key], `${path}.${key}`)
      if (gap !== undefined) return gap
    }
    return undefined
  }
  if (Array.isArray(wanted)) {
    if (wanted.length === 1 && isObject(found)) return definitionGap(wanted[0], found, path)
    if (!Array.isArray(found)) return `${path} is ${repr(found)} where this package declared the list ${repr(wanted)}`
    for (const entry of wanted) {
      if (!found.some((candidate) => definitionGap(entry, candidate, path) === undefined)) {
        return `${path} declares ${repr(entry)} and nothing reported at ${path} covers it`
      }
    }
    return undefined
  }
  return isDeepStrictEqual(wanted, found)
    ? undefined
    : `${path} is ${repr(found)} where this package declared ${repr(wanted)}`
}

/**
 * Create the collection without checking first.
 *
 * The driver's `createCollection` sends `create` directly, so a lost race arrives as code 48, which is
 * ignored. No options are passed: the collection gets the deployment's defaults, and no collation.
 */
async function createCollection(db: Db, collectionName: string, namespace: string): Promise<void> {
  try {
    await db.createCollection(collectionName)
  } catch (error) {
    if (!(error instanceof MongoError)) throw error
    if (serverCode(error) !== NAMESPACE_EXISTS) {
      throw new StorageError(`strands_mongodb: creating the collection ${namespace} failed: ${error.message}`, {
        cause: error,
      })
    }
  }
}

/**
 * Poll until every index reports READY, or until the deadline.
 *
 * Sleeps on a timer, so other work keeps running during a build. A status is logged when it changes, so a
 * long wait does not look like a hang. An index leaves `pending` only when it reports READY and its reported
 * definition still covers the declared one.
 *
 * @returns Undefined once every index is ready, or `<name> is <status>` for each one still pending at the
 *   deadline.
 */
async function waitUntilReady(
  collection: Collection,
  specs: readonly SearchIndexSpec[],
  namespace: string,
  options: { timeoutMs: number; intervalMs: number },
): Promise<string[] | undefined> {
  const deadline = performance.now() + options.timeoutMs
  const pending = new Map(specs.map((spec) => [spec.name, spec]))
  const last = new Map<string, string>()

  for (;;) {
    for (const [name, spec] of [...pending]) {
      const document = await readSearchIndex(collection, name, namespace)
      // A vanished index reads as building. Somebody else dropped it, and recreating it would race them.
      const status = document === undefined ? 'absent' : String(document.status ?? 'unreported')
      if (status !== last.get(name)) {
        logger.info(eventFields('search_index_status', { namespace }), SEARCH_INDEX_STATUS(name, namespace, status))
        last.set(name, status)
      }
      const state = readiness(status)
      if (state === 'failed') {
        throw new StorageError(BUILD_FAILED(collection.collectionName, namespace, spec, document ?? {}))
      }
      if (state === 'ready') {
        // Recheck: another actor may have dropped and recreated the index under the same name during the
        // wait, and an index this call created was never checked. A wrong definition makes searches
        // return nothing while every index is READY.
        checkDefinition(collection.collectionName, namespace, spec, document ?? {})
        pending.delete(name)
      }
    }
    if (pending.size === 0) return undefined
    if (performance.now() >= deadline) return [...pending.keys()].map((name) => `${name} is ${last.get(name)}`)
    await sleep(options.intervalMs)
  }
}

/** Run one driver call, turning a driver error into `StorageError` with the driver's error as the cause. */
async function guard<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof MongoError)) throw error
    throw new StorageError(`strands_mongodb: ${what} failed: ${error.message}`, { cause: error })
  }
}

/**
 * Every index on `collection`, or none when the collection does not exist yet.
 *
 * PyMongo's `index_information` answers an absent collection with an empty result. The Node driver passes
 * the server's NamespaceNotFound through instead, and a first `ensure` always meets one, so it reads as an
 * empty index set here. `createIndexes` then creates the collection along with the indexes.
 */
async function readIndexes(collection: Collection): Promise<Document[]> {
  try {
    return await collection.indexInformation({ full: true })
  } catch (error) {
    if (error instanceof MongoError && serverCode(error) === COLLECTION_ABSENT) return []
    throw error
  }
}

/** The server's code, when the error came from a server. */
function serverCode(error: MongoError): number | undefined {
  return error instanceof MongoServerError && typeof error.code === 'number' ? error.code : undefined
}

/** `<database>.<collection>`. */
function namespaceOf(collection: Collection): string {
  return `${collection.dbName}.${collection.collectionName}`
}

/** The database and collection, which every index span carries. */
function namespaceAttributes(collection: Collection): SpanAttributes {
  return { 'strands_mongodb.database': collection.dbName, 'strands_mongodb.collection': collection.collectionName }
}

/** A probe span's attributes: the namespace and what it probed. */
function probeAttributes(collection: Collection, probe: 'search' | 'rank_fusion' | 'collation'): SpanAttributes {
  return { ...namespaceAttributes(collection), 'strands_mongodb.indexes.probe': probe }
}

/** A key list as a message shows it. */
function keysOf(spec: IndexSpec): string {
  return pythonJson(spec.keys.map(([field, direction]) => [field, direction]))
}

/** The search probe answered with a code that does not mean "no search", so it is not read as one. */
const PROBE_FAILED = (namespace: string, error: MongoError): string =>
  `strands_mongodb: probing Atlas Search support on ${namespace} failed: ${error.message}`

/** Reading one search index failed for a reason other than the collection being absent. */
const READ_FAILED = (name: string, namespace: string, error: MongoError): string =>
  `strands_mongodb: reading search index ${repr(name)} on ${namespace} failed: ${error.message}`

/** Info: the ordinary indexes about to be created, in one call. */
const CREATING_INDEXES = (count: number, namespace: string, names: string): string =>
  `strands_mongodb: creating ${count} index(es) on ${namespace}: ${names}`

/** Info: one search index about to be created. */
const CREATING_SEARCH_INDEX = (spec: SearchIndexSpec, namespace: string): string =>
  `strands_mongodb: creating ${spec.type} index ${repr(spec.name)} on ${namespace}`

/** Info: a search index's status changed during the wait. Logged on change, so a long wait is not silent. */
const SEARCH_INDEX_STATUS = (name: string, namespace: string, status: string): string =>
  `strands_mongodb: search index ${repr(name)} on ${namespace} is ${status}`

/**
 * A unique index enforces uniqueness under a folding collation.
 *
 * Separate from {@link FOLDING_COLLATION} because here the declared index may already be present and
 * correct, so creating it does not help.
 */
const FOLDED_CONSTRAINT = (
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  foundName: string,
  locale: string,
): string =>
  `strands_mongodb: the index ${repr(foundName)} on ${namespace} covers the keys ${keysOf(spec)} ` +
  `that ${repr(spec.name)} needs, it is unique, and it was created with the collation ${repr(locale)}. The ` +
  `server enforces that uniqueness on the folded values, so two records differing only in the case ` +
  `of those keys collide as one -- and it goes on enforcing it whether or not a correctly collated ` +
  `index sits beside it, because an index's identity here is its keys and its collation together ` +
  `and the server keeps both indexes. This package queries and deduplicates with byte-for-byte ` +
  `comparison, so it cannot see that rule and cannot report it. Dropping this index is not this ` +
  `package's decision to make: it may be serving queries nothing here knows about. To resolve it, ` +
  `drop it, and create the declared index if it is not already there:\n` +
  `${dropIndexCommand(collectionName, foundName)}\n` +
  `${spec.creationCommand(collectionName)}\n`

/**
 * A matched index whose collation does not compare byte for byte.
 *
 * An index carries its own collation, so a collection with none can still hold a folding index, and the
 * rule it enforces is then the folded one.
 */
const FOLDING_COLLATION = (
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  foundName: string,
  locale: string,
): string =>
  `strands_mongodb: the index ${repr(foundName)} on ${namespace} covers the keys ${keysOf(spec)} ` +
  `that ${repr(spec.name)} needs, but it was created with the collation ${repr(locale)} and this package ` +
  `needs one that compares strings byte for byte. An index that folds case makes the rule it ` +
  `enforces the folded rule, which for ${repr(spec.name)} means two records differing only in case ` +
  `collide as one, and a query that compares exactly cannot use it at all. The server would let a ` +
  `second index be created over these keys under a different collation, but that does not help: ` +
  `both would exist and both would be enforced. Dropping this one is not this package's decision ` +
  `to make -- it may be serving queries nothing here knows about. To resolve it, drop the existing ` +
  `index and let the next call recreate it:\n` +
  `${dropIndexCommand(collectionName, foundName)}\n` +
  `${spec.creationCommand(collectionName)}\n`

/** A matched index lacks an option the declared one exists for, such as `unique` or `expireAfterSeconds`. */
const OPTION_MISMATCH = (
  collectionName: string,
  namespace: string,
  spec: IndexSpec,
  foundName: string,
  option: string,
  actual: string,
  wanted: unknown,
): string =>
  `strands_mongodb: the index ${repr(foundName)} on ${namespace} covers the keys ` +
  `${keysOf(spec)} that ${repr(spec.name)} needs, but its ${option} is ${actual} and this ` +
  `package needs ${repr(wanted)}. Creating a second index over the same keys under the same ` +
  `collation is rejected by the server whatever it is named, and dropping this one is not ` +
  `this package's decision to make: it may be serving queries nothing here knows about. To ` +
  `resolve it, drop the existing index and let the next call recreate it:\n` +
  `${dropIndexCommand(collectionName, foundName)}\n` +
  `${spec.creationCommand(collectionName)}\n`

/** Verify-only found ordinary indexes absent. Every one is listed, with the command that creates it. */
const MISSING_ORDINARY = (collectionName: string, namespace: string, missing: readonly IndexSpec[]): string =>
  `strands_mongodb: ${missing.length} required index(es) are absent from ${namespace} and ` +
  `ensureIndexes is false, so nothing was created. Run these against the database as somebody ` +
  `holding the rights to, then call initialize() again:\n` +
  `${missing.map((spec) => spec.creationCommand(collectionName)).join('\n')}\n` +
  `Absent: ${missing.map((spec) => spec.name).join(', ')}.`

/** Verify-only found search indexes absent. A search against an absent one returns nothing, so this is loud. */
const MISSING_SEARCH = (collectionName: string, namespace: string, missing: readonly SearchIndexSpec[]): string =>
  `strands_mongodb: ${missing.length} required search index(es) are absent from ${namespace} and ` +
  `ensureIndexes is false, so nothing was created. A search against an absent index returns ` +
  `no results rather than an error, so this is reported instead of ignored. Run these, wait for ` +
  `each to report status READY, then call initialize() again:\n` +
  `${missing.map((spec) => spec.creationCommand(collectionName)).join('\n')}\n` +
  `Absent: ${missing.map((spec) => spec.name).join(', ')}.`

/**
 * A search build reports FAILED.
 *
 * Reported rather than recreated: issuing the same definition over a failed build is accepted but does not
 * restart it. `statusDetail` is rendered whole, since its shape varies by host and index.
 */
const BUILD_FAILED = (collectionName: string, namespace: string, spec: SearchIndexSpec, document: Document): string =>
  `strands_mongodb: the ${spec.type} index ${repr(spec.name)} on ${namespace} reports status FAILED, ` +
  `so searches against it return nothing rather than an error. The server's detail: ` +
  `${JSON.stringify(document.statusDetail ?? [])}. ` +
  `A failed build does not restart when the same definition is issued again, so it has to be ` +
  `dropped and recreated:\n` +
  `${spec.dropCommand(collectionName)}\n` +
  `${spec.creationCommand(collectionName)}\n`

/** An existing search index's definition does not cover the declared one. */
const DEFINITION_GAP = (
  collectionName: string,
  namespace: string,
  spec: SearchIndexSpec,
  gap: string,
  reported: unknown,
): string =>
  `strands_mongodb: the ${spec.type} index ${repr(spec.name)} on ${namespace} already exists and its ` +
  `definition does not cover the one this package needs: ${gap}. Reported: ${repr(reported)}. A ` +
  `search index cannot be redefined in place, and dropping it discards a build somebody may be ` +
  `querying, so the remedy is left here rather than taken:\n` +
  `${spec.dropCommand(collectionName)}\n` +
  `${spec.creationCommand(collectionName)}\n`

/** The wait ran out with builds still pending. What to do next depends on the store's search type. */
const NOT_READY = (timeoutMs: number, stuck: readonly string[], namespace: string, collectionName: string): string =>
  `strands_mongodb: waited ${timeoutMs / 1000}s for ${stuck.length} search index(es) on ` +
  `${namespace} to report READY and they did not: ${stuck.join(', ')}. BUILDING at this point means ` +
  `a build slower than the timeout. A store with a named searchType can call initialize() ` +
  `again to keep waiting; under 'auto' the store answers from its other tiers and tries this one ` +
  `again later. Any other status is worth reading directly with ` +
  `db.${collectionName}.getSearchIndexes().`
