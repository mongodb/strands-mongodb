/**
 * The shared client registry: one `MongoClient` per connection identity, and who may close it.
 *
 * Ported from `python/src/strands_mongodb/_client.py` without its event-loop dimension. Python keys a pool on
 * the loop as well, because an asyncio client is bound to the loop that built it. A Node process has one
 * event loop, so the identity here is the connection alone, and Python's closed-loop handling has nothing to
 * port.
 *
 * Two configs with the same identity share one client, so a hundred stores in one process open one pool
 * rather than a hundred. The identity is the injected client object, or a digest of the connection string and
 * the client options.
 *
 * Internal: not exported from the entry point.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto'

import { MongoClient } from 'mongodb'

import { event, eventFields, logger } from './telemetry.js'
import type { MongoDBConfig } from './types.js'
import { VERSION } from './version.js'

/** The name this package adds to the driver's handshake, so a server operator can see who connected. */
export const DRIVER_NAME = 'Strands-MongoDB'

/** The class whose constructor resolved the connection, named first in any error. */
export type Owner = 'MongoDBStorage' | 'MongoDBMemoryStore'

/** One registry entry: a client, and whether this package built it. */
export interface Connection {
  /** The driver client every store with this identity shares. */
  readonly client: MongoClient
  /** True when this package built the client and so may close it. An injected client is the caller's. */
  readonly owned: boolean
  /**
   * `<database>.<collection>` namespaces whose default collation was read and found binary. On the
   * connection rather than the store, so a namespace or a second store on the same collection does not ask
   * again. Only a collection that exists is added: an absent one can still be created with a collation.
   */
  readonly binaryKeys: Set<string>
  /**
   * What the deployment can run, from the capability probe, or `undefined` until it has run. On the
   * connection so the probe runs once per deployment rather than once per store.
   */
  capabilities?: Capabilities
  /** The tail of the chain {@link exclusive} queues setup on. Never rejects. */
  setup: Promise<void>
}

/** What a deployment answered when the memory store probed it. */
export interface Capabilities {
  /** Whether the deployment runs Atlas Search, so search indexes can be listed and queried. */
  readonly search: boolean
  /** The server error code that said it does not, when it does not. */
  readonly noSearchCode?: number
  /** Whether the deployment runs `$rankFusion`, which the hybrid tier is built on. */
  readonly rankFusion: boolean
}

/**
 * Run `body` once every setup queued on `connection` before it has settled.
 *
 * The lock guarding one-time setup, such as index creation, against concurrent stores on one deployment. A
 * promise chain rather than a mutex: Node has one thread, so the only interleaving is at an `await`, and
 * queuing each body behind the last is the whole of what a lock has to do. A body that throws releases the
 * chain all the same.
 *
 * @param connection - The shared connection.
 * @param body - The setup to run alone.
 * @returns What `body` returns.
 */
