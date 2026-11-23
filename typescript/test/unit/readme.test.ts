/**
 * `typescript/README.md`, held to the code it documents. Ports `python/tests/test_readme.py`.
 *
 * None of these is a checklist item, so each leads with a `TS-` id:
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-151 | AT-093 (links) | Every link is absolute, or an anchor that resolves, because this file is the npm page |
 * | TS-152 | AT-096 | The `mongosh` block is the renderer's output, and every index the package creates is documented |
 * | TS-153 | AT-094 | Each key table lists the declaration's keys, no others, with the right Required cell |
 * | TS-154 | `test_init.py` | The API table lists exactly what `src/index.ts` exports |
 * | TS-155 | `test_telemetry.py`'s README half | Every span, attribute, span event and log event is documented |
 * | TS-156 | AT-095 | Every limits row is traceable, every value quoted is current, every reserved key is named |
 * | TS-157 | none | The Int32 and Double claim in the cross-language section is what the driver does |
 * | TS-158 | AT-097, AT-092 | Every code block says what happens to it, and the `run` blocks typecheck and the `unit` ones run |
 *
 * The contract and autoembed blocks run in `test/contract/readme.test.ts` and `test/autoembed/readme.test.ts`
 * (TS-159), and the CI job table in `test/unit/ci.test.ts` (TS-160).
 */
import { join } from 'node:path'

import { context, trace } from '@opentelemetry/api'
import { BSON, Double } from 'mongodb'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_MEMORY_COLLECTION, DEFAULT_STORAGE_COLLECTION, RESERVED_METADATA_KEYS } from '../../src/index.js'
import * as entry from '../../src/index.js'
import { memorySearchSpecs, memorySpecs, storageSpecs } from '../../src/indexes.js'
import { ATTRIBUTES, EVENT_NAMES, LOG_EVENTS, SPAN_NAMES } from '../../src/telemetry.js'
import {
  MAX_DIMENSIONS,
  MAX_DOCUMENT_BYTES,
  MAX_KEY_BYTES,
  MAX_NUM_CANDIDATES,
  READY_TIMEOUT_MS,
  TIER_RETRY_MAX_MS,
  TIER_RETRY_MS,
} from '../../src/types.js'
import {
  compilerOptions,
  declaredKeys,
  entryPointExports,
  SOURCE_ROOT,
  sourceFile,
  sourceProgram,
} from '../support/program.js'
import {
  anchors,
  blocks,
  readme,
  runBlocks,
  removeSnippets,
  tableAfter,
  unquote,
  writeSnippet,
} from '../support/readme.js'

/** Building a program over `src/` takes seconds, well past the unit tier's 10 s default on a cold cache. */
const PROGRAM_TIMEOUT_MS = 120_000

/** The block languages a reader could paste and run, each of which must say what a test does with it. */
const EXECUTABLE = new Set(['ts', 'typescript', 'js', 'javascript', 'bash', 'sh', 'shell'])

/** Where a `run:` block may run. `mongosh` is compared with the renderer rather than executed. */
const RUN_TIERS = new Set(['unit', 'contract', 'autoembed', 'mongosh'])

/** The configuration types with a key table each, by the marker that introduces it. */
const KEY_TABLES = [
  'MongoDBConfig',
  'MongoDBMemoryStoreConfig',
  'MongoDBSearchQuery',
  'MongoDBStorageOptions',
  'MongoDBVectorSearchStrategyOptions',
]

/**
 * Every value the limits section quotes, and the renderings a cell may use for it. Derived rather than typed,
 * so a change to the constant changes what the README has to say.
 */
const TRACEABLE_VALUES: Readonly<Record<string, readonly string[]>> = {
  MAX_KEY_BYTES: [String(MAX_KEY_BYTES)],
  MAX_DOCUMENT_BYTES: [`${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`, String(MAX_DOCUMENT_BYTES)],
  DEFAULT_MAX_SEARCH_RESULTS: [String(entry.DEFAULT_MAX_SEARCH_RESULTS)],
  DEFAULT_OVERSAMPLING_FACTOR: [String(entry.DEFAULT_OVERSAMPLING_FACTOR)],
  MAX_DIMENSIONS: [String(MAX_DIMENSIONS)],
  MAX_NUM_CANDIDATES: [String(MAX_NUM_CANDIDATES)],
  READY_TIMEOUT_MS: [String(READY_TIMEOUT_MS)],
}

