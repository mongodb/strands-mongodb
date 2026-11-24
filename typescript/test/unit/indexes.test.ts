/**
 * Index specs, definitions and the command renderer.
 *
 * Ports the first half of `python/tests/test_indexes.py`: the vector mode, both search definitions, the
 * ordinary and search inventories and the commands handed to an operator. The second half, which drives
 * `ensure` and the probes against a fake collection, is `index-lifecycle.test.ts`.
 *
 * The last block is the cross-language check from spec §6: the commands rendered here must equal the
 * `<!-- run: mongosh -->` block in `python/README.md`, which the Python suite holds equal to the Python
 * renderer. So the two renderers agree by transitivity, and neither tree imports the other.
 *
 * The Python ids ported here are not checklist items, so the tests lead with `TS-` ids: AT-226 is TS-041,
 * AT-067 is TS-042, AT-071 is TS-043 and the command half of AT-061 is TS-044.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BAKED_IN_FILTER_FIELDS,
  IndexSpec,
  SearchIndexSpec,
  checkTtl,
  declaredFilterFields,
  dropIndexCommand,
  memorySearchSpecs,
  memorySpecs,
  pythonJson,
  readiness,
  storageSpecs,
  textIndexDefinition,
  vectorIndexDefinition,
  vectorMode,
} from '../../src/indexes.js'
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MEMORY_COLLECTION,
  DEFAULT_STORAGE_COLLECTION,
  type MongoDBConfig,
  SIMILARITIES,
} from '../../src/types.js'

const PYTHON_README = new URL('../../../python/README.md', import.meta.url)

/** A config with nothing but the database, which resolves to the AutoEmbeddings path. */
function config(extra: Partial<MongoDBConfig> = {}): MongoDBConfig {
  return { database: 'agents', ...extra }
}

/** The thrown error, failing the test if nothing is thrown. */
function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw, and nothing was thrown')
}

/** The memory spec with this key list, failing the test if it is absent. */
function memorySpec(...keys: string[]): IndexSpec {
  const found = memorySpecs().find((spec) => JSON.stringify(spec.keys.map(([k]) => k)) === JSON.stringify(keys))
  if (found === undefined) throw new Error(`no memory spec over ${JSON.stringify(keys)}`)
  return found
}

describe('TS-041 — a negative ttlSeconds is refused before anything is written', () => {
  it('TS-041 — a negative lifetime throws a RangeError naming the setting', () => {
    const error = thrown(() => checkTtl(-1))
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toContain("'ttlSeconds' is -1")
    expect(error.message).toContain('or undefined for no expiry')
  })

  it('TS-041 — zero and no lifetime are both accepted', () => {
    expect(() => checkTtl(0)).not.toThrow()
    expect(() => checkTtl(undefined)).not.toThrow()
    expect(() => checkTtl(60)).not.toThrow()
  })
})

describe('TS-031 — a reported search-index status reads as ready, failed or building', () => {
  it('TS-031 — READY and FAILED are the only two terminal statuses', () => {
    expect(readiness('READY')).toBe('ready')
    expect(readiness('FAILED')).toBe('failed')
  })

  it('TS-031 — anything else, including a status this package has never seen, is building', () => {
    for (const status of ['PENDING', 'BUILDING', 'STAGED', 'DOES_NOT_EXIST', 'SOMETHING_NEW', '']) {
      expect(readiness(status)).toBe('building')
    }
  })
})

