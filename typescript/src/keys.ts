/**
 * Key and prefix normalisation, the key byte ceiling, the prefix join and the `_id` range a prefix scans.
 *
 * `normalizeKey` and `normalizePrefix` are copies of the SDK's, from `dist/src/storage/storage.js` in
 * `@strands-agents/sdk` 1.26.0, with their messages. The SDK does not export them and its `exports` map forbids
 * the deep path, so a copy is the only way to use them. `test/unit/keys.test.ts` drives the SDK's
 * `InMemoryStorage` over the same inputs, so a drift in the SDK fails a test rather than splitting key spaces.
 *
 * Normalising rejects and merges keys MongoDB would keep: `''` is a legal `_id`, and `a//b` and `a/b` are two
 * documents. Normalising anyway is the point. Every shipped backend does it, and a key set that collides on
 * one backend but not another breaks the `Storage` contract that changing the backend does not change the data.
 *
 * @packageDocumentation
 */
import { StorageError } from '@strands-agents/sdk'

import { MAX_KEY_BYTES } from './types.js'

/**
 * Bytes a stored document costs besides its key and payload: the 4-byte length, the `_id` and `data` element
 * headers, the whole `updated_at` element and the terminator. A test pins it to the BSON encoder.
 */
export const DOCUMENT_OVERHEAD_BYTES = 46

/** Bytes the `expires_at` element adds when a TTL is set. A test pins it to the BSON encoder. */
export const EXPIRES_OVERHEAD_BYTES = 20

/** The `_id` filter a prefix scan sends: empty for an unbounded scan, else a half-open range. */
export interface IdRange {
  _id?: { $gte: string; $lt?: string }
}

/** Characters of a key kept in an error message. */
const ABBREVIATE_AT = 60

const encoder = new TextEncoder()

/**
 * Normalise a storage key: collapse runs of `/`, strip slashes at either end, and reject `..` segments,
 * backslashes and keys that are empty once normalised. Copied from the SDK.
 *
 * @param key - The caller's key.
 * @returns The normalised key.
 * @throws StorageError If the key is empty, contains a backslash or contains a `..` segment.
 */
export function normalizeKey(key: string): string {
  if (key.includes('\\')) throw new StorageError(`Invalid storage key '${key}': backslashes are not allowed`)
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) throw new StorageError('Storage key must not be empty')
  if (segments.includes('..')) {
    throw new StorageError(`Invalid storage key '${key}': '..' path segments are not allowed`)
  }
  return segments.join('/')
}

/**
 * Normalise a key prefix by the same rules as {@link normalizeKey}, except that `''` is valid and matches
 * everything, and one trailing slash is kept. Copied from the SDK.
 *
 * The slash is significant rather than noise: `sessions/` must not match `sessions-archive/abc`, which is exactly
 * what stripping it would do.
 *
 * @param prefix - The caller's prefix.
 * @returns The normalised prefix.
 * @throws StorageError If the prefix contains a backslash or a `..` segment.
 */
export function normalizePrefix(prefix: string): string {
  if (prefix.includes('\\')) {
    throw new StorageError(`Invalid storage prefix '${prefix}': backslashes are not allowed`)
  }
  const parts = prefix.split('/')
  const segments = parts.filter(Boolean)
  if (segments.includes('..')) {
    throw new StorageError(`Invalid storage prefix '${prefix}': '..' path segments are not allowed`)
  }
  const joined = segments.join('/')
  return parts[parts.length - 1] === '' && joined ? `${joined}/` : joined
}

/**
 * Normalise an instance prefix to end in exactly one `/`, or to `''` when there is none.
 *
 * The convention the SDK's `namespace()` uses, so a prefix written as `tenant-a`, `tenant-a/` or `/tenant-a`
 * produces one key layout rather than three.
 *
 * @param prefix - The configured prefix.
 * @returns The prefix every `_id` of the instance starts with.
 * @throws StorageError If the prefix contains a backslash or a `..` segment.
 */
export function instancePrefix(prefix: string): string {
  const normalized = normalizePrefix(prefix).replace(/\/+$/, '')
  return normalized ? `${normalized}/` : ''
}

