/**
 * The shared client registry: one `MongoClient` per connection identity, and who may close it.
 *
 * Ports `python/tests/test_client.py` without the event-loop and thread halves, which have no JavaScript
 * counterpart: a Node process has one event loop, so a client never outlives the loop it was built on.
 *
 * Nothing here reaches a server. Building a `MongoClient` does no I/O, and every URI points at port 1 on the
 * loopback address, where nothing listens.
 */
import { inspect } from 'node:util'

import type { Logger } from '@strands-agents/sdk'
import { trace } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { MongoClient } from 'mongodb'
import type { Document, MongoClientOptions } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DRIVER_NAME, REGISTRY, close, resolve } from '../../src/client.js'
import { configureLogging, logger } from '../../src/telemetry.js'
import type { MongoDBConfig } from '../../src/types.js'
import { VERSION } from '../../src/version.js'
import { exportedSpans, one } from '../support/spans.js'

/** Where nothing listens, so a client built for it never connects. */
const UNREACHABLE = 'mongodb://127.0.0.1:1/'

/** A fake password, assembled so no file holds a credentialed URI as one literal. */
const PASSWORD = 'SUPERSECRET'
const LEAKY_URI = 'mongodb://appuser:' + PASSWORD + '@127.0.0.1:1/appdb'

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

/** The handshake document the driver will send, which it keeps as a private promise. */
async function metadata(client: MongoClient): Promise<Document> {
  return await (client.options as unknown as { metadata: Promise<Document> }).metadata
}

/** The driver-info entries appended to `client`, its own constructor's included. */
function driverInfoList(client: MongoClient): unknown[] {
  return (client as unknown as { driverInfoList: unknown[] }).driverInfoList
}

/** A config for the unreachable deployment. */
function built(extra: Partial<MongoDBConfig> = {}): MongoDBConfig {
  return { database: 'appdb', connectionString: UNREACHABLE, ...extra }
}

/** Clients a test built itself, closed after it. */
const injected: MongoClient[] = []

/** A client the caller built, as an application would. */
function inject(uri = UNREACHABLE, options?: MongoClientOptions): MongoClient {
  const client = new MongoClient(uri, options)
  injected.push(client)
  return client
}

const original = logger

beforeEach(() => {
  REGISTRY.clear()
})

afterEach(async () => {
  vi.restoreAllMocks()
  configureLogging(original)
  for (const connection of REGISTRY.values()) if (connection.owned) await connection.client.close()
  REGISTRY.clear()
  for (const client of injected.splice(0)) await client.close()
})

