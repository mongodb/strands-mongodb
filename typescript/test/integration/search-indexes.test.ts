/**
 * Search indexes against a deployment that runs `mongot`: the asynchronous build, which no fake can prove.
 *
 * Ports `TestSearchIndexesAgainstAtlas` from `python/tests/test_indexes.py`. AT-062a/b/c, AT-066 and AT-068
 * are not checklist items, so every title here leads with TS-064.
 *
 * Every test uses the manual-vector mode. An `autoEmbed` definition fails at creation on an Atlas CLI local
 * deployment, with code 8 and "CanonicalModel ... not registered yet", and `MONGODB_ATLAS_URI` may name such
 * a deployment. The `autoembed` tier exists to require a cluster that accepts one.
 */
import type { Collection, Document, SearchIndexDescription } from 'mongodb'
import { StorageError } from '@strands-agents/sdk'
import { expect, it } from 'vitest'

import { ensure } from '../../src/index-lifecycle.js'
import { memorySearchSpecs, readiness, type SearchIndexSpec } from '../../src/indexes.js'
import { useDeployment, uniqueName } from '../support/deployment.js'
import { describeTier } from '../support/tiers.js'

/** The manual-vector config, which every deployment with `mongot` accepts. */
const MANUAL_VECTOR = { database: 'unused', embeddingDimensions: 4, similarity: 'cosine' as const }

/** The driver's description of `spec`, as `createSearchIndex` takes it. */
function described(spec: SearchIndexSpec): SearchIndexDescription {
  return { name: spec.name, type: spec.type, definition: { ...spec.definition } }
}

/** Every search index on `collection`, or the one named. */
async function searchIndexes(collection: Collection, name?: string): Promise<Document[]> {
  const cursor = name === undefined ? collection.listSearchIndexes() : collection.listSearchIndexes(name)
  return cursor.toArray()
}

/**
 * The definition version, under whichever key carries it.
 *
 * An Atlas CLI local deployment sends `latestVersion` as a number. Cloud Atlas sends
 * `latestDefinitionVersion` as `{ createdAt, version }`, and neither sends the other's key.
 */
function reportedVersion(index: Document): number {
  if (typeof index.latestVersion === 'number') return index.latestVersion
  const version = (index.latestDefinitionVersion as Document | undefined)?.version
  if (typeof version !== 'number') throw new Error(`no definition version in ${JSON.stringify(index)}`)
  return version
}

