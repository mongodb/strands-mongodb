/**
 * A fake database and collection narrowed to the calls `MongoDBStorage` makes, injected through
 * `config.client`.
 *
 * Ported from the fakes in `python/tests/test_storage.py`. The shapes are the driver's, which
 * `test/unit/storage.test.ts` checks against the real classes and the contract tier checks against a server:
 * `find` and `aggregate` return their cursor synchronously and fail, if they fail, while being drained;
 * `listCollections` does the same; the write and delete calls return promises.
 */
import type { Collection, Db, Document, MongoClient } from 'mongodb'

/** One recorded call: the method's name and its arguments. */
export type Call = [string, unknown[]]

/** A cursor over fixed documents: `sort` is recorded and ignored, and an error is thrown after the documents. */
export class FakeCursor implements AsyncIterable<Document> {
  readonly sortCalls: Document[] = []

  constructor(
    private readonly documents: Document[],
    private readonly failure: Error | undefined,
  ) {}

  sort(sort: Document): this {
    this.sortCalls.push(sort)
    return this
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Document> {
    yield* this.documents
    if (this.failure !== undefined) throw this.failure
  }
}

/** The collection half: the six storage calls, plus the two index calls `ensure` makes. */
export class FakeStorageCollection {
  readonly documents = new Map<string, Document>()
  /** Thrown by every call, after it is recorded. */
  error: Error | undefined
  /** Thrown by a `find` or `aggregate` cursor after its documents, the drain failure. */
  iterationError: Error | undefined
  /** What `aggregate` yields. */
  aggregateResult: Document[] = []
  indexes: Document[] = [{ v: 2, key: { _id: 1 }, name: '_id_' }]
  readonly pipelines: Document[][] = []
  readonly calls: Call[] = []
  readonly cursors: FakeCursor[] = []

  constructor(
    readonly collectionName: string,
    readonly dbName: string,
  ) {}

  /** The method names called, in order. */
  get namesCalled(): string[] {
    return this.calls.map(([name]) => name)
  }

  async replaceOne(filter: Document, document: Document, options?: Document): Promise<Document> {
    this.record('replaceOne', filter, document, options)
    this.documents.set(document._id as string, structuredClone(document))
    return { acknowledged: true }
  }

  async findOne(filter: Document): Promise<Document | null> {
    this.record('findOne', filter)
    return this.matching(filter)[0] ?? null
  }

  async deleteOne(filter: Document): Promise<{ deletedCount: number }> {
    this.record('deleteOne', filter)
    const [found] = this.matching(filter)
    if (found === undefined) return { deletedCount: 0 }
    this.documents.delete(found._id as string)
    return { deletedCount: 1 }
  }

  async deleteMany(filter: Document): Promise<{ deletedCount: number }> {
    this.record('deleteMany', filter)
    const found = this.matching(filter)
    for (const document of found) this.documents.delete(document._id as string)
    return { deletedCount: found.length }
  }

  find(filter: Document, options?: Document): FakeCursor {
    this.record('find', filter, options)
    const projected = this.matching(filter)
      .map((document) => ({ _id: document._id as string }))
      .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
    const cursor = new FakeCursor(projected, this.iterationError)
    this.cursors.push(cursor)
    return cursor
  }

  aggregate(pipeline: Document[]): FakeCursor {
    this.record('aggregate', pipeline)
    this.pipelines.push(pipeline)
    const cursor = new FakeCursor(this.aggregateResult, this.iterationError)
    this.cursors.push(cursor)
    return cursor
  }

  async indexInformation(options: { full: true }): Promise<Document[]> {
    this.record('indexInformation', options)
    return this.indexes.map((index) => structuredClone(index))
  }

  async createIndexes(descriptions: Document[]): Promise<string[]> {
    this.record('createIndexes', descriptions)
    for (const description of descriptions) this.indexes.push({ v: 2, ...structuredClone(description) })
    return descriptions.map((description) => description.name as string)
  }

  /** The fake typed as the driver's class. */
  get collection(): Collection {
    return this as unknown as Collection
  }

  /** Equality on `_id`, or the `$gte`/`$lt` range `rangeFor` builds, or everything for `{}`. */
  private matching(filter: Document): Document[] {
    const all = [...this.documents.values()]
    const id: unknown = filter._id
    if (id === undefined) return all
    if (typeof id === 'string') return all.filter((document) => document._id === id)
    const range = id as { $gte?: string; $lt?: string }
    return all.filter((document) => {
      const key = document._id as string
      return (range.$gte === undefined || key >= range.$gte) && (range.$lt === undefined || key < range.$lt)
    })
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, args])
    if (this.error !== undefined) throw this.error
  }
}

/** The database half: `listCollections` for the collation check, and one fake collection per name. */
export class FakeStorageDatabase {
  readonly listCollectionsFilters: Document[] = []
  /** The collection's default collation, or none. */
  collation: Document | undefined
  /** Whether `listCollections` reports no collection at all. */
  absent: boolean
  /** Thrown while `listCollections` is drained. */
  listError: Error | undefined
  private readonly collections = new Map<string, FakeStorageCollection>()

  constructor(options: { databaseName?: string; collation?: Document; absent?: boolean } = {}) {
    this.databaseName = options.databaseName ?? 'appdb'
    this.collation = options.collation
    this.absent = options.absent ?? false
  }

  readonly databaseName: string

  get listCollectionsCalls(): number {
    return this.listCollectionsFilters.length
  }

  listCollections(filter: Document): AsyncIterable<Document> {
    this.listCollectionsFilters.push(filter)
    const { absent, collation, listError } = this
    return {
      async *[Symbol.asyncIterator]() {
        if (listError !== undefined) throw listError
        if (!absent) yield { name: filter.name as string, options: collation === undefined ? {} : { collation } }
      },
    }
  }

  collection(name: string): FakeStorageCollection {
    let found = this.collections.get(name)
    if (found === undefined) {
      found = new FakeStorageCollection(name, this.databaseName)
      this.collections.set(name, found)
    }
    return found
  }

  /** The fake typed as the driver's class. */
  get db(): Db {
    return this as unknown as Db
  }

  /**
   * A client whose `db()` is this database, for `config.client`. One object per fake, because the registry
   * keys an injected client by identity. Never closed by the package.
   */
  readonly client: MongoClient = {
    appendMetadata() {},
    options: {},
    db: () => this,
    close: async () => {},
  } as unknown as MongoClient
}
