/**
 * A real span pipeline for the tests that read spans, mirroring Python's `exported_spans` fixture.
 *
 * Importing this module installs one global tracer provider with one in-memory exporter, and an
 * `AsyncLocalStorage` context manager so a span opened inside an `await` sees its parent. OpenTelemetry will
 * not take a global provider back, so it is installed once per test file (Vitest isolates files) and
 * {@link exportedSpans} empties the exporter instead of adding a processor per test.
 *
 * A test file that does not import this one runs with no provider at all, which is the default most users
 * have, and `test/unit/telemetry-default.test.ts` relies on that.
 */
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

const exporter = new InMemorySpanExporter()

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))

/** The exporter every finished span reaches, emptied so a test sees only its own spans. */
export function exportedSpans(): InMemorySpanExporter {
  exporter.reset()
  return exporter
}

/** The finished spans called `name`, in the order they ended. */
export function named(spans: InMemorySpanExporter, name: string): ReadableSpan[] {
  return spans.getFinishedSpans().filter((span) => span.name === name)
}

/** The single finished span called `name`, failing with every span name if there is not exactly one. */
export function one(spans: InMemorySpanExporter, name: string): ReadableSpan {
  const found = named(spans, name)
  if (found.length !== 1) {
    const all = spans.getFinishedSpans().map((span) => span.name)
    throw new Error(`expected one ${JSON.stringify(name)}, got ${JSON.stringify(all)}`)
  }
  return found[0] as ReadableSpan
}

/** The finished spans called `name` whose parent is `parent`. */
export function children(spans: InMemorySpanExporter, parent: ReadableSpan, name: string): ReadableSpan[] {
  const id = parent.spanContext().spanId
  return named(spans, name).filter((span) => span.parentSpanContext?.spanId === id)
}

/** Everything a span carries that could hold caller data, as one string to search. */
export function rendered(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events.map(({ name, attributes }) => ({ name, attributes })),
  })
}
