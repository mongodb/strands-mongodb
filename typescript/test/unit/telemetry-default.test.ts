/**
 * The default most users have: no tracer provider at all.
 *
 * Kept in its own file because `test/support/spans.ts` installs a global provider that OpenTelemetry will not
 * take back, and Vitest isolates files, so this one never sees it. Ports Python's
 * `test_a_real_store_with_no_provider_installed_behaves_as_if_undecorated` (AT-207), which runs in a
 * subprocess for the same reason.
 */
import { ProxyTracerProvider, trace } from '@opentelemetry/api'
import { StorageError } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { annotate, event, span, traced } from '../../src/telemetry.js'

const STORAGE = { database: 'appdb', collection: 'kv' } as const

describe('TS-016 — with no provider installed, a traced call behaves as if it were not traced', () => {
  it('TS-016 — the provider is the proxy, and nothing has replaced it', () => {
    expect(trace.getTracerProvider()).toBeInstanceOf(ProxyTracerProvider)
  })

  it('TS-016 — the value comes back, and annotate and event inside it are no-ops', async () => {
    const value = await traced('storage', 'read', STORAGE, async () => {
      annotate('strands_mongodb.found', true)
      event('strands_mongodb.client.acquired', { 'strands_mongodb.client.injected': false })
      return span('strands_mongodb.indexes.probe', { 'strands_mongodb.indexes.probe': 'collation' }, async () => 7)
    })

    expect(value).toBe(7)
  })

  it('TS-016 — the error thrown is the very object the body threw, with its message', async () => {
    const failure = new StorageError("MongoDBStorage: reading 'k' in appdb.kv failed: closed")

    await expect(
      traced('storage', 'read', STORAGE, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })
})