/** The limits with no constant behind them. A row cites the public API it is about instead. */
const TRACEABLE_IDS = new Set([
  'MongoDBConfig',
  'MongoDBStorage.close()',
  'MongoDBMemoryStore.close()',
  'MongoDBMemoryStore.add()',
  'MongoDBMemoryStore.search()',
  'MongoDBStorage.search()',
  'Storage.list()',
  'MongoDBStorage.ensureIndexes()',
])

/** Values a reader plans around, checked wherever in the document they appear. */
const QUOTED_DEFAULTS: Readonly<Record<string, string>> = {
  DEFAULT_EMBEDDING_MODEL: entry.DEFAULT_EMBEDDING_MODEL,
  DEFAULT_VECTOR_INDEX_NAME: entry.DEFAULT_VECTOR_INDEX_NAME,
  DEFAULT_TEXT_INDEX_NAME: entry.DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_STORAGE_VECTOR_INDEX_NAME: entry.DEFAULT_STORAGE_VECTOR_INDEX_NAME,
  DEFAULT_MEMORY_COLLECTION: entry.DEFAULT_MEMORY_COLLECTION,
  DEFAULT_STORAGE_COLLECTION: entry.DEFAULT_STORAGE_COLLECTION,
  UNSCOPED: entry.UNSCOPED,
  READY_TIMEOUT_MS: String(READY_TIMEOUT_MS),
  TIER_RETRY_MS: `${TIER_RETRY_MS / 1000} s`,
  TIER_RETRY_MAX_MS: `${TIER_RETRY_MAX_MS / 1000} s`,
}

/** Log events that only Python emits: both are about a client on another event loop, and Node has one loop. */
const PYTHON_ONLY_EVENTS = ['attribution_not_visible', 'closed_loop_client_dropped']

/** The level of every log call in `src/`, by event, read from the call sites. */
function emittedLevels(program: ts.Program): Map<string, string> {
  const levels = new Map<string, string>()
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(SOURCE_ROOT)) continue
    for (const match of file.text.matchAll(/\blogger\.(debug|info|warn|error)\(\s*eventFields\(\s*'([a-z_]+)'/g)) {
      levels.set(match[2] as string, match[1] as string)
    }
  }
  return levels
}

/** The string-literal members of `Operations[surface]` in `src/telemetry.ts`. */
function operations(program: ts.Program, surface: 'storage' | 'memory'): string[] {
  const checker = program.getTypeChecker()
  const file = sourceFile(program, join(SOURCE_ROOT, 'telemetry.ts'))
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'Operations',
  )
  if (declaration === undefined) throw new Error('src/telemetry.ts declares no Operations interface')
  const member = checker.getPropertyOfType(checker.getTypeAtLocation(declaration), surface)
  if (member === undefined) throw new Error(`Operations has no ${surface}`)
  const type = checker.getTypeOfSymbol(member)
  const parts = type.isUnion() ? type.types : [type]
  return parts.map((part) => (part as ts.StringLiteralType).value)
}

/** The first cell of every row after `marker`, backticks removed. */
function firstColumn(marker: string): string[] {
  return tableAfter(marker).map((row) => unquote(row[0] ?? ''))
}

let program: ts.Program

beforeAll(() => {
  program = sourceProgram()
}, PROGRAM_TIMEOUT_MS)

describe('TS-151 — the README links only to absolute URLs and anchors that exist', () => {
  it('TS-151 — every link is https or an in-page anchor, since npm renders the file away from the repository', () => {
    const targets = [...readme().matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string)
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.filter((target) => !target.startsWith('https://') && !target.startsWith('#'))).toEqual([])
  })

  it('TS-151 — every in-page anchor names a heading', () => {
    const known = anchors()
    const dangling = [...readme().matchAll(/\]\(#([^)\s]+)\)/g)]
      .map((match) => match[1] as string)
      .filter((anchor) => !known.has(anchor))
    expect(dangling).toEqual([])
  })

  it('TS-151 — every repository link points at the published default branch', () => {
    const repository = [...readme().matchAll(/\]\((https:\/\/github\.com\/mongodb\/strands-mongodb[^)\s]*)\)/g)]
    for (const [, url] of repository)
      expect(url).toMatch(/^https:\/\/github\.com\/mongodb\/strands-mongodb\/blob\/main\//)
  })
})

