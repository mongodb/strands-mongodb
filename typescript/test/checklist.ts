/**
 * The contract checklist: 29 behaviours a user would notice if they were wrong, and the release-gate subset
 * (items 1 to 9 and 16 to 19). Numbers, gate flags and ids are held equal to `python/tests/test_gate.py` by
 * `test/gate/gate.test.ts`, so the two checklists cannot drift apart. The behaviour text is phrased for
 * TypeScript.
 *
 * Nothing in this file is evidence for an item. Ids here are data; only the leading ids of a test title count.
 */

/** A milestone of the build order in the design's §12.4. */
export type Milestone = 'M2' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | 'M9'

export interface ChecklistItem {
  /** The item's number in the checklist. */
  readonly number: number
  /** Whether the item is in the release gate. */
  readonly gate: boolean
  /** The behaviour, in short. */
  readonly behaviour: string
  /** The ids of the tests covering it. */
  readonly ids: readonly string[]
  /** The milestone by which every id has a test. See {@link LANDED_THROUGH}. */
  readonly landsIn: Milestone
}

export const CHECKLIST: readonly ChecklistItem[] = [
  {
    number: 1,
    gate: true,
    behaviour: 'a read of an absent key returns null rather than throwing',
    ids: ['AT-021'],
    landsIn: 'M6',
  },
  {
    number: 2,
    gate: true,
    behaviour: 'read throws StorageError for a failure other than a missing key',
    ids: ['AT-022'],
    landsIn: 'M6',
  },
  {
    number: 3,
    gate: true,
    behaviour: 'write overwrites an existing value rather than appending or erroring',
    ids: ['AT-020'],
    landsIn: 'M6',
  },
  {
    number: 4,
    gate: true,
    behaviour: 'bytes round-trip unchanged, including empty, every byte value and a large payload',
    ids: ['AT-024'],
    landsIn: 'M6',
  },
  { number: 5, gate: true, behaviour: 'delete of an absent key is a no-op', ids: ['AT-023'], landsIn: 'M6' },
  { number: 6, gate: true, behaviour: "list('') returns every key", ids: ['AT-025'], landsIn: 'M6' },
  {
    number: 7,
    gate: true,
    behaviour: 'list(prefix) returns full keys rather than suffixes',
    ids: ['AT-026'],
    landsIn: 'M6',
  },
  {
    number: 8,
    gate: true,
    behaviour: "list results sort lexicographically, asserted against the SDK's own sort",
    ids: ['AT-027'],
    landsIn: 'M6',
  },
  {
    number: 9,
    gate: true,
    behaviour: 'list on a prefix matching nothing returns an empty array',
    ids: ['AT-028'],
    landsIn: 'M6',
  },
  {
    number: 10,
    gate: false,
    behaviour: "keys normalise the SDK's way, so which keys collide is a documented decision",
    ids: ['AT-018', 'AT-019'],
    landsIn: 'M2',
  },
  {
    number: 11,
    gate: false,
    behaviour: "a key or prefix containing a '..' segment is rejected",
    ids: ['AT-018', 'AT-019'],
    landsIn: 'M2',
  },
  {
    number: 12,
    gate: false,
    behaviour: 'search scores are similarity-oriented, higher being better',
    ids: ['AT-032d', 'AT-033'],
    landsIn: 'M7',
  },
  {
    number: 13,
    gate: false,
    behaviour: 'scores stay in the documented range and data is populated as asked',
    ids: ['AT-032b', 'AT-033'],
    landsIn: 'M7',
  },
  {
    number: 14,
    gate: false,
    behaviour: 'a transport failure throws StorageError with the cause chained',
    ids: ['AT-022', 'AT-036', 'AT-080'],
    landsIn: 'M9',
  },
  {
    number: 15,
    gate: false,
    behaviour: 'the session-snapshot key shapes round-trip and UUID7 keys sort chronologically',
    ids: ['AT-027', 'AT-081'],
    landsIn: 'M6',
  },
  {
    number: 16,
    gate: true,
    behaviour: 'search returns MemoryEntry with content, storeName and the reserved metadata',
    ids: ['AT-040'],
    landsIn: 'M9',
  },
  {
    number: 17,
    gate: true,
    behaviour: 'maxSearchResults precedence, and below 1 throws a RangeError',
    ids: ['AT-041'],
    landsIn: 'M9',
  },
  {
    number: 18,
    gate: true,
    behaviour: 'adding identical content twice leaves one document and reports one duplicate',
    ids: ['AT-042'],
    landsIn: 'M9',
  },
  {
    number: 19,
    gate: true,
    behaviour: 'a concurrent duplicate insert surfaces as success, not a duplicate-key error',
    ids: ['AT-043'],
    landsIn: 'M9',
  },
  {
    number: 20,
    gate: false,
    behaviour: 'addMessages stays absent, so the SDK routes extraction through add',
    ids: ['AT-044a', 'AT-044b'],
    landsIn: 'M9',
  },
  {
    number: 21,
    gate: false,
    behaviour: 'initialize is idempotent and the first search performs it',
    ids: ['AT-045a', 'AT-045b'],
    landsIn: 'M9',
  },
  {
    number: 22,
    gate: false,
    behaviour: 'concurrent initialize across instances makes one client and one index set',
    ids: ['AT-012', 'AT-065'],
    landsIn: 'M5',
  },
  {
    number: 23,
    gate: false,
    behaviour: 'a filter naming an undeclared field throws an Error naming the field',
    ids: ['AT-049'],
    landsIn: 'M8',
  },
  {
    number: 24,
    gate: false,
    behaviour: 'a filter containing an MQL operator key is rejected with a TypeError',
    ids: ['AT-050a', 'AT-050b', 'AT-050c'],
    landsIn: 'M8',
  },
  {
    number: 25,
    gate: false,
    behaviour: "two scopes never see each other's documents, for search and for add",
    ids: ['AT-046', 'AT-047a', 'AT-047b'],
    landsIn: 'M9',
  },
  {
    number: 26,
    gate: false,
    behaviour: 'an injected client is never closed by the store',
    ids: ['AT-010', 'AT-011'],
    landsIn: 'M4',
  },
  {
    number: 27,
    gate: false,
    behaviour: 'driver metadata is attached on both construction paths',
    ids: ['AT-013a', 'AT-013b'],
    landsIn: 'M4',
  },
  {
    number: 28,
    gate: false,
    behaviour: 'an oversized payload throws StorageError naming the key, size and limit',
    ids: ['AT-029', 'AT-038a'],
    landsIn: 'M6',
  },
  {
    number: 29,
    gate: false,
    behaviour: 'vector on a deployment without search throws, auto degrades and reports',
    ids: ['AT-053a', 'AT-053c', 'AT-054'],
    landsIn: 'M9',
  },
]

/** Items 1 to 9 and 16 to 19. Written apart from the table so a flag flipped by accident contradicts it. */
export const RELEASE_GATE: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19])

const ORDER: readonly Milestone[] = ['M2', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']

/**
 * The last milestone whose items must already have tests.
 *
 * The gate is built first (M1), so for the milestones after it the table is complete but its tests are not.
 * Resolution of ids to tests is enforced for every item landing at or before this milestone. M10 sets it to
 * `'M9'`, and a conventions test then fails if it is ever lower, so the finished gate checks all 29 items.
 */
export const LANDED_THROUGH: Milestone | 'M1' = 'M6'

/** Whether an item's tests are expected to exist by {@link LANDED_THROUGH}. */
export function isDue(item: ChecklistItem): boolean {
  if (LANDED_THROUGH === 'M1') return false
  return ORDER.indexOf(item.landsIn) <= ORDER.indexOf(LANDED_THROUGH)
}
