/**
 * Ordinary indexes against a real deployment: the premises the fakes are built from, and `ensure` end to end.
 *
 * Ports the contract classes of `python/tests/test_indexes.py`. The unit tier encodes measured server
 * behaviour in a fake; these tests stop that encoding drifting from the server. They assert outcomes rather
 * than error codes, so a server upgrade that renumbers a conflict fails here rather than in production.
 *
 * Only AT-065 is a checklist item. The rest lead with `TS-` ids: AT-193 is TS-060, AT-060, AT-061, AT-063
 * and AT-064 are TS-061, AT-196 is TS-062 and AT-197 is TS-063.
 */
import { MongoServerError } from 'mongodb'
import type { Collection, Document } from 'mongodb'
import { StorageError } from '@strands-agents/sdk'
import { expect, it } from 'vitest'

import { ensure } from '../../src/index-lifecycle.js'
import { type IndexSpec, memorySpecs, storageSpecs } from '../../src/indexes.js'
import { useDeployment, uniqueName } from '../support/deployment.js'
import { FakeCollection } from '../support/fake-indexes.js'
import { describeTier } from '../support/tiers.js'

/** A collation that folds case, as an operator's own tooling might set one. */
const FOLDING = { locale: 'en', strength: 2 }

/** The unique partial index the dedup constraint rests on. */
function dedupSpec(): IndexSpec {
  const spec = memorySpecs().find((candidate) => candidate.options.unique === true)
  if (spec === undefined) throw new Error('memorySpecs declares no unique index')
  return spec
}

/** The TTL index both surfaces declare. */
function ttlSpec(): IndexSpec {
  return storageSpecs()[0] as IndexSpec
}

/** Every index on `collection`, keyed by name, as the server reports it. */
async function indexes(collection: Collection): Promise<Record<string, Document>> {
  const listed = await collection.indexInformation({ full: true })
  return Object.fromEntries(listed.map((index) => [index.name as string, index]))
}

describeTier('contract', 'TS-060 — a collated index against a real deployment: the premises, and the refusal', () => {
  const deployment = useDeployment('contract')
  const fresh = (): Collection => deployment().db.collection(uniqueName('c_'))

  it('TS-060 — the server reports an index collation where the check reads it', async () => {
    const collection = fresh()
    const dedup = dedupSpec()
    await collection.createIndexes([{ key: dedup.key, name: 'theirs', ...dedup.options, collation: FOLDING }])

    const found = (await indexes(collection)).theirs

    expect(found?.collation?.locale).toBe('en')
  })

  it('TS-060 — an uncollated index reports no collation at all', async () => {
    const collection = fresh()
    const dedup = dedupSpec()
    await collection.createIndexes([dedup.description() as never])

    expect((await indexes(collection))[dedup.name]).not.toHaveProperty('collation')
  })

  it('TS-060 — ensure refuses the folded index and creates nothing', async () => {
    const collection = fresh()
    const dedup = dedupSpec()
    await collection.createIndexes([{ key: dedup.key, name: 'theirs', ...dedup.options, collation: FOLDING }])
    const before = await indexes(collection)

    const error = await ensure(deployment().db, collection, { ordinary: [dedup] }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StorageError)
    expect((error as Error).message).toContain('collation')
    expect(await indexes(collection)).toEqual(before)
  })

  it('TS-060 — two records differing only in case collide on the folded index', async () => {
    const collection = fresh()
    await collection.createIndexes([{ key: { content_hash: 1 }, name: 'folded', unique: true, collation: FOLDING }])
    await collection.insertOne({ content_hash: 'Remember-X' })

    await expect(collection.insertOne({ content_hash: 'remember-x' })).rejects.toMatchObject({ code: 11000 })

    // If this finds a document, the deployment did not fold the index, and this block checks nothing.
    expect(await collection.findOne({ content_hash: 'remember-x' })).toBeNull()
  })
})

