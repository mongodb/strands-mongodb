/**
 * Driver failures become the SDK's `StorageError`, with the driver error as its `cause`.
 *
 * Ports the two `_reporting` decorators in `python/src/strands_mongodb/storage.py` and `memory_store.py` on
 * their own, so these lead with `TS-` ids. The per-operation half, every `MongoDBStorage` entry point
 * raising `StorageError` (AT-022, AT-036), is in `test/unit/storage.test.ts`. Checklist item 14 also needs
 * the memory store's half, AT-080, and closes in M9.
 *
 * Mock-driven, as Python's are: a transport failure is not something a healthy deployment produces on cue.
 */
import { StorageError } from '@strands-agents/sdk'
import { MongoNetworkError, MongoServerError } from 'mongodb'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { reportingMemory, reportingStorage } from '../../src/errors.js'

const TARGET = 'appdb.storage'

/** What a dropped connection looks like to the driver. */
function networkFailure(): MongoNetworkError {
  return new MongoNetworkError('connection 1 to localhost:27017 closed')
}

/** A run that fails the way `run` would after `await`ing the driver. */
function failing(error: unknown): () => Promise<never> {
  return async () => {
    await Promise.resolve()
    throw error
  }
}

describe('TS-022 — a storage operation turns a driver error into StorageError', () => {
  it('TS-022 — the message names the verb, the key and the namespace, and the cause is the driver error', async () => {
    const failure = networkFailure()

    const caught = await reportingStorage('reading', 'a/b', TARGET, failing(failure)).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(StorageError)
    expect((caught as StorageError).message).toBe(
      "MongoDBStorage: reading 'a/b' in appdb.storage failed: connection 1 to localhost:27017 closed",
    )
    expect((caught as StorageError).cause).toBe(failure)
  })

  it('TS-022 — a server error is wrapped too, because every driver error is a MongoError', async () => {
    const failure = new MongoServerError({ message: 'not primary', code: 10107 })

    const caught = await reportingStorage('writing', 'k', TARGET, failing(failure)).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(StorageError)
    expect((caught as StorageError).cause).toBe(failure)
  })

  it('TS-022 — a key over 60 characters is abbreviated, because a rejected key can be 1025 long', async () => {
    const key = 'k'.repeat(1025)

    await expect(reportingStorage('deleting', key, TARGET, failing(networkFailure()))).rejects.toThrow(
      `MongoDBStorage: deleting '${'k'.repeat(60)}[+965 more]' in appdb.storage failed:`,
    )
  })

  it("TS-022 — list('') names the empty prefix as ''", async () => {
    await expect(reportingStorage('listing', '', TARGET, failing(networkFailure()))).rejects.toThrow(
      "MongoDBStorage: listing '' in appdb.storage failed:",
    )
  })

  it('TS-022 — a failure while a cursor drains, after the first await, is wrapped too', async () => {
    const failure = networkFailure()
    async function* cursor(): AsyncGenerator<string> {
      yield 'a'
      throw failure
    }

    const caught = await reportingStorage('listing', 'p/', TARGET, async () => {
      const keys: string[] = []
      for await (const key of cursor()) keys.push(key)
      return keys
    }).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(StorageError)
    expect((caught as StorageError).cause).toBe(failure)
  })

  it('TS-022 — an error that is not the driver’s passes through as the same object', async () => {
    for (const error of [new StorageError('MongoDBStorage: the key is too long'), new RangeError('x'), 'thrown']) {
      await expect(reportingStorage('writing', 'k', TARGET, failing(error))).rejects.toBe(error)
    }
  })

  it('TS-022 — a success comes back unchanged', async () => {
    await expect(reportingStorage('reading', 'k', TARGET, async () => new Uint8Array([1]))).resolves.toEqual(
      new Uint8Array([1]),
    )
  })

  it('TS-022 — the verbs are the Python ones', () => {
    // Checked by the compiler, never called.
    expectTypeOf(() =>
      // @ts-expect-error not a verb a storage operation reports.
      reportingStorage('fetching', 'k', TARGET, async () => undefined),
    ).toBeFunction()
  })
})

describe('TS-023 — a memory operation turns a driver error into StorageError, naming no content', () => {
  it('TS-023 — the message names the verb and the namespace only, and the cause is the driver error', async () => {
    const failure = networkFailure()

    const caught = await reportingMemory('adding a memory to', 'appdb.memory', failing(failure)).catch(
      (error: unknown) => error,
    )

    expect(caught).toBeInstanceOf(StorageError)
    expect((caught as StorageError).message).toBe(
      'MongoDBMemoryStore: adding a memory to appdb.memory failed: connection 1 to localhost:27017 closed',
    )
    expect((caught as StorageError).cause).toBe(failure)
  })

  it('TS-023 — an error that is not the driver’s passes through as the same object', async () => {
    const error = new TypeError('MongoDBMemoryStore: a filter key may not start with $')

    await expect(reportingMemory('searching', 'appdb.memory', failing(error))).rejects.toBe(error)
  })

  it('TS-023 — a success comes back unchanged', async () => {
    await expect(reportingMemory('deleting every memory in', 'appdb.memory', async () => 4)).resolves.toBe(4)
  })

  it('TS-023 — there is no argument a memory subject could travel through', () => {
    // Checked by the compiler, never called.
    expectTypeOf(() =>
      // @ts-expect-error a memory operation's subject is user content, so the wrapper takes none.
      reportingMemory('searching', 'MARKER-CONTENT', 'appdb.memory', async () => undefined),
    ).toBeFunction()
  })
})