describeTier('integration', 'TS-064 — search indexes against a deployment with mongot', () => {
  const deployment = useDeployment('integration')
  const fresh = (suffix = ''): Collection => deployment().db.collection(`${uniqueName('c_')}${suffix}`)
  const collectionNames = async (): Promise<string[]> =>
    (await deployment().db.listCollections({}, { nameOnly: true }).toArray()).map((found) => found.name)

  it('TS-064 — a missing search index is created and reaches READY, and ensure creates the collection first', async () => {
    const collection = fresh()
    const specs = memorySearchSpecs(MANUAL_VECTOR)

    await ensure(deployment().db, collection, { search: specs })

    const states = Object.fromEntries((await searchIndexes(collection)).map((index) => [index.name, index.status]))
    expect(states).toEqual(Object.fromEntries(specs.map((spec) => [spec.name, 'READY'])))
  })

  it('TS-064 — createSearchIndex needs the collection to exist, which is why ensure creates it first', async () => {
    // createIndexes in the same position creates the collection implicitly, so the asymmetry is asserted.
    const ghost = fresh('_ghost')

    await expect(ghost.createSearchIndex(described(memorySearchSpecs(MANUAL_VECTOR)[0]))).rejects.toMatchObject({
      code: 26,
    })
  })

  it('TS-064 — ensure accepts a collection that already exists', async () => {
    // The code-48 handler is defence in depth: some server versions refuse a second create, and some accept it.
    const collection = fresh()
    await deployment().db.createCollection(collection.collectionName)

    await ensure(deployment().db, collection, { search: memorySearchSpecs(MANUAL_VECTOR) })

    expect(await searchIndexes(collection)).toHaveLength(2)
  })

  it('TS-064 — a second ensure issues nothing, so the definition versions are unchanged', async () => {
    const collection = fresh()
    const specs = memorySearchSpecs(MANUAL_VECTOR)
    await ensure(deployment().db, collection, { search: specs })
    const versions = async (): Promise<Array<[string, number]>> =>
      (await searchIndexes(collection)).map((index) => [index.name as string, reportedVersion(index)])
    const before = await versions()

    await ensure(deployment().db, collection, { search: specs })

    expect(before, 'nothing was listed, so an unchanged listing proves nothing').not.toEqual([])
    expect(await versions()).toEqual(before)
  })

  it('TS-064 — verify-only reports a missing search index with its command, and creates no collection', async () => {
    const collection = fresh()

    const error = (await ensure(deployment().db, collection, {
      search: memorySearchSpecs(MANUAL_VECTOR),
      create: false,
    }).catch((e: unknown) => e)) as Error

    expect(error).toBeInstanceOf(StorageError)
    expect(error.message).toContain('createSearchIndex')
    expect(await collectionNames()).not.toContain(collection.collectionName)
  })

  it('TS-064 — a building index is waited out rather than reported missing or ready', async (context) => {
    // Catching an index mid-build is a race. On a local deployment READY arrives within a fraction of a
    // second, so the scenario retries on a fresh collection. Python skips when the race is never won; this
    // suite never skips, so the outcome is recorded as an annotation and the READY path is still asserted.
    const spec = memorySearchSpecs(MANUAL_VECTOR)[0]
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const collection = fresh(`_${attempt}`)
      await deployment().db.createCollection(collection.collectionName)
      await collection.createSearchIndex(described(spec))

      const observed = await searchIndexes(collection, spec.name)
      const status = observed[0]?.status as string | undefined
      if (status !== undefined && status !== 'READY') {
        expect(readiness(status)).toBe('building')
        await ensure(deployment().db, collection, { search: [spec], create: false })
        return
      }
      if (attempt === 2) {
        await ensure(deployment().db, collection, { search: [spec], create: false })
        await context.annotate(
          'the vector index reached READY before the first poll on all 3 attempts, so the building state ' +
            'was not observable on this deployment; only the READY path was exercised',
          'notice',
        )
      }
    }
  })

  it('TS-064 — polling a real build leaves the event loop running', async () => {
    // Asserted against a real build, because the interval that matters is the one the module chose.
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 10)
    try {
      await ensure(deployment().db, fresh(), { search: memorySearchSpecs(MANUAL_VECTOR) })
    } finally {
      clearInterval(ticker)
    }

    expect(ticks).toBeGreaterThan(1)
  })

  it('TS-064 — the real cursor yields the keys the fake promises', async () => {
    const collection = fresh()
    await ensure(deployment().db, collection, { search: memorySearchSpecs(MANUAL_VECTOR) })

    const documents = await searchIndexes(collection)

    expect(documents).not.toEqual([])
    for (const document of documents) {
      expect(Object.keys(document)).toEqual(expect.arrayContaining(['name', 'status', 'queryable', 'latestDefinition']))
    }
  })

  it('TS-064 — the vector definition the server reports back is the one sent', async () => {
    const collection = fresh()
    const spec = memorySearchSpecs(MANUAL_VECTOR)[0]
    await ensure(deployment().db, collection, { search: [spec] })

    const [reported] = await searchIndexes(collection, spec.name)

    expect(reported?.latestDefinition).toEqual(spec.definition)
  })

  it('TS-064 — the text definition is covered, whether or not the server rewrites it', async () => {
    // mongot may collapse the one-element list and add indexOptions, store and norms; Atlas may return it
    // verbatim. Containment is what ensure rests on, so a verify-only ensure must pass on either shape.
    const collection = fresh()
    const spec = memorySearchSpecs(MANUAL_VECTOR)[1]
    await ensure(deployment().db, collection, { search: [spec] })

    await ensure(deployment().db, collection, { search: [spec], create: false })

    const [reported] = await searchIndexes(collection, spec.name)
    const definition = reported?.latestDefinition as Document
    const mapped = (definition.mappings as Document).fields.content as Document | Document[]
    if (JSON.stringify(definition) === JSON.stringify(spec.definition)) {
      expect(mapped).toEqual([{ type: 'string' }])
    } else {
      expect(Array.isArray(mapped)).toBe(false)
      expect((mapped as Document).type).toBe('string')
      expect(Object.keys(mapped)).toEqual(expect.arrayContaining(['indexOptions', 'store', 'norms']))
    }
  })
})