describe('TS-024 — a config with neither client nor connectionString fails where the caller can see it', () => {
  it('TS-024 — the error is a TypeError naming the class and both fields', () => {
    const config: MongoDBConfig = { database: 'appdb' }

    expect(() => resolve(config, 'MongoDBStorage')).toThrow(TypeError)
    expect(() => resolve(config, 'MongoDBMemoryStore')).toThrow(/^MongoDBMemoryStore: /)
    const message = (() => {
      try {
        resolve(config, 'MongoDBStorage')
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()
    expect(message).toMatch(/^MongoDBStorage: /)
    expect(message).toContain('client')
    expect(message).toContain('connectionString')
  })

  it('TS-024 — nothing is registered, and close on that config is a no-op', async () => {
    const config: MongoDBConfig = { database: 'appdb' }

    expect(() => resolve(config, 'MongoDBStorage')).toThrow()
    expect(REGISTRY.size).toBe(0)
    await expect(close(config)).resolves.toBeUndefined()
  })
})

describe('AT-010, AT-011 — who built the client decides who may close it', () => {
  it('AT-010 — an injected client is never closed, not even by a second close', async () => {
    const client = inject()
    const closing = vi.spyOn(client, 'close')
    const config: MongoDBConfig = { database: 'appdb', client }

    const connection = resolve(config, 'MongoDBStorage')
    await close(config)
    await close(config)

    expect(connection.client).toBe(client)
    expect(connection.owned).toBe(false)
    expect(closing).not.toHaveBeenCalled()
  })

  it('AT-010 — an injected client wins over a connectionString given beside it', () => {
    const client = inject()

    const connection = resolve(
      { database: 'appdb', client, connectionString: 'mongodb://127.0.0.1:2/' },
      'MongoDBStorage',
    )

    expect(connection.client).toBe(client)
    expect(connection.owned).toBe(false)
  })

  it('AT-011 — a client the package built is closed by close', async () => {
    const config = built()
    const connection = resolve(config, 'MongoDBStorage')
    const closing = vi.spyOn(connection.client, 'close')

    await close(config)

    expect(connection.owned).toBe(true)
    expect(closing).toHaveBeenCalledTimes(1)
  })
})

describe('AT-012 — one client per connection identity', () => {
  it('AT-012 — a hundred resolves of one config give one client', () => {
    const config = built()

    const clients = new Set(Array.from({ length: 100 }, () => resolve(config, 'MongoDBStorage').client))

    expect(clients.size).toBe(1)
    expect(REGISTRY.size).toBe(1)
  })

  it('AT-012 — separate config objects with the same URI share a client', () => {
    const first = resolve(built(), 'MongoDBStorage')
    const second = resolve({ ...built(), database: 'other' }, 'MongoDBMemoryStore')

    expect(second.client).toBe(first.client)
  })

  it('AT-012 — different URIs do not share', () => {
    const first = resolve(built(), 'MongoDBStorage')
    const second = resolve(built({ connectionString: 'mongodb://127.0.0.1:2/' }), 'MongoDBStorage')

    expect(second.client).not.toBe(first.client)
  })

  it('AT-012 — different clientOptions do not share, and each client gets its own', () => {
    const first = resolve(built({ clientOptions: { connectTimeoutMS: 1000 } }), 'MongoDBStorage')
    const second = resolve(built({ clientOptions: { connectTimeoutMS: 2000 } }), 'MongoDBStorage')

    expect(second.client).not.toBe(first.client)
    expect(first.client.options.connectTimeoutMS).toBe(1000)
    expect(second.client.options.connectTimeoutMS).toBe(2000)
  })

  it('AT-012 — the order of clientOptions keys does not matter', () => {
    const first = resolve(built({ clientOptions: { connectTimeoutMS: 1000, appName: 'a' } }), 'MongoDBStorage')
    const second = resolve(built({ clientOptions: { appName: 'a', connectTimeoutMS: 1000 } }), 'MongoDBStorage')

    expect(second.client).toBe(first.client)
  })

  it('AT-012 — empty clientOptions and absent clientOptions are one identity', () => {
    const first = resolve(built(), 'MongoDBStorage')
    const second = resolve(built({ clientOptions: {} }), 'MongoDBStorage')

    expect(second.client).toBe(first.client)
  })

  it('AT-012 — two injected clients are kept apart, even for one URI', () => {
    const a = inject()
    const b = inject()

    expect(resolve({ database: 'appdb', client: a }, 'MongoDBStorage').client).toBe(a)
    expect(resolve({ database: 'appdb', client: b }, 'MongoDBStorage').client).toBe(b)
    expect(REGISTRY.size).toBe(2)
  })

  it('AT-012 — close releases the entry, so a later resolve builds a fresh client', async () => {
    const config = built()
    const first = resolve(config, 'MongoDBStorage')

    await close(config)
    const second = resolve(config, 'MongoDBStorage')

    expect(second.client).not.toBe(first.client)
  })

  it('AT-012 — concurrent first use builds one client', async () => {
    const config = built()

    const connections = await Promise.all(
      Array.from({ length: 20 }, async () => {
        await Promise.resolve()
        return resolve(config, 'MongoDBStorage')
      }),
    )

    expect(new Set(connections.map((connection) => connection.client)).size).toBe(1)
  })
})

describe('AT-013a, AT-013b — every client carries the package’s driver info', () => {
  it('AT-013a — a built client’s handshake names the package after the driver', async () => {
    const { client } = resolve(built(), 'MongoDBStorage')

    const driver = (await metadata(client)).driver as { name: string; version: string }

    expect(DRIVER_NAME).toBe('Strands-MongoDB')
    expect(driver.name).toBe('nodejs|Strands-MongoDB')
    expect(driver.version.endsWith(`|${VERSION}`)).toBe(true)
  })

  it('AT-013b — an injected client is attributed through appendMetadata', async () => {
    const client = inject()

    resolve({ database: 'appdb', client }, 'MongoDBStorage')

    const driver = (await metadata(client)).driver as { name: string; version: string }
    expect(driver.name).toBe('nodejs|Strands-MongoDB')
    expect(driver.version.endsWith(`|${VERSION}`)).toBe(true)
  })

  it('AT-013b — repeated resolves leave exactly one entry for the package', () => {
    const client = inject()

    for (let i = 0; i < 5; i += 1) resolve({ database: 'appdb', client }, 'MongoDBStorage')

    const ours = driverInfoList(client).filter((info) => (info as { name?: string }).name === DRIVER_NAME)
    expect(ours).toHaveLength(1)
  })
})

describe('TS-025 — the package never sets, defaults or rewrites appName', () => {
  it('TS-025 — a built client has no appName unless the caller gives one', async () => {
    const { client } = resolve(built(), 'MongoDBStorage')

    expect(client.options.appName).toBeUndefined()
    expect((await metadata(client)).application).toBeUndefined()
  })

  it('TS-025 — an appName in the URI passes through', async () => {
    const { client } = resolve(built({ connectionString: `${UNREACHABLE}?appName=billing` }), 'MongoDBStorage')

    expect((await metadata(client)).application).toEqual({ name: 'billing' })
  })

  it('TS-025 — an appName in clientOptions passes through', async () => {
    const { client } = resolve(built({ clientOptions: { appName: 'billing' } }), 'MongoDBStorage')

    expect((await metadata(client)).application).toEqual({ name: 'billing' })
  })

  it('TS-025 — an injected client keeps its own appName', async () => {
    const client = inject(UNREACHABLE, { appName: 'billing' })

    resolve({ database: 'appdb', client }, 'MongoDBStorage')

    expect((await metadata(client)).application).toEqual({ name: 'billing' })
  })
})

describe('TS-026 — an injected client is attributed at most once', () => {
  it('TS-026 — three close-and-resolve cycles append once', async () => {
    const client = inject()
    const appending = vi.spyOn(MongoClient.prototype, 'appendMetadata')
    const config: MongoDBConfig = { database: 'appdb', client }

    for (let i = 0; i < 3; i += 1) {
      resolve(config, 'MongoDBStorage')
      await close(config)
    }

    expect(appending).toHaveBeenCalledTimes(1)
    expect(appending).toHaveBeenCalledWith({ name: DRIVER_NAME, version: VERSION })
  })

  it('TS-026 — the package’s name with another version is a different entry', () => {
    const client = inject(UNREACHABLE, { driverInfo: { name: DRIVER_NAME, version: '0.0.1' } })

    resolve({ database: 'appdb', client }, 'MongoDBStorage')

    const ours = driverInfoList(client).filter((info) => (info as { name?: string }).name === DRIVER_NAME)
    expect(ours).toHaveLength(2)
  })

  it('TS-026 — the comparison is case-sensitive, so a lowercase name is a different entry', () => {
    const client = inject(UNREACHABLE, { driverInfo: { name: DRIVER_NAME.toLowerCase(), version: VERSION } })

    resolve({ database: 'appdb', client }, 'MongoDBStorage')

    const names = driverInfoList(client).map((info) => (info as { name?: string }).name)
    expect(names).toEqual([DRIVER_NAME.toLowerCase(), DRIVER_NAME])
  })
})

describe('TS-027 — disabled retryWrites gets a warning rather than a refusal', () => {
  /** The warnings about retryWrites a recording logger received. */
  function warnings(records: LogCall[]): LogCall[] {
    return records.filter((record) => record.level === 'warn' && String(record.args[1]).includes('retryWrites'))
  }

  it.each<[string, () => MongoDBConfig]>([
    ['the URI', () => built({ connectionString: `${UNREACHABLE}?retryWrites=false` })],
    ['clientOptions', () => built({ clientOptions: { retryWrites: false } })],
    ['an injected client', () => ({ database: 'appdb', client: inject(UNREACHABLE, { retryWrites: false }) })],
  ])('TS-027 — retryWrites=false through %s warns, with the event fields first', (_, config) => {
    const { logger: kept, records } = recording()
    configureLogging(kept)

    resolve(config(), 'MongoDBStorage')

    const [warning] = warnings(records)
    expect(warnings(records)).toHaveLength(1)
    expect(warning?.args[0]).toEqual({ strands_mongodb_event: 'retry_writes_disabled' })
    expect(String(warning?.args[1])).toMatch(/^strands_mongodb: retryWrites is disabled on this MongoDB connection\./)
  })

  it('TS-027 — a hundred resolves of one config warn once', () => {
    const { logger: kept, records } = recording()
    configureLogging(kept)
    const config = built({ connectionString: `${UNREACHABLE}?retryWrites=false` })

    for (let i = 0; i < 100; i += 1) resolve(config, 'MongoDBStorage')

    expect(warnings(records)).toHaveLength(1)
  })

  it('TS-027 — the default config does not warn', () => {
    const { logger: kept, records } = recording()
    configureLogging(kept)

    const { client } = resolve(built(), 'MongoDBStorage')

    expect(client.options.retryWrites).toBe(true)
    expect(records).toEqual([])
  })
})

describe('TS-028 — a password in the connection string reaches no log, inspection or error', () => {
  it('TS-028 — logs at every level carry no password, the retryWrites warning included', () => {
    const { logger: kept, records } = recording()
    configureLogging(kept)

    resolve(built({ connectionString: LEAKY_URI }), 'MongoDBStorage')
    resolve(built({ connectionString: `${LEAKY_URI}?retryWrites=false` }), 'MongoDBStorage')

    expect(records.length).toBeGreaterThan(0)
    expect(JSON.stringify(records)).not.toContain(PASSWORD)
  })

  it('TS-028 — inspecting a connection or the registry shows no password, key passphrase or session token', () => {
    const connection = resolve(
      built({
        connectionString: LEAKY_URI,
        clientOptions: {
          tlsCertificateKeyFilePassword: 'PEMPASSPHRASE',
          authMechanismProperties: { AWS_SESSION_TOKEN: 'SESSIONTOKENSECRET' },
        },
      }),
      'MongoDBStorage',
    )

    for (const subject of [connection, REGISTRY]) {
      const text = inspect(subject, { depth: 6 })
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('PEMPASSPHRASE')
      expect(text).not.toContain('SESSIONTOKENSECRET')
    }
  })

  it('TS-028 — a client the driver refuses to build fails without the password in message or stack', () => {
    const caught = (() => {
      try {
        resolve(built({ connectionString: `${LEAKY_URI}?bogusOption=1&w=nonsense&wtimeoutMS=x` }), 'MongoDBStorage')
      } catch (error) {
        return error as Error
      }
      return undefined
    })()

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain(PASSWORD)
    expect(caught?.stack).not.toContain(PASSWORD)
    expect(REGISTRY.size).toBe(0)
  })
})

describe('TS-029 — concurrent closes of one config close its client once', () => {
  it('TS-029 — three closes at once neither throw nor close twice', async () => {
    const config = built()
    const { client } = resolve(config, 'MongoDBStorage')
    const closing = vi.spyOn(client, 'close')

    await expect(Promise.all([close(config), close(config), close(config)])).resolves.toBeDefined()

    expect(closing).toHaveBeenCalledTimes(1)
    expect(REGISTRY.size).toBe(0)
  })
})

describe('TS-030 — a new registry entry is an event on the span that caused it', () => {
  /** The `client.injected` flag of every `client.acquired` event on `span`, in order. */
  function acquired(span: ReadableSpan): boolean[] {
    return span.events
      .filter((event) => event.name === 'strands_mongodb.client.acquired')
      .map((event) => Boolean(event.attributes?.['strands_mongodb.client.injected']))
  }

  it('TS-030 — a built client marks the block once, and a cache hit adds nothing', () => {
    const spans = exportedSpans()

    trace.getTracer('the-application').startActiveSpan('host', (host) => {
      resolve(built(), 'MongoDBStorage')
      resolve(built(), 'MongoDBStorage')
      host.end()
    })

    expect(acquired(one(spans, 'host'))).toEqual([false])
  })

  it('TS-030 — an injected client says so', () => {
    const spans = exportedSpans()
    const client = inject()

    trace.getTracer('the-application').startActiveSpan('host', (host) => {
      resolve({ database: 'appdb', client }, 'MongoDBStorage')
      host.end()
    })

    expect(acquired(one(spans, 'host'))).toEqual([true])
  })
})