describe('TS-152 — the mongosh block is the rendered commands', () => {
  it('TS-152 — exact equality, in order, against creationCommand()', () => {
    const documented = runBlocks('mongosh')
      .flatMap((block) => block.code.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'))
    const rendered = [
      ...storageSpecs().map((spec) => spec.creationCommand(DEFAULT_STORAGE_COLLECTION)),
      ...memorySpecs().map((spec) => spec.creationCommand(DEFAULT_MEMORY_COLLECTION)),
      ...memorySearchSpecs({ database: 'agents' }).map((spec) => spec.creationCommand(DEFAULT_MEMORY_COLLECTION)),
    ]
    expect(documented).toEqual(rendered)
  })

  it('TS-152 — every index the package can create has a row in the index table, and no other does', () => {
    const names = new Set([
      ...storageSpecs().map((spec) => spec.name),
      ...memorySpecs().map((spec) => spec.name),
      ...memorySearchSpecs({ database: 'agents' }).map((spec) => spec.name),
      entry.DEFAULT_STORAGE_VECTOR_INDEX_NAME,
    ])
    const documented = new Set(tableAfter('<!-- indexes -->').map((row) => unquote(row[1] ?? '')))
    expect(documented).toEqual(names)
  })
})

describe('TS-153 — every configuration key is documented, and no other', () => {
  it.each(KEY_TABLES)('TS-153 — the %s table lists every declared key and no others', (name) => {
    const declared = declaredKeys(program, name)
    const documented = firstColumn(`<!-- keys: ${name} -->`)
    expect([...documented].sort()).toEqual([...declared.keys()].sort())
  })

  it.each(KEY_TABLES)('TS-153 — the Required column of the %s table matches the declaration', (name) => {
    const declared = declaredKeys(program, name)
    const documented = Object.fromEntries(
      tableAfter(`<!-- keys: ${name} -->`).map((row) => [unquote(row[0] ?? ''), row[2] === 'yes']),
    )
    expect(documented).toEqual(Object.fromEntries(declared))
  })
})

describe('TS-154 — the API table is the entry point', () => {
  it('TS-154 — every name src/index.ts exports has a row, and every row is an export', () => {
    expect([...firstColumn('<!-- api -->')].sort()).toEqual(entryPointExports(program))
  })
})

describe('TS-155 — the observability section lists every span, attribute and event', () => {
  it('TS-155 — the span table is the operations and the index spans', () => {
    // Compared as sets: the checker orders a union's literals by type identity, not by declaration, so the
    // table's reading order (storage, then memory, then the index spans) is review's to keep.
    const expected = [
      ...operations(program, 'storage').map((name) => `strands_mongodb.storage.${name}`),
      ...operations(program, 'memory').map((name) => `strands_mongodb.memory.${name}`),
      ...SPAN_NAMES,
    ]
    expect([...firstColumn('<!-- spans -->')].sort()).toEqual(expected.sort())
  })

  it('TS-155 — the attribute table is the allow-list, plus the error.type a failed span carries', () => {
    expect([...firstColumn('<!-- attributes -->')].sort()).toEqual([...ATTRIBUTES, 'error.type'].sort())
  })

  it('TS-155 — every span event is named', () => {
    for (const name of EVENT_NAMES) expect(readme()).toContain(`\`${name}\``)
  })

  it('TS-155 — the log-event table is every event src/ emits, at the level it is emitted at', () => {
    const emitted = emittedLevels(program)
    const documented = new Map(
      tableAfter('<!-- log-events -->').map((row) => [unquote(row[0] ?? ''), unquote(row[1] ?? '')]),
    )
    expect(documented).toEqual(emitted)
    expect([...emitted.keys(), ...PYTHON_ONLY_EVENTS].sort()).toEqual([...LOG_EVENTS].sort())
  })

  it('TS-155 — the two events only Python emits are named as such, so a shared log pipeline knows why they are absent', () => {
    for (const name of PYTHON_ONLY_EVENTS) expect(readme()).toContain(`\`${name}\``)
  })
})

describe('TS-156 — every limit is traceable to what sets it, and every quoted value is current', () => {
  it('TS-156 — every row of the limits table cites a constant or a public API', () => {
    const rows = tableAfter('<!-- limits -->')
    expect(rows.length).toBeGreaterThan(0)
    const untraceable = rows
      .map((row) => unquote(row[2] ?? ''))
      .filter((source) => !(source in TRACEABLE_VALUES) && !TRACEABLE_IDS.has(source))
    expect(untraceable).toEqual([])
  })

  it('TS-156 — every limit with no constant behind it has a row, MongoDBStorage.search() included', () => {
    const cited = new Set(tableAfter('<!-- limits -->').map((row) => unquote(row[2] ?? '')))
    expect([...TRACEABLE_IDS].filter((id) => !cited.has(id))).toEqual([])
  })

  it('TS-156 — a row citing a constant quotes its current value', () => {
    for (const [limit, where, source] of tableAfter('<!-- limits -->')) {
      const forms = TRACEABLE_VALUES[unquote(source ?? '')]
      if (forms === undefined) continue
      expect(
        forms.some((form) => `${limit} ${where}`.includes(form)),
        `${source}: ${forms.join(' or ')}`,
      ).toBe(true)
    }
  })

  it('TS-156 — the defaults a reader plans around are quoted at their current values', () => {
    for (const [name, value] of Object.entries(QUOTED_DEFAULTS)) expect(readme(), name).toContain(value)
  })

  it('TS-156 — every reserved metadata key is named', () => {
    for (const key of RESERVED_METADATA_KEYS) expect(readme()).toContain(`\`${key}\``)
  })
})

describe('TS-157 — the cross-language caveat is what the driver does', () => {
  it('TS-157 — an integer-valued number is stored as Int32 and a Double as a double', () => {
    // Byte 4 of a one-field document is the field's BSON type: 0x10 is int32, 0x01 is double.
    expect(BSON.serialize({ x: 1 })[4]).toBe(0x10)
    expect(BSON.serialize({ x: 1.5 })[4]).toBe(0x01)
    expect(BSON.serialize({ x: new Double(1) })[4]).toBe(0x01)
  })

  it('TS-157 — the README says so, and names the remedy', () => {
    const text = readme()
    const start = text.indexOf('## Sharing a collection with Python')
    expect(start).toBeGreaterThan(-1)
    const section = text.slice(start, text.indexOf('\n## ', start + 1))
    expect(section).toContain('Int32')
    expect(section).toContain('`Double`')
  })
})

describe('TS-158 — every code block says what happens to it, and the ones that run are sound', () => {
  afterAll(() => {
    removeSnippets()
  })

  it('TS-158 — every executable block carries a directive', () => {
    const bare = blocks()
      .filter((block) => EXECUTABLE.has(block.language) && block.directive === undefined)
      .map((block) => `line ${block.line}`)
    expect(bare).toEqual([])
  })

  it('TS-158 — every skip states a reason', () => {
    const unexplained = blocks().filter((block) => block.directive === 'skip' && block.argument.length < 10)
    expect(unexplained.map((block) => `line ${block.line}`)).toEqual([])
  })

  it('TS-158 — every run directive names a tier the suite runs', () => {
    const unknown = blocks().filter((block) => block.directive === 'run' && !RUN_TIERS.has(block.argument))
    expect(unknown.map((block) => `line ${block.line}: ${block.argument}`)).toEqual([])
  })

  it('TS-158 — there is a quickstart for each store', () => {
    const run = blocks().filter((block) => block.directive === 'run' && block.language === 'ts')
    expect(run.some((block) => block.code.includes('new MongoDBStorage('))).toBe(true)
    expect(run.some((block) => block.code.includes('new MongoDBMemoryStore('))).toBe(true)
  })

  it(
    'TS-158 — every TypeScript run block typechecks under the package tsconfig',
    () => {
      const runnable = blocks().filter((block) => block.directive === 'run' && block.language === 'ts')
      const paths = runnable.map((block, index) => writeSnippet(block, `typecheck-${index}`))
      const checked = ts.createProgram(paths, { ...compilerOptions(), noEmit: true })
      const problems = ts
        .getPreEmitDiagnostics(checked)
        .filter((diagnostic) => diagnostic.file !== undefined && paths.includes(diagnostic.file.fileName))
        .map((diagnostic) => {
          const where = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
          const block = runnable[paths.indexOf(diagnostic.file?.fileName ?? '')]
          return `README line ${(block?.line ?? 0) + (where?.line ?? 0) + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
        })
      expect(problems).toEqual([])
    },
    PROGRAM_TIMEOUT_MS,
  )

  it('TS-158 — the unit blocks run with nothing reachable', async () => {
    const unit = runBlocks('unit')
    expect(unit.length).toBeGreaterThan(0)
    for (const [index, block] of unit.entries()) {
      await import(writeSnippet(block, `unit-${index}-${Date.now()}`))
    }
  })

  afterAll(() => {
    // The observability block installs a global tracer provider and context manager. Remove both, so nothing
    // later in this worker records spans to the console exporter it set up.
    trace.disable()
    context.disable()
  })
})