describeTier('contract', 'TS-061 — ordinary indexes against a server that answers for itself', () => {
  const deployment = useDeployment('contract')
  const fresh = (): Collection => deployment().db.collection(uniqueName('c_'))

  it('TS-061 — every declared index is created, and createIndexes creates the collection implicitly', async () => {
    const collection = fresh()

    await ensure(deployment().db, collection, { ordinary: memorySpecs() })

    const keys = Object.values(await indexes(collection)).map((index) => JSON.stringify(index.key))
    for (const spec of memorySpecs()) expect(keys).toContain(JSON.stringify(spec.key))
  })

  it('TS-061 — a second ensure creates nothing and throws nothing', async () => {
    const collection = fresh()
    await ensure(deployment().db, collection, { ordinary: memorySpecs() })
    const before = await indexes(collection)

    await ensure(deployment().db, collection, { ordinary: memorySpecs() })

    expect(await indexes(collection)).toEqual(before)
  })

  it('TS-061 — an index under a foreign name with our options is accepted', async () => {
    const collection = fresh()
    const spec = ttlSpec()
    await collection.createIndexes([{ key: spec.key, name: 'their_own_ttl', expireAfterSeconds: 0 }])

    await ensure(deployment().db, collection, { ordinary: [spec] })

    const names = Object.keys(await indexes(collection))
    expect(names).toContain('their_own_ttl')
    expect(names).not.toContain(spec.name)
  })

  it('TS-061 — the server rejects a second index over the same keys, which is why matching is on keys', async () => {
    const collection = fresh()
    const spec = ttlSpec()
    await collection.createIndexes([{ key: spec.key, name: 'their_own_ttl', expireAfterSeconds: 0 }])

    await expect(collection.createIndexes([spec.description() as never])).rejects.toBeInstanceOf(MongoServerError)
  })

  it('TS-061 — an index missing the option it exists for is reported', async () => {
    const collection = fresh()
    const dedup = dedupSpec()
    await collection.createIndexes([{ key: dedup.key, name: 'just_for_speed' }])

    const error = (await ensure(deployment().db, collection, { ordinary: [dedup] }).catch((e: unknown) => e)) as Error

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('unique')
    expect(error.message).toContain('just_for_speed')
  })

  it('TS-061 — a TTL index with a different expiry is reported', async () => {
    const collection = fresh()
    const spec = ttlSpec()
    await collection.createIndexes([{ key: spec.key, name: 'theirs', expireAfterSeconds: 3600 }])

    await expect(ensure(deployment().db, collection, { ordinary: [spec] })).rejects.toThrow(/expireAfterSeconds/)
  })

  it('TS-061 — verify-only creates nothing, not even the collection', async () => {
    const collection = fresh()

    const error = (await ensure(deployment().db, collection, { ordinary: memorySpecs(), create: false }).catch(
      (e: unknown) => e,
    )) as Error

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('ensureIndexes is false')
    expect(error.message).toContain(collection.collectionName)
    const names = (await deployment().db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names).not.toContain(collection.collectionName)
  })

  it('TS-061 — the commands in the verify-only error actually create the indexes', async () => {
    const collection = fresh()
    const specs = memorySpecs()
    const error = (await ensure(deployment().db, collection, { ordinary: specs, create: false }).catch(
      (e: unknown) => e,
    )) as Error

    const commands = [...error.message.matchAll(/db\.runCommand\((\{.*?\})\)\n/g)].map((match) => match[1] as string)
    expect(commands, error.message).toHaveLength(specs.length)
    for (const command of commands) await deployment().db.command(JSON.parse(command) as Document)

    await ensure(deployment().db, collection, { ordinary: specs, create: false })
  })

  it('TS-061 — the driver passes NamespaceNotFound through for an absent collection, as the fake does', async () => {
    const collection = fresh()

    await expect(collection.indexInformation({ full: true })).rejects.toMatchObject({ code: 26 })
    await expect(new FakeCollection({ exists: false }).indexInformation({ full: true })).rejects.toMatchObject({
      code: 26,
    })
  })

  it('TS-061 — the fake reports indexInformation the way the driver does', async () => {
    const collection = fresh()
    const spec = ttlSpec()
    await collection.createIndexes([spec.description() as never])
    const real = (await indexes(collection))[spec.name] as Document

    const fake = new FakeCollection()
    await fake.createIndexes([spec.description()])
    const mocked = (await fake.indexInformation({ full: true })).find((index) => index.name === spec.name) as Document

    expect(new Set(Object.keys(real))).toEqual(new Set(Object.keys(mocked)))
    expect(real.key).toEqual(mocked.key)
  })
})

