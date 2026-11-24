/**
 * Turns driver errors into the SDK's `StorageError`, so a caller catches one class whatever went wrong
 * underneath, and still reaches the driver's error through `cause`.
 *
 * Ported from the two `_reporting` decorators in `python/src/strands_mongodb/storage.py` and
 * `memory_store.py`. Messages start with the class name rather than Python's `strands_mongodb:`, because a
 * JavaScript stack trace names the error's class and not the module that threw it.
 *
 * Only `MongoError` is wrapped. A `RangeError` or `TypeError` this package throws for a bad argument, and a
 * `StorageError` it throws itself, pass through as the same object.
 *
 * @packageDocumentation
 */
import { StorageError } from '@strands-agents/sdk'
import { MongoError } from 'mongodb'

import { abbreviate } from './keys.js'

/** What a `MongoDBStorage` operation was doing, as a present participle, for the message. */
export type StorageVerb = 'writing' | 'reading' | 'deleting' | 'listing' | 'searching' | 'deleting the prefix'

/** What a `MongoDBMemoryStore` operation was doing, phrased to read on into the namespace. */
export type MemoryVerb =
  'initializing' | 'adding a memory to' | 'searching' | 'deleting a memory from' | 'deleting every memory in'

/**
 * Run one storage operation, turning any driver error it throws into `StorageError`.
 *
 * It wraps the whole operation rather than one call, because `list` throws while its cursor drains, after
 * `find` has returned. Wrapping only the call would let that driver error escape.
 *
 * @param verb - What the operation was doing.
 * @param subject - The key or prefix, abbreviated in the message because a rejected key can be 1025
 *   characters long.
 * @param target - The namespace, as `<database>.<collection>`.
 * @param run - The operation's body.
 * @returns What `run` resolves to.
 * @throws StorageError when `run` throws a `MongoError`, with that error as `cause`. Anything else `run`
 *   throws, as the same object.
 */
export async function reportingStorage<T>(
  verb: StorageVerb,
  subject: string,
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof MongoError)) throw error
    throw new StorageError(`MongoDBStorage: ${verb} '${abbreviate(subject)}' in ${target} failed: ${error.message}`, {
      cause: error,
    })
  }
}

/**
 * Run one memory operation, turning any driver error it throws into `StorageError`.
 *
 * Unlike {@link reportingStorage}, the message names only the namespace and takes no subject. The subject
 * of a memory operation is user content, which must never reach an error, a log line or a stack trace.
 *
 * @param verb - What the operation was doing.
 * @param target - The namespace, as `<database>.<collection>`.
 * @param run - The operation's body.
 * @returns What `run` resolves to.
 * @throws StorageError when `run` throws a `MongoError`, with that error as `cause`. Anything else `run`
 *   throws, as the same object.
 */
export async function reportingMemory<T>(verb: MemoryVerb, target: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof MongoError)) throw error
    throw new StorageError(`MongoDBMemoryStore: ${verb} ${target} failed: ${error.message}`, { cause: error })
  }
}