export function exclusive<T>(connection: Connection, body: () => Promise<T>): Promise<T> {
  const result = connection.setup.then(body)
  connection.setup = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Every live connection, keyed by identity: the injected client itself, or `uri:` and a digest.
 *
 * Exported so tests can clear it between cases.
 */
export const REGISTRY = new Map<string | MongoClient, Connection>()

/** Injected clients this package has already attributed, so a close-and-resolve cycle appends once. */
const ATTRIBUTED = new WeakSet<MongoClient>()

/** Tokens standing in for option values that do not serialise by value, one per object. */
const TOKENS = new WeakMap<object, number>()
let nextToken = 0

/**
 * The error for a config that names no connection.
 *
 * A `TypeError` because the config has the wrong shape, not an out-of-range value. Names both fields, since
 * either one would do.
 *
 * @param owner - The class being constructed.
 * @returns The message.
 */
const MISSING_CONNECTION = (owner: Owner): string =>
  `${owner}: the config needs a 'client' or a 'connectionString', and has neither`

/**
 * The warning for a connection with `retryWrites` turned off.
 *
 * A warning rather than a refusal: nothing is corrupted either way, but the package's upserts are written to
 * be replayed by the driver across a primary stepdown, and without retries that replay does not happen.
 *
 * @returns The message.
 */
const RETRY_WRITES_DISABLED = (): string =>
  "strands_mongodb: retryWrites is disabled on this MongoDB connection. strands_mongodb relies on the driver's " +
  'own retry to replay its idempotent upserts across a primary stepdown, and with retryWrites=false that ' +
  'replay does not happen: a write interrupted by an election surfaces to the caller instead. Nothing is ' +
  'corrupted either way. Remove retryWrites=false to restore the behavior this package was designed around.'

/**
 * The client for `config`, built and registered on first use, shared after that.
 *
 * Synchronous, because building a `MongoClient` does no I/O: two callers racing on first use cannot both
 * miss the registry. An injected client wins over a `connectionString` given beside it.
 *
 * @param config - The store's config.
 * @param owner - The class being constructed, for the error message.
 * @returns The shared connection.
 * @throws TypeError when the config has neither `client` nor `connectionString`. Nothing is registered.
 * @throws MongoParseError, from the driver, when it refuses the connection string or an option.
 */
export function resolve(config: MongoDBConfig, owner: Owner): Connection {
  const key = identity(config, owner)
  const existing = REGISTRY.get(key)
  if (existing !== undefined) return existing

  if (config.client !== undefined) {
    if (!ATTRIBUTED.has(config.client)) {
      config.client.appendMetadata({ name: DRIVER_NAME, version: VERSION })
      ATTRIBUTED.add(config.client)
    }
    return register(key, { client: config.client, owned: false, binaryKeys: new Set(), setup: Promise.resolve() })
  }
  const client = new MongoClient(config.connectionString as string, {
    ...config.clientOptions,
    driverInfo: { name: DRIVER_NAME, version: VERSION },
  })
  return register(key, { client, owned: true, binaryKeys: new Set(), setup: Promise.resolve() })
}

/**
 * Release `config`'s registry entry, closing the client only if this package built it.
 *
 * The entry goes before the close is awaited, so concurrent closes find nothing and the client closes once.
 * Closing twice, or closing a config that never resolved, does nothing.
 *
 * @param config - The store's config.
 */
export async function close(config: MongoDBConfig): Promise<void> {
  if (config.client === undefined && config.connectionString === undefined) return
  const key = identity(config, 'MongoDBStorage')
  const connection = REGISTRY.get(key)
  if (connection === undefined) return
  REGISTRY.delete(key)
  if (connection.owned) await connection.client.close()
}

/** Add `connection` under `key`, warning about disabled retries and marking the current span. */
function register(key: string | MongoClient, connection: Connection): Connection {
  REGISTRY.set(key, connection)
  if (connection.client.options.retryWrites === false) {
    logger.warn(eventFields('retry_writes_disabled'), RETRY_WRITES_DISABLED())
  }
  event('strands_mongodb.client.acquired', { 'strands_mongodb.client.injected': !connection.owned })
  return connection
}

/** The registry key for `config`: the injected client, or a digest of the URI and options. */
function identity(config: MongoDBConfig, owner: Owner): string | MongoClient {
  if (config.client !== undefined) return config.client
  if (config.connectionString === undefined) throw new TypeError(MISSING_CONNECTION(owner))
  const digest = createHash('sha256')
    .update(`${config.connectionString}\0${canonical(config.clientOptions ?? {})}`)
    .digest('hex')
  return `uri:${digest}`
}

/**
 * Serialise `value` so that equal options give equal text, whatever order their keys were written in.
 *
 * Plain objects and arrays are walked, and primitives serialise by value. Anything else (a class instance, a
 * function, a `Buffer`, a symbol, a `bigint`) becomes a token unique to that object, which errs towards
 * building a second client rather than sharing one between configs that differ.
 */
function canonical(value: unknown): string {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value as object)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`)
    return `{${entries.join(',')}}`
  }
  return `#${token(value)}`
}

/** A number unique to `value` for this process, or one per call for a value that cannot be a WeakMap key. */
function token(value: unknown): number {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return nextToken++
  const existing = TOKENS.get(value)
  if (existing !== undefined) return existing
  TOKENS.set(value, nextToken)
  return nextToken++
}