describe('TS-042 — embeddingDimensions and similarity select the manual vector mode, and conflicts throw', () => {
  it('TS-042 — an empty config selects autoembed with the documented default', () => {
    expect(vectorMode(config())).toEqual({ autoEmbed: true, model: DEFAULT_EMBEDDING_MODEL })
  })

  it('TS-042 — the default model is the one the community package ships', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('voyage-4-lite')
  })

  it('TS-042 — an explicit model selects autoembed with that model', () => {
    expect(vectorMode(config({ embeddingModel: 'voyage-3-large' }))).toEqual({
      autoEmbed: true,
      model: 'voyage-3-large',
    })
  })

  it('TS-042 — dimensions and similarity select the manual vector mode', () => {
    expect(vectorMode(config({ embeddingDimensions: 1024, similarity: 'cosine' }))).toEqual({
      autoEmbed: false,
      dimensions: 1024,
      similarity: 'cosine',
    })
  })

  it('TS-042 — dimensions without similarity throws and names the missing field', () => {
    const error = thrown(() => vectorMode(config({ embeddingDimensions: 1024 })))
    expect(error.message).toContain("'similarity'")
    expect(error.message).toContain('cosine, dotProduct, euclidean')
  })

  it('TS-042 — similarity without dimensions throws and names the missing field', () => {
    const error = thrown(() => vectorMode(config({ similarity: 'cosine' })))
    expect(error.message).toContain("'embeddingDimensions'")
  })

  it('TS-042 — setting both modes throws rather than picking one', () => {
    const error = thrown(() =>
      vectorMode(config({ embeddingModel: 'voyage-4-lite', embeddingDimensions: 1024, similarity: 'cosine' })),
    )
    expect(error.message).toContain("'embeddingModel'")
    expect(error.message).toContain("'embeddingDimensions'")
    expect(error.message).toContain("'similarity'")
  })

  it.each(SIMILARITIES)('TS-042 — the similarity %s is accepted', (similarity) => {
    expect(vectorMode(config({ embeddingDimensions: 8, similarity })).similarity).toBe(similarity)
  })

  it('TS-042 — an unknown similarity is a RangeError here rather than a server error later', () => {
    const error = thrown(() => vectorMode(config({ embeddingDimensions: 8, similarity: 'l2' as never })))
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toContain("'l2'")
    expect(error.message).toContain('cosine')
  })

  it.each([0, -1, 8193, 1.5])('TS-042 — %s dimensions is outside the Atlas bounds', (dimensions) => {
    const error = thrown(() => vectorMode(config({ embeddingDimensions: dimensions, similarity: 'cosine' })))
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toContain('1..8192')
  })
})

describe('TS-043 — filter fields are declared at creation time, in both modes', () => {
  it('TS-043 — the autoembed definition matches the confirmed wire shape', () => {
    expect(vectorIndexDefinition({ autoEmbed: true, model: 'voyage-4-lite' })).toEqual({
      fields: [
        { type: 'autoEmbed', path: 'content', model: 'voyage-4-lite', modality: 'text' },
        { type: 'filter', path: 'scope' },
        { type: 'filter', path: 'store_name' },
      ],
    })
  })

  it('TS-043 — the manual definition carries dimensions and similarity on the vector field', () => {
    const definition = vectorIndexDefinition({ autoEmbed: false, dimensions: 4, similarity: 'euclidean' })
    expect(definition.fields[0]).toEqual({
      type: 'vector',
      path: 'embedding',
      numDimensions: 4,
      similarity: 'euclidean',
    })
  })

  it('TS-043 — no definition ever emits the placeholder dimension count', () => {
    for (const mode of [vectorMode(config()), vectorMode(config({ embeddingDimensions: 1, similarity: 'cosine' }))]) {
      expect(JSON.stringify(vectorIndexDefinition(mode))).not.toContain('-1')
    }
  })

  it('TS-043 — scope and store_name are always declared filterable', () => {
    const paths = vectorIndexDefinition(vectorMode(config()))
      .fields.filter((field) => field.type === 'filter')
      .map((field) => field.path)
    expect(paths).toEqual(['scope', 'store_name'])
  })

  it('TS-043 — caller filter fields are appended after the baked-in two', () => {
    const paths = vectorIndexDefinition(vectorMode(config()), { filterFields: ['owner', 'topic'] })
      .fields.filter((field) => field.type === 'filter')
      .map((field) => field.path)
    expect(paths).toEqual(['scope', 'store_name', 'owner', 'topic'])
  })

  it('TS-043 — a caller field that duplicates a baked-in one is declared once', () => {
    const paths = vectorIndexDefinition(vectorMode(config()), { filterFields: ['scope', 'owner', 'owner'] })
      .fields.filter((field) => field.type === 'filter')
      .map((field) => field.path)
    expect(paths).toEqual(['scope', 'store_name', 'owner'])
  })

  it('TS-043 — the declared paths are readable without rebuilding the definition', () => {
    expect(declaredFilterFields(['owner'])).toEqual(['scope', 'store_name', 'owner'])
    expect(declaredFilterFields()).toEqual(['scope', 'store_name'])
  })

  it('TS-043 — the baked-in pair is the two fields that isolate stores in one collection', () => {
    expect(BAKED_IN_FILTER_FIELDS).toEqual(['scope', 'store_name'])
  })
})