/**
 * Normalise a key, apply an instance prefix, and check the result against {@link MAX_KEY_BYTES}.
 *
 * @param prefix - The instance prefix, from {@link instancePrefix}.
 * @param key - The caller's key.
 * @param target - The `database.collection` the key is for, named in the error message.
 * @returns The `_id` to use.
 * @throws StorageError If the key is empty, contains a backslash or a `..` segment, or encodes to more than
 * {@link MAX_KEY_BYTES} bytes.
 */
export function idFor(prefix: string, key: string, target: string): string {
  const documentId = `${prefix}${normalizeKey(key)}`
  // Measure the prefixed form, since that is what becomes the index entry.
  const encoded = encoder.encode(documentId).length
  if (encoded > MAX_KEY_BYTES) {
    throw new StorageError(
      `MongoDBStorage: the key '${abbreviate(documentId)}' encodes to ${encoded} bytes, over the ` +
        `${MAX_KEY_BYTES}-byte limit this package applies to keys in ${target}. The limit is counted in UTF-8 ` +
        `bytes rather than characters.`,
    )
  }
  return documentId
}

/**
 * Build the `_id` filter for a prefix, as a range rather than a regular expression.
 *
 * The `_id` index serves a range. A `{ $regex: '^prefix' }` filter looks equivalent but scans the whole
 * collection unless the planner recognises the anchor, which no unit test would show.
 *
 * @param prefix - The instance prefix, from {@link instancePrefix}.
 * @param query - The caller's prefix, before normalisation.
 * @returns A filter document, empty when the query and the instance prefix are both empty.
 * @throws StorageError If the query contains a backslash or a `..` segment.
 */
export function rangeFor(prefix: string, query: string): IdRange {
  const lower = `${prefix}${normalizePrefix(query)}`
  if (!lower) return {}
  const upper = successor(lower)
  return upper === null ? { _id: { $gte: lower } } : { _id: { $gte: lower, $lt: upper } }
}

/**
 * The smallest string that sorts above every string starting with `text`: the upper bound of a range scan.
 *
 * Works on code points, as Python's string indexing does and as MongoDB compares, never on UTF-16 units.
 * Incrementing the last character fails on two inputs, both valid keys:
 * - U+D7FF would increment to U+D800, a lone surrogate that BSON cannot encode. Nothing sorts between the two,
 *   so jumping to U+E000 keeps the bound exact.
 * - U+10FFFF has no successor. Incrementing the character to its left is still an exact bound, and a prefix made
 *   only of U+10FFFF has no upper bound at all.
 *
 * @param text - The prefix the range starts at. Never empty: an empty prefix is an unfiltered query.
 * @returns The exclusive upper bound, or `null` when the range has none.
 */
export function successor(text: string): string | null {
  const points = Array.from(text, (character) => character.codePointAt(0) ?? 0)
  for (let index = points.length - 1; index >= 0; index--) {
    let point = (points[index] ?? 0) + 1
    if (point === 0xd800) point = 0xe000
    // Carry left. Every string starting with `text` also starts with this shorter prefix.
    if (point > 0x10ffff) continue
    return String.fromCodePoint(...points.slice(0, index), point)
  }
  return null
}

/**
 * Shorten a key for an error message, because a rejected key can be 1025 characters long.
 *
 * Counts code points, as Python's `len` does, so both packages abbreviate a key identically.
 *
 * @param key - The key to shorten.
 * @returns The key, or its first sixty characters and a count of the rest.
 */
export function abbreviate(key: string): string {
  const characters = Array.from(key)
  if (characters.length <= ABBREVIATE_AT) return key
  return `${characters.slice(0, ABBREVIATE_AT).join('')}[+${characters.length - ABBREVIATE_AT} more]`
}

/**
 * The size of the document `write` would build, without building it.
 *
 * Computed arithmetically because encoding a payload near 16 MiB only to measure it doubles peak memory on the
 * call most likely to be short of it. A test checks the result against the encoder, multi-byte keys included.
 *
 * @param id - The `_id` the document will carry, prefix included.
 * @param dataLength - The payload's length in bytes.
 * @param expires - Whether an `expires_at` element will be present.
 * @returns The number of bytes the encoded document will occupy.
 */
export function encodedSize(id: string, dataLength: number, expires: boolean): number {
  return DOCUMENT_OVERHEAD_BYTES + encoder.encode(id).length + dataLength + (expires ? EXPIRES_OVERHEAD_BYTES : 0)
}
