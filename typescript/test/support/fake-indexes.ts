/**
 * A fake collection and database narrowed to the calls `index-lifecycle.ts` makes.
 *
 * Ported from the fakes in `python/tests/test_indexes.py`. The shapes are the driver's, which
 * `index-lifecycle.test.ts` checks against the real classes and the contract tier checks against a server:
 * `indexInformation({ full: true })` reports the raw `listIndexes` documents, and `listSearchIndexes`
 * returns its cursor synchronously and fails, if it fails, while being iterated.
 */
import { MongoNetworkTimeoutError, MongoServerError } from 'mongodb'
import type { Collection, Db, Document } from 'mongodb'

/** One programmed read: the documents a `listSearchIndexes` call yields, or an error it throws. */
export type SearchRead = Document[] | Error

/** The database half: `createCollection` and `command`, each counted. */
export class FakeDatabase {
  readonly createCollectionCalls: Array<[string, unknown]> = []
  readonly commandCalls: Document[] = []
  createError: Error | undefined
  commandError: Error | undefined
  buildInfo: unknown

  /**
   * @param databaseName - The database name.
   * @param versionArray - What `buildInfo` reports. 8.0.23 unless a test says otherwise.
   */
  constructor(
    readonly databaseName = 'testdb',
    versionArray: unknown = [8, 0, 23, 0],
  ) {
    this.buildInfo = { versionArray }
  }

  async createCollection(name: string, options?: unknown): Promise<unknown> {
    this.createCollectionCalls.push([name, options])
    if (this.createError !== undefined) throw this.createError
    return {}
  }

  async command(command: Document): Promise<unknown> {
    this.commandCalls.push(command)
    if (this.commandError !== undefined) throw this.commandError
    return this.buildInfo
  }

  /** The fake typed as the driver's class, for the functions under test. */
  get db(): Db {
    return this as unknown as Db
  }
}

/** The collection half: the four index calls, with programmable search-index reads. */
export class FakeCollection {
  readonly createdIndexes: Document[][] = []
  readonly createdSearchIndexes: Document[] = []
  indexes: Document[]
  indexError: Error | undefined
  createIndexesError: Error | undefined
  createSearchIndexError: Error | undefined
  /**
   * Reads per index name, with `*` for a call that names none. The last one repeats, so a test programs a
   * build's transitions in order.
   */
  readonly searchStates: Map<string, SearchRead[]>
  readonly searchReads = new Map<string, number>()
  /**
   * Whether the collection exists. The server refuses `listIndexes` on one that does not, with
   * NamespaceNotFound, and `createIndexes` creates it.
   */
  exists: boolean

  constructor(
    options: {
      collectionName?: string
      dbName?: string
      indexes?: Document[]
      searchStates?: Record<string, SearchRead[]>
      exists?: boolean
    } = {},
  ) {
    this.exists = options.exists ?? true
    this.collectionName = options.collectionName ?? 'memory'
    this.dbName = options.dbName ?? 'testdb'
    this.indexes = [...(options.indexes ?? [])]
    this.searchStates = new Map(Object.entries(options.searchStates ?? {}))
  }

  readonly collectionName: string
  readonly dbName: string

  async indexInformation(options: { full: true }): Promise<Document[]> {
    if (options?.full !== true) throw new Error('the fake answers only indexInformation({ full: true })')
    if (this.indexError !== undefined) throw this.indexError
    if (!this.exists) throw serverError(26, `ns does not exist: ${this.dbName}.${this.collectionName}`)
    return this.indexes.map((index) => structuredClone(index))
  }

  async createIndexes(descriptions: Document[]): Promise<string[]> {
    this.createdIndexes.push(descriptions)
    if (this.createIndexesError !== undefined) throw this.createIndexesError
    this.exists = true
    for (const description of descriptions) this.indexes.push({ v: 2, ...structuredClone(description) })
    return descriptions.map((description) => description.name as string)
  }

  listSearchIndexes(name?: string): AsyncIterable<Document> {
    name ??= '*'
    const states = this.searchStates.get(name) ?? [[]]
    const read = this.searchReads.get(name) ?? 0
    this.searchReads.set(name, read + 1)
    const state = states[Math.min(read, states.length - 1)] as SearchRead
    return {
      async *[Symbol.asyncIterator]() {
        if (state instanceof Error) throw state
        yield* state
      },
    }
  }

  async createSearchIndex(description: Document): Promise<string> {
    this.createdSearchIndexes.push(description)
    if (this.createSearchIndexError !== undefined) throw this.createSearchIndexError
    const name = description.name as string
    if (!this.searchStates.has(name)) this.searchStates.set(name, [[{ name, status: 'READY', queryable: true }]])
    return name
  }

  /** How many times `listSearchIndexes` was called for `name`. */
  readsOf(name: string): number {
    return this.searchReads.get(name) ?? 0
  }

  /** The fake typed as the driver's class, for the functions under test. */
  get collection(): Collection {
    return this as unknown as Collection
  }
}

/** A real server error carrying `code`, as the driver would throw it. */
export function serverError(code: number, message = 'probed'): MongoServerError {
  return new MongoServerError({ message, errmsg: message, code, ok: 0 })
}

/** A driver error that never reached a server, so it carries no code. */
export function networkError(message = 'socket timed out'): MongoNetworkTimeoutError {
  return new MongoNetworkTimeoutError(message)
}

/** One index as `listIndexes` reports it, including the `v` nobody asked for. */
export function existing(name: string, key: Document, options: Document = {}): Document {
  return { v: 2, key, name, ...options }
}

/**
 * Program one search index's successive reads from a status sequence.
 *
 * @param name - The index name the poll loop asks for.
 * @param statuses - One status per read. `''` means the index is absent on that read.
 * @param definition - What `latestDefinition` reports, when the caller cares.
 * @returns A `searchStates` entry for {@link FakeCollection}.
 */
export function searchStates(name: string, statuses: string[], definition?: Document): Record<string, SearchRead[]> {
  return {
    [name]: statuses.map((status) =>
      status === ''
        ? []
        : [
            {
              name,
              status,
              queryable: status === 'READY',
              ...(definition !== undefined ? { latestDefinition: definition } : {}),
            },
          ],
    ),
  }
}
