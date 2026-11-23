/**
 * Spans and structured log fields, on the telemetry module alone, apart from any store.
 *
 * Ports the module-level half of `python/tests/test_telemetry.py`: AT-201, AT-205, AT-207, AT-214 and the
 * field helper of AT-210. Those ids are not checklist items, so these tests lead with `TS-` ids. The
 * per-operation halves land with the stores (M6, M9), and the index spans with the lifecycle (M5).
 *
 * Every assertion reads what a real `InMemorySpanExporter` received behind the global tracer provider, as
 * Python's do, rather than a mocked tracer.
 */
import { readdirSync, readFileSync } from 'node:fs'

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { StorageError, configureLogging as configureSdkLogging } from '@strands-agents/sdk'
import type { Logger } from '@strands-agents/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ATTRIBUTES,
  EVENT_NAMES,
  LOG_EVENTS,
  SPAN_NAMES,
  annotate,
  configureLogging,
  event,
  eventFields,
  logger,
  span,
  traced,
} from '../../src/telemetry.js'
import type { Attribute, LogEvent } from '../../src/telemetry.js'
import { VERSION } from '../../src/version.js'
import { children, exportedSpans, one, rendered } from '../support/spans.js'

const ACQUIRED = 'strands_mongodb.client.acquired'
const SOURCE = new URL('../../src/', import.meta.url)
const PYTHON_TELEMETRY = new URL('../../../python/src/strands_mongodb/_telemetry.py', import.meta.url)

/** The namespace a memory store would pass, on an object that is not a store. */
const MEMORY = { database: 'appdb', collection: 'things', storeName: 'facts' } as const
const STORAGE = { database: 'appdb', collection: 'kv' } as const

/** One log call a recording logger received. */
interface LogCall {
  readonly level: keyof Logger
  readonly args: unknown[]
}