describe('TS-032 — the full-text index maps the content field and nothing else', () => {
  it('TS-032 — it maps the content field as a string and nothing else', () => {
    expect(textIndexDefinition()).toEqual({ mappings: { dynamic: false, fields: { content: [{ type: 'string' }] } } })
  })

  it('TS-032 — dynamic mapping is off', () => {
    expect(textIndexDefinition().mappings.dynamic).toBe(false)
  })
})

describe('TS-033 — the ordinary index inventory is the README index table', () => {
  it('TS-033 — the storage surface declares exactly its TTL index', () => {
    const specs = storageSpecs()
    expect(specs.map((spec) => spec.name)).toEqual(['strands_expires_at_ttl'])
    expect(specs[0]?.keys).toEqual([['expires_at', 1]])
    expect(specs[0]?.options).toEqual({ expireAfterSeconds: 0 })
  })

  it('TS-033 — the memory surface declares three ordinary indexes', () => {
    expect(memorySpecs()).toHaveLength(3)
  })

  it('TS-033 — the dedup index carries the options it exists for', () => {
    const spec = memorySpec('scope', 'store_name', 'content_hash')
    expect(spec.name).toBe('strands_scope_store_content_hash_unique')
    expect(spec.options.unique).toBe(true)
  })

  it('TS-033 — the dedup index is partial, so documents without a hash do not collide', () => {
    expect(memorySpec('scope', 'store_name', 'content_hash').options.partialFilterExpression).toEqual({
      content_hash: { $exists: true },
    })
  })

  it('TS-033 — the recency index sorts created_at descending and has no options', () => {
    const spec = memorySpec('scope', 'store_name', 'created_at')
    expect(spec.keys).toEqual([
      ['scope', 1],
      ['store_name', 1],
      ['created_at', -1],
    ])
    expect(spec.options).toEqual({})
  })

  it('TS-033 — the memory TTL index is declared unconditionally', () => {
    const spec = memorySpec('expires_at')
    expect(spec.options).toEqual({ expireAfterSeconds: 0 })
    expect(spec.dateOnly).toBe(true)
  })

  it('TS-033 — specs take no arguments, so the inventory cannot vary by caller', () => {
    expect(memorySpecs()).toEqual(memorySpecs())
    expect(storageSpecs()).toEqual(storageSpecs())
  })

  it('TS-033 — every name carries the package prefix', () => {
    for (const spec of [...storageSpecs(), ...memorySpecs()]) expect(spec.name.startsWith('strands_')).toBe(true)
  })

  it('TS-033 — only the TTL index is exempt from the collation check', () => {
    expect(memorySpecs().map((spec) => spec.dateOnly)).toEqual([false, false, true])
  })
})

describe('TS-034 — the two search indexes are built from the config', () => {
  it('TS-034 — both search indexes are declared, vector first', () => {
    expect(memorySearchSpecs(config()).map((spec) => spec.type)).toEqual(['vectorSearch', 'search'])
  })

  it('TS-034 — the default index names are the reference implementation names', () => {
    expect(memorySearchSpecs(config()).map((spec) => spec.name)).toEqual(['vector_index', 'text_index'])
  })

  it('TS-034 — configured names override the defaults', () => {
    const specs = memorySearchSpecs(config({ vectorIndexName: 'v', textIndexName: 't' }))
    expect(specs.map((spec) => spec.name)).toEqual(['v', 't'])
  })

  it('TS-034 — the config filter fields reach the vector definition', () => {
    const [vector] = memorySearchSpecs(config({ filterFields: ['owner'] }))
    expect(JSON.stringify(vector?.definition)).toContain('{"type":"filter","path":"owner"}')
  })

  it('TS-034 — a conflicting vector config throws here too', () => {
    expect(() => memorySearchSpecs(config({ embeddingDimensions: 4 }))).toThrow("'similarity'")
  })
})

