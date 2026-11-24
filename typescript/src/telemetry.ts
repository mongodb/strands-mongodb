/**
 * OpenTelemetry spans and structured log fields for both stores, and the package's logger. The only module
 * that imports OpenTelemetry.
 *
 * Ported from `python/src/strands_mongodb/_telemetry.py`. The package configures no provider, exporter,
 * sampler or context manager. The tracer is looked up on every call, so a provider installed after import
 * still gets spans, and with none installed the no-op tracer costs a function call.
 *
 * Only allow-listed attributes are recorded. No span carries caller data: keys, content, metadata, query
 * text, filter values, scope or memory ids. {@link traced} reads the namespace it is handed, never the call's
 * arguments. {@link span}, {@link annotate} and {@link event} accept only names in {@link Attribute}, checked
 * by the compiler and again at runtime, where an unknown name is dropped rather than thrown, so a telemetry
 * typo never fails a write.
 *
 * Exceptions are recorded as a status and a class name, never a message. Thrown messages name the key and
 * the namespace, and spans are exported to third parties.
 *
 * @packageDocumentation
 */
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api'
import type { AttributeValue, Span } from '@opentelemetry/api'
import type { Logger } from '@strands-agents/sdk'

import { VERSION } from './version.js'

/** Every attribute name the package may set, one per row of the README's attribute table. */
export const ATTRIBUTES = [
  'strands_mongodb.store_name',
  'strands_mongodb.search.requested',
  'strands_mongodb.search.tier',
  'strands_mongodb.search.tiers',
  'strands_mongodb.result_count',
  'strands_mongodb.deleted_count',
  'strands_mongodb.found',
  'strands_mongodb.duplicate',
  'strands_mongodb.database',
  'strands_mongodb.collection',
  'strands_mongodb.client.injected',
  'strands_mongodb.indexes.mode',
  'strands_mongodb.indexes.created',
  'strands_mongodb.indexes.outcome',
  'strands_mongodb.indexes.probe',
] as const

/** An allow-listed attribute name. */
export type Attribute = (typeof ATTRIBUTES)[number]

/** Every span opened by {@link span} rather than {@link traced}: index work, as a child of the operation that needed it. */
export const SPAN_NAMES = [
  'strands_mongodb.indexes.ensure',
  'strands_mongodb.indexes.probe',
  'strands_mongodb.indexes.wait',
] as const

/** A child span's name. */
export type SpanName = (typeof SPAN_NAMES)[number]

/** The `strands_mongodb_event` value of every log record the package emits, one per message. */
export const LOG_EVENTS = [
  'retry_writes_disabled',
  'attribution_not_visible',
  'closed_loop_client_dropped',
  'reserved_key_collision',
  'no_search_setup',
  'tier_unavailable',
  'tier_building',
  'below_vector',
  'bound_declined_fusion',
  'score_bound_applied',
  'creating_indexes',
  'creating_search_index',
  'search_index_status',
  'attribute_dropped',
] as const

/** A log record's stable name. */
export type LogEvent = (typeof LOG_EVENTS)[number]

/** Every span event the package may add. */
export const EVENT_NAMES = ['strands_mongodb.client.acquired'] as const

/** A span event's name. */
export type EventName = (typeof EVENT_NAMES)[number]

/**
 * The operations that open a span of their own, named as Python names them so the two packages' spans group
 * together in one backend: `delete_prefix`, not `deletePrefix`.
 */
export interface Operations {
  readonly storage: 'write' | 'read' | 'delete' | 'list' | 'search' | 'delete_prefix' | 'ensure_indexes'
  readonly memory: 'initialize' | 'add' | 'search' | 'delete' | 'delete_all'
}

/** Which store a span belongs to. */
export type Surface = keyof Operations

/** The namespace every storage span carries. Read off the store, never off the call. */
export interface StorageSpanTarget {
  readonly database: string
  readonly collection: string
}

/** A memory span also carries the store's name. */
export interface MemorySpanTarget extends StorageSpanTarget {
  readonly storeName: string
}

/** The attributes of a span, keyed by allow-listed names only. */
export type SpanAttributes = Partial<Record<Attribute, AttributeValue>>

/** The structured fields every log record carries, passed first so Pino merges them into the record. */
export interface EventFields {
  readonly strands_mongodb_event: LogEvent
  readonly strands_mongodb_namespace?: string
  readonly strands_mongodb_tier?: string
}

/** The tracer's name: the npm package's, as Python's is the PyPI package's. */
const TRACER_NAME = 'strands-mongodb'

/** What `error.type` and the status hold for a thrown value that is not an `Error`, per the semantic conventions. */
const OTHER = '_OTHER'

/**
 * The record for an attribute dropped from a span.
 *
 * A debug record rather than a throw, because the name came from this package's own code and a typo in it
 * must not fail the caller's write. Quoted as Python's `%r` quotes it.
 *
 * @param name - The rejected attribute name.
 * @returns The message.
 */
const ATTRIBUTE_DROPPED = (name: string): string =>
  `strands_mongodb: dropped span attribute '${name}', which is not on the allow-list`

/** Does what the SDK's default logger does: `debug` and `info` are dropped, `warn` and `error` reach the console. */
const DEFAULT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

/**
 * The logger every record in this package goes through. A live binding: it follows {@link configureLogging}.
 *
 * Each call passes {@link eventFields} first and the message second, which is Pino's order.
 */
export let logger: Logger = DEFAULT_LOGGER