/** A logger that keeps every call, in Pino's order: the fields object, then the message. */
function recording(): { logger: Logger; records: LogCall[] } {
  const records: LogCall[] = []
  const keep =
    (level: keyof Logger) =>
    (...args: unknown[]): void => {
      records.push({ level, args })
    }
  return { logger: { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') }, records }
}

/** Every `.ts` file under `src/`, as one map of name to text. */
function sources(): Map<string, string> {
  const names = readdirSync(SOURCE).filter((name) => name.endsWith('.ts'))
  return new Map(names.map((name) => [name, readFileSync(new URL(name, SOURCE), 'utf8')]))
}

/** The string members of a Python `Literal[...]` assigned to `name` in `_telemetry.py`. */
function pythonLiteral(name: string): string[] {
  const text = readFileSync(PYTHON_TELEMETRY, 'utf8')
  const body = new RegExp(`^${name} = Literal\\[([^\\]]*)\\]`, 'm').exec(text)?.[1]
  if (body === undefined) throw new Error(`no Literal named ${name} in _telemetry.py`)
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string)
}

const original = logger

/** The SDK's default logger, which it does not export, rebuilt to put it back after a test replaces it. */
const SDK_DEFAULT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

afterEach(() => {
  configureLogging(original)
  vi.restoreAllMocks()
})

describe('TS-014 — the tracer belongs to the application', () => {
  it('TS-014 — the tracer is looked up on every call, under the package name and version', async () => {
    const spans = exportedSpans()
    const spy = vi.spyOn(trace, 'getTracer')

    await traced('memory', 'search', MEMORY, async () => 'x')
    await traced('memory', 'search', MEMORY, async () => 'x')

    expect(spy.mock.calls).toEqual([
      ['strands-mongodb', VERSION],
      ['strands-mongodb', VERSION],
    ])
    expect(spans.getFinishedSpans().map((finished) => finished.name)).toEqual([
      'strands_mongodb.memory.search',
      'strands_mongodb.memory.search',
    ])
  })

  it('TS-014 — the package configures no provider, exporter, sampler or context manager', () => {
    const forbidden = [
      'setGlobalTracerProvider',
      'setGlobalContextManager',
      '@opentelemetry/sdk',
      'SpanProcessor',
      'SpanExporter',
      'Sampler',
    ]
    for (const [name, text] of sources()) {
      for (const word of forbidden) expect(text.includes(word), `${word} in ${name}`).toBe(false)
    }
  })
})

describe('TS-015 — a span is internal, and carries the namespace and nothing from the call', () => {
  it('TS-015 — a memory span carries the database, collection and store name, and its outcome', async () => {
    const spans = exportedSpans()

    const value = await traced('memory', 'search', MEMORY, async () => {
      annotate('strands_mongodb.result_count', 3)
      return 'returned'
    })

    expect(value).toBe('returned')
    const finished = one(spans, 'strands_mongodb.memory.search')
    expect(finished.kind).toBe(SpanKind.INTERNAL)
    expect(finished.attributes).toEqual({
      'strands_mongodb.database': 'appdb',
      'strands_mongodb.collection': 'things',
      'strands_mongodb.store_name': 'facts',
      'strands_mongodb.result_count': 3,
    })
    expect(finished.status.code).toBe(SpanStatusCode.UNSET)
    expect(finished.ended).toBe(true)
  })

  it('TS-015 — a storage span has no store name', async () => {
    const spans = exportedSpans()

    await traced('storage', 'delete_prefix', STORAGE, async () => undefined)

    expect(one(spans, 'strands_mongodb.storage.delete_prefix').attributes).toEqual({
      'strands_mongodb.database': 'appdb',
      'strands_mongodb.collection': 'kv',
    })
  })

  it('TS-015 — the operation names are the Python ones, snake_case, not the TypeScript method names', async () => {
    const spans = exportedSpans()

    await traced('storage', 'ensure_indexes', STORAGE, async () => undefined)
    await traced('memory', 'delete_all', MEMORY, async () => undefined)

    expect(spans.getFinishedSpans().map((finished) => finished.name)).toEqual([
      'strands_mongodb.storage.ensure_indexes',
      'strands_mongodb.memory.delete_all',
    ])
    // @ts-expect-error the camelCase method name is not a span operation.
    void traced('storage', 'deletePrefix', STORAGE, async () => undefined)
  })
})

describe('TS-016 — a failure marks the span by class alone, and the throw is unchanged', () => {
  it('TS-016 — the status is ERROR named by the class, and the message is copied nowhere', async () => {
    const spans = exportedSpans()
    const failure = new StorageError('MongoDBMemoryStore: searching MARKER-KEY failed')

    await expect(
      traced('memory', 'search', MEMORY, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const finished = one(spans, 'strands_mongodb.memory.search')
    expect(finished.status).toEqual({ code: SpanStatusCode.ERROR, message: 'StorageError' })
    expect(finished.attributes['error.type']).toBe('StorageError')
    expect(finished.events).toEqual([])
    expect(rendered(finished)).not.toContain('MARKER-KEY')
    expect(finished.ended).toBe(true)
  })

  it('TS-016 — a subclass is named by its own class', async () => {
    const spans = exportedSpans()

    await expect(
      traced('storage', 'read', STORAGE, async () => {
        throw new RangeError('MARKER-KEY')
      }),
    ).rejects.toThrow(RangeError)

    const finished = one(spans, 'strands_mongodb.storage.read')
    expect(finished.status).toEqual({ code: SpanStatusCode.ERROR, message: 'RangeError' })
    expect(finished.attributes['error.type']).toBe('RangeError')
  })

  it('TS-016 — a thrown value that is not an Error is _OTHER, the semantic conventions fallback', async () => {
    const spans = exportedSpans()

    await expect(
      traced('storage', 'read', STORAGE, async () => {
        throw 'MARKER-KEY'
      }),
    ).rejects.toBe('MARKER-KEY')

    const finished = one(spans, 'strands_mongodb.storage.read')
    expect(finished.status).toEqual({ code: SpanStatusCode.ERROR, message: '_OTHER' })
    expect(finished.attributes['error.type']).toBe('_OTHER')
    expect(rendered(finished)).not.toContain('MARKER-KEY')
  })
})

describe('TS-017 — index work is a child span of the operation that caused it', () => {
  it('TS-017 — span() opens an internal child, and annotate() inside it sets the child', async () => {
    const spans = exportedSpans()

    const value = await traced('memory', 'initialize', MEMORY, () =>
      span('strands_mongodb.indexes.ensure', { 'strands_mongodb.indexes.mode': 'ensure' }, async () => {
        annotate('strands_mongodb.indexes.created', 2)
        return 'built'
      }),
    )

    expect(value).toBe('built')
    const parent = one(spans, 'strands_mongodb.memory.initialize')
    const [child] = children(spans, parent, 'strands_mongodb.indexes.ensure')
    expect(child?.kind).toBe(SpanKind.INTERNAL)
    expect(child?.attributes).toEqual({
      'strands_mongodb.indexes.mode': 'ensure',
      'strands_mongodb.indexes.created': 2,
    })
    expect(parent.attributes['strands_mongodb.indexes.created']).toBeUndefined()
  })

  it('TS-017 — a failing child is marked, and so is the operation it propagates through', async () => {
    const spans = exportedSpans()
    const failure = new StorageError('MongoDBStorage: MARKER-KEY')

    await expect(
      traced('storage', 'ensure_indexes', STORAGE, () =>
        span('strands_mongodb.indexes.probe', { 'strands_mongodb.indexes.probe': 'collation' }, async () => {
          throw failure
        }),
      ),
    ).rejects.toBe(failure)

    expect(one(spans, 'strands_mongodb.indexes.probe').status.code).toBe(SpanStatusCode.ERROR)
    expect(one(spans, 'strands_mongodb.storage.ensure_indexes').status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe('TS-018 — the attribute allow-list is enforced by type, and dropped rather than thrown at runtime', () => {
  it('TS-018 — an unknown name is dropped from annotate, event and span, and logged at debug', async () => {
    const spans = exportedSpans()
    const { logger: kept, records } = recording()
    configureLogging(kept)
    const unknown = 'strands_mongodb.query' as Attribute

    await trace.getTracer('host').startActiveSpan('host', async (host) => {
      annotate(unknown, 'MARKER')
      event(ACQUIRED, { [unknown]: 'MARKER', 'strands_mongodb.client.injected': true })
      await span('strands_mongodb.indexes.wait', { [unknown]: 'MARKER' }, async () => undefined)
      host.end()
    })

    const host = one(spans, 'host')
    expect(host.attributes).toEqual({})
    expect(host.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual([
      { name: ACQUIRED, attributes: { 'strands_mongodb.client.injected': true } },
    ])
    expect(one(spans, 'strands_mongodb.indexes.wait').attributes).toEqual({})
    expect(records).toEqual(
      Array.from({ length: 3 }, () => ({
        level: 'debug',
        args: [
          { strands_mongodb_event: 'attribute_dropped' },
          "strands_mongodb: dropped span attribute 'strands_mongodb.query', which is not on the allow-list",
        ],
      })),
    )
  })

  it('TS-018 — an unknown name fails the type checker', () => {
    // @ts-expect-error not on the allow-list.
    annotate('strands_mongodb.query', 1)
    // @ts-expect-error not a span name the package opens.
    void span('strands_mongodb.indexes.drop', {}, async () => undefined)
    // @ts-expect-error not an event name.
    event('strands_mongodb.client.released', {})
  })

  it('TS-018 — outside any span, annotate and event do nothing and throw nothing', () => {
    expect(() => annotate('strands_mongodb.found', true)).not.toThrow()
    expect(() => event(ACQUIRED, { 'strands_mongodb.client.injected': false })).not.toThrow()
  })
})

describe('TS-019 — the names match the Python package', () => {
  it('TS-019 — attributes, span names, span events and log events equal _telemetry.py', () => {
    expect([...ATTRIBUTES]).toEqual(pythonLiteral('Attribute'))
    expect([...SPAN_NAMES]).toEqual(pythonLiteral('SpanName'))
    expect([...EVENT_NAMES]).toEqual(pythonLiteral('EventName'))
    expect([...LOG_EVENTS]).toEqual(pythonLiteral('LogEvent'))
  })

  it('TS-019 — every log event is snake_case', () => {
    for (const name of LOG_EVENTS) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/)
  })
})

describe('TS-020 — every log record carries structured fields', () => {
  it('TS-020 — eventFields prefixes its keys and omits what does not apply', () => {
    expect(eventFields('tier_unavailable', { namespace: 'appdb.facts', tier: 'vector' })).toEqual({
      strands_mongodb_event: 'tier_unavailable',
      strands_mongodb_namespace: 'appdb.facts',
      strands_mongodb_tier: 'vector',
    })
    expect(eventFields('retry_writes_disabled')).toEqual({ strands_mongodb_event: 'retry_writes_disabled' })
    expect(eventFields('no_search_setup', { namespace: 'appdb.facts' })).toEqual({
      strands_mongodb_event: 'no_search_setup',
      strands_mongodb_namespace: 'appdb.facts',
    })
  })

  it('TS-020 — every log call in src/ passes eventFields(...) first, and names each event at most once', () => {
    const used: LogEvent[] = []
    const bare: string[] = []
    for (const [name, text] of sources()) {
      for (const match of text.matchAll(/\blogger\.(debug|info|warn|error)\(\s*([^,]*)/g)) {
        const fields = /^eventFields\('([a-z_]+)'/.exec(match[2] ?? '')
        if (fields === null) bare.push(`${name}: ${match[0]}`)
        else used.push(fields[1] as LogEvent)
      }
    }

    expect(bare).toEqual([])
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) expect(LOG_EVENTS).toContain(name)
    expect(new Set(used).size).toBe(used.length)
  })

  it('TS-020 — a fields object survives JSON, so a JSON logger indexes it without parsing the message', () => {
    const fields = eventFields('tier_building', { namespace: 'appdb.facts', tier: 'text' })

    expect(JSON.parse(JSON.stringify(fields))).toEqual(fields)
  })
})

describe("TS-021 — configureLogging sets this package's logger, apart from the SDK's", () => {
  let consoleSpies: { [level in keyof Logger]: ReturnType<typeof vi.spyOn> }

  beforeEach(() => {
    consoleSpies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    }
  })

  it('TS-021 — by default debug and info are dropped, and warn and error go to the console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    logger.debug({ strands_mongodb_event: 'attribute_dropped' }, 'quiet')
    logger.info({ strands_mongodb_event: 'creating_indexes' }, 'quiet')
    logger.warn({ strands_mongodb_event: 'below_vector' }, 'loud')
    logger.error({ strands_mongodb_event: 'below_vector' }, 'louder')

    expect(consoleSpies.debug).not.toHaveBeenCalled()
    expect(consoleSpies.info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(consoleSpies.warn).toHaveBeenCalledWith({ strands_mongodb_event: 'below_vector' }, 'loud')
    expect(consoleSpies.error).toHaveBeenCalledWith({ strands_mongodb_event: 'below_vector' }, 'louder')
  })

  it('TS-021 — a configured logger receives every level, and the live binding follows it', () => {
    const { logger: kept, records } = recording()

    configureLogging(kept)
    logger.debug({ strands_mongodb_event: 'score_bound_applied' }, 'kept')

    expect(logger).toBe(kept)
    expect(records).toEqual([{ level: 'debug', args: [{ strands_mongodb_event: 'score_bound_applied' }, 'kept'] }])
  })

  it("TS-021 — the SDK's configureLogging does not reach this package's records", () => {
    const sdk = recording()

    configureSdkLogging(sdk.logger)
    try {
      logger.warn({ strands_mongodb_event: 'below_vector' }, 'ours')
    } finally {
      configureSdkLogging(SDK_DEFAULT)
    }

    expect(sdk.records).toEqual([])
    expect(consoleSpies.warn).toHaveBeenCalledWith({ strands_mongodb_event: 'below_vector' }, 'ours')
  })
})