describe('TS-044 — the command a caller without DDL rights forwards to whoever has them', () => {
  const ttl = storageSpecs()[0] as IndexSpec

  it('TS-044 — an ordinary command is the server command the driver sends', () => {
    const command = ttl.creationCommand('storage')
    expect(command.startsWith('db.runCommand(')).toBe(true)
    expect(command).toContain('"createIndexes": "storage"')
    expect(command).toContain('"expires_at": 1')
    expect(command).toContain('"expireAfterSeconds": 0')
  })

  it('TS-044 — an ordinary command names the index it creates', () => {
    expect(ttl.creationCommand('storage')).toContain('"name": "strands_expires_at_ttl"')
  })

  it('TS-044 — a search command uses the search variant of the command', () => {
    const [vector] = memorySearchSpecs(config())
    const command = (vector as SearchIndexSpec).creationCommand('memory')
    expect(command).toContain('"createSearchIndexes": "memory"')
    expect(command).toContain('"type": "vectorSearch"')
    expect(command).toContain('autoEmbed')
  })

  it('TS-044 — every command is valid JSON inside the call', () => {
    const commands = [
      ...memorySpecs().map((spec) => spec.creationCommand('memory')),
      ...memorySearchSpecs(config()).flatMap((spec) => [spec.creationCommand('memory'), spec.dropCommand('memory')]),
      dropIndexCommand('memory', 'x'),
    ]
    for (const command of commands) {
      const match = /^db\.runCommand\((.*)\)$/s.exec(command)
      expect(match, command).not.toBeNull()
      expect(() => JSON.parse(match?.[1] as string)).not.toThrow()
    }
  })

  it('TS-044 — a drop command keeps a hostile index name inside its string', () => {
    const hostile = 'x"}); db.dropDatabase(); ({"a":"\\'
    for (const command of [
      dropIndexCommand('memory', hostile),
      new SearchIndexSpec(hostile, {}, 'search').dropCommand('memory'),
    ]) {
      const body = JSON.parse((/^db\.runCommand\((.*)\)$/s.exec(command) as RegExpExecArray)[1] as string) as Record<
        string,
        string
      >
      expect(Object.values(body)).toContain(hostile)
    }
  })

  it('TS-044 — the drop commands use the server command names', () => {
    expect(dropIndexCommand('memory', 'i')).toBe('db.runCommand({"dropIndexes": "memory", "index": "i"})')
    expect(new SearchIndexSpec('s', {}, 'search').dropCommand('memory')).toBe(
      'db.runCommand({"dropSearchIndex": "memory", "name": "s"})',
    )
  })
})

describe("TS-035 — the renderer writes JSON the way Python's json.dumps does", () => {
  it('TS-035 — separators carry one space after the comma and the colon', () => {
    expect(pythonJson({ a: [1, 2], b: { c: true, d: null } })).toBe('{"a": [1, 2], "b": {"c": true, "d": null}}')
  })

  it('TS-035 — non-ASCII text is escaped, as ensure_ascii does', () => {
    expect(pythonJson('café ☕')).toBe('"caf\\u00e9 \\u2615"')
    expect(pythonJson('😀')).toBe('"\\ud83d\\ude00"')
  })

  it('TS-035 — quotes, backslashes and control characters are escaped', () => {
    expect(pythonJson('a"b\\c\nd\u0001')).toBe('"a\\"b\\\\c\\nd\\u0001"')
  })

  it('TS-035 — empty containers render without inner space', () => {
    expect(pythonJson({ a: [], b: {} })).toBe('{"a": [], "b": {}}')
  })
})

describe('TS-036 — the rendered commands equal the python/README.md mongosh block', () => {
  it('TS-036 — the six commands, in order, are byte for byte the ones the Python README documents', () => {
    const readme = readFileSync(PYTHON_README, 'utf8')
    const documented: string[] = []
    for (const block of readme.matchAll(/<!-- run: mongosh -->\n```[a-z]*\n([\s\S]*?)```/g)) {
      for (const line of (block[1] as string).split('\n')) {
        const stripped = line.trim()
        if (stripped !== '' && !stripped.startsWith('//')) documented.push(stripped)
      }
    }
    const rendered = [
      ...storageSpecs().map((spec) => spec.creationCommand(DEFAULT_STORAGE_COLLECTION)),
      ...memorySpecs().map((spec) => spec.creationCommand(DEFAULT_MEMORY_COLLECTION)),
      ...memorySearchSpecs(config()).map((spec) => spec.creationCommand(DEFAULT_MEMORY_COLLECTION)),
    ]
    expect(documented).toHaveLength(6)
    expect(rendered).toEqual(documented)
  })
})