/**
 * Send this package's log records to `custom` instead of the default.
 *
 * The SDK's `configureLogging` sets the SDK's own logger, which it does not export, so this package cannot
 * write through it. An application that wants both packages' records calls both functions with one logger.
 *
 * @param custom - Any logger with `debug`, `info`, `warn` and `error`: Pino, `console`, or an adapter.
 *
 * @example
 * ```typescript
 * import pino from 'pino'
 * import { configureLogging as configureSdkLogging } from '@strands-agents/sdk'
 * import { configureLogging } from 'strands-mongodb'
 *
 * const log = pino({ level: 'debug' })
 * configureSdkLogging(log)
 * configureLogging(log)
 * ```
 */
export function configureLogging(custom: Logger): void {
  logger = custom
}

/**
 * Build the fields object for one log record, so a JSON logger can index it without parsing the message.
 *
 * Keys are prefixed `strands_mongodb_` as Python's are, so one log pipeline reads both packages. A field
 * that does not apply is omitted rather than set to `undefined`.
 *
 * @param event - The record's stable name.
 * @param where - `namespace`, as `<database>.<collection>`, and `tier`, where the record concerns one.
 * @returns The object to pass as a log call's first argument.
 */
export function eventFields(event: LogEvent, where: { namespace?: string; tier?: string } = {}): EventFields {
  return {
    strands_mongodb_event: event,
    ...(where.namespace === undefined ? {} : { strands_mongodb_namespace: where.namespace }),
    ...(where.tier === undefined ? {} : { strands_mongodb_tier: where.tier }),
  }
}

/**
 * Record one `INTERNAL` span named `strands_mongodb.<surface>.<operation>` around a store operation.
 *
 * Call it outermost, around the error reporting, so the span sees the `StorageError` the caller sees rather
 * than the driver error underneath.
 *
 * @param surface - `storage` or `memory`. A memory span also records the store's name.
 * @param operation - The operation, named as Python names it.
 * @param target - The store's namespace, and for memory its name. Never the call's arguments.
 * @param run - The operation's body.
 * @returns What `run` resolves to.
 * @throws Whatever `run` throws, as the same object, after the span is marked. Nothing of its own.
 */
export function traced<T>(
  surface: 'storage',
  operation: Operations['storage'],
  target: StorageSpanTarget,
  run: () => Promise<T>,
): Promise<T>
export function traced<T>(
  surface: 'memory',
  operation: Operations['memory'],
  target: MemorySpanTarget,
  run: () => Promise<T>,
): Promise<T>
export function traced<T>(
  surface: Surface,
  operation: string,
  target: StorageSpanTarget | MemorySpanTarget,
  run: () => Promise<T>,
): Promise<T> {
  const attributes: SpanAttributes = {
    'strands_mongodb.database': target.database,
    'strands_mongodb.collection': target.collection,
  }
  if ('storeName' in target) attributes['strands_mongodb.store_name'] = target.storeName
  return within(`strands_mongodb.${surface}.${operation}`, attributes, run)
}

/**
 * Open an `INTERNAL` child span under the current one, for work a store operation causes.
 *
 * Same rules as {@link traced}: the tracer is looked up on entry, attributes pass through the allow-list,
 * and a failure is recorded as a status and a class name, then rethrown unchanged. Inside it,
 * {@link annotate} sets attributes on this span rather than the operation's.
 *
 * @param name - An index span name.
 * @param attributes - Its starting attributes, usually the namespace and the mode or probe.
 * @param run - The work the span covers.
 * @returns What `run` resolves to.
 * @throws Whatever `run` throws, as the same object, after the span is marked. Nothing of its own.
 */
export function span<T>(name: SpanName, attributes: SpanAttributes, run: () => Promise<T>): Promise<T> {
  return within(name, kept(attributes), run)
}

/**
 * Set an outcome attribute on the current span, which inside a store operation is the operation's own.
 *
 * A no-op with no provider or outside any span, so call sites need no conditionals.
 *
 * @param name - An allow-listed attribute name.
 * @param value - A count, flag, tier name or configuration value. Never anything the caller supplied.
 */
export function annotate(name: Attribute, value: AttributeValue): void {
  if (allowed(name)) trace.getSpan(context.active())?.setAttribute(name, value)
}

/**
 * Add an event to the current span, keeping only allow-listed attributes.
 *
 * @param name - The event name.
 * @param attributes - The event's attributes.
 */
export function event(name: EventName, attributes: SpanAttributes): void {
  trace.getSpan(context.active())?.addEvent(name, kept(attributes))
}

/** Run `body` inside a new active span, marking it on a throw and ending it either way. */
function within<T>(name: string, attributes: SpanAttributes, body: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME, VERSION)
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (current) => {
    try {
      return await body()
    } catch (error) {
      mark(current, error)
      throw error
    } finally {
      current.end()
    }
  })
}

/** The allow-listed entries of `attributes`, each rejected name logged. */
function kept(attributes: SpanAttributes): SpanAttributes {
  return Object.fromEntries(Object.entries(attributes).filter(([name]) => allowed(name)))
}

/** Whether `name` is on the allow-list, logging at debug when it is not. */
function allowed(name: string): name is Attribute {
  if ((ATTRIBUTES as readonly string[]).includes(name)) return true
  logger.debug(eventFields('attribute_dropped'), ATTRIBUTE_DROPPED(name))
  return false
}

/** Record a failure as `ERROR` with the class name, and `error.type`, never the message. */
function mark(current: Span, error: unknown): void {
  const kind = error instanceof Error ? error.constructor.name : OTHER
  current.setStatus({ code: SpanStatusCode.ERROR, message: kind })
  current.setAttribute('error.type', kind)
}