describeTier('contract', 'AT-065 — concurrent ensures across stores make one index set', () => {
  const deployment = useDeployment('contract')

  it('AT-065 — ten concurrent ensures produce one index set and no failures', async () => {
    // No lock, which is stronger than a locked version: the check-then-create window is left wide open,
    // and it is benign, because ten identical createIndexes calls make one index. Tolerating a concurrent
    // creator rests on the server's idempotency rather than on a catch that would also swallow a genuine
    // option mismatch. The initialize() half lands with the memory store.
    const collection = deployment().db.collection(uniqueName('c_'))
    const specs = memorySpecs()

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ensure(deployment().db, collection, { ordinary: specs })),
    )

    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    // `_id_` plus one per spec, and no duplicates under other names.
    expect(Object.keys(await indexes(collection))).toHaveLength(specs.length + 1)
  })
})

describeTier('contract', 'TS-062 — competing indexes over one key list, against a real deployment', () => {
  const deployment = useDeployment('contract')
  const fresh = (): Collection => deployment().db.collection(uniqueName('c_'))

  /** Build the declared dedup index and a folding unique index over the same keys. */
  async function both(collection: Collection): Promise<IndexSpec> {
    const dedup = dedupSpec()
    await collection.createIndexes([dedup.description() as never])
    await collection.createIndexes([{ key: dedup.key, name: 'folding_unique', ...dedup.options, collation: FOLDING }])
    return dedup
  }

  it('TS-062 — the server keeps both indexes over one key list', async () => {
    const collection = fresh()
    const dedup = await both(collection)

    const overThoseKeys = Object.values(await indexes(collection))
      .filter((index) => JSON.stringify(index.key) === JSON.stringify(dedup.key))
      .map((index) => index.name as string)

    expect(overThoseKeys.sort()).toEqual(['folding_unique', dedup.name].sort())
  })

  it('TS-062 — ensure refuses a deployment the declared index is correct on', async () => {
    const collection = fresh()
    const dedup = await both(collection)
    const before = await indexes(collection)

    const error = (await ensure(deployment().db, collection, { ordinary: [dedup] }).catch((e: unknown) => e)) as Error

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('folding_unique')
    expect(await indexes(collection)).toEqual(before)
  })

  it('TS-062 — the folded constraint refuses a write the declared index allows', async () => {
    const collection = fresh()
    await both(collection)
    await collection.insertOne({ scope: 'Tenant-A', store_name: 's', content_hash: 'h' })

    const error = await collection
      .insertOne({ scope: 'tenant-a', store_name: 's', content_hash: 'h' })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 11000 })
    expect((error as Error).message).toContain('folding_unique')
  })

  it('TS-062 — the declared index alone accepts that same write', async () => {
    const collection = fresh()
    await collection.createIndexes([dedupSpec().description() as never])
    await collection.insertOne({ scope: 'Tenant-A', store_name: 's', content_hash: 'h' })

    await collection.insertOne({ scope: 'tenant-a', store_name: 's', content_hash: 'h' })

    expect(await collection.countDocuments({})).toBe(2)
  })
})

describeTier('contract', 'TS-063 — a collated TTL index against a real deployment', () => {
  const deployment = useDeployment('contract')
  const fresh = (): Collection => deployment().db.collection(uniqueName('c_'))

  /** Build the TTL index under a folding collation, as an operator's own tooling might have. */
  async function collatedTtl(collection: Collection): Promise<IndexSpec> {
    const spec = ttlSpec()
    await collection.createIndexes([{ key: spec.key, name: spec.name, ...spec.options, collation: FOLDING }])
    return spec
  }

  it('TS-063 — the server builds a collated TTL index at all', async () => {
    const collection = fresh()
    const spec = await collatedTtl(collection)

    const found = (await indexes(collection))[spec.name]

    expect(found?.collation?.locale).toBe('en')
    expect(found?.expireAfterSeconds).toBe(0)
  })

  it('TS-063 — ensure accepts it', async () => {
    const collection = fresh()
    const spec = await collatedTtl(collection)
    const before = await indexes(collection)

    await ensure(deployment().db, collection, { ordinary: [spec] })

    expect(await indexes(collection)).toEqual(before)
  })

  it('TS-063 — a collated index on the dedup keys is still refused', async () => {
    const collection = fresh()
    const dedup = dedupSpec()
    await collection.createIndexes([{ key: dedup.key, name: 'theirs', ...dedup.options, collation: FOLDING }])

    await expect(ensure(deployment().db, collection, { ordinary: [dedup] })).rejects.toBeInstanceOf(StorageError)
  })
})
