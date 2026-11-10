/**
 * The release gate's logic, as pure functions so each judgement is testable without staging a whole run.
 *
 * A test proves a checklist item when the run of ids that opens its title (before an em dash) names it:
 * `it('AT-021 — a read of an absent key returns null', ...)`. Only that leading run counts, which is the
 * same guard as the Python suite's "first paragraph only": an id mentioned later in a title is never evidence.
 */

const ID = String.raw`(?:AT|CH|MP|TS)-[0-9]{1,3}[a-z]*`

/** An id as it appears in a title. Python's pattern plus the `TS-` prefix for behaviour only this package has. */
export const ID_PATTERN = new RegExp(String.raw`\b(${ID})`, 'g')

const LEADING = new RegExp(String.raw`^\s*(${ID}(?:\s*(?:,|/|&)\s*${ID})*)\s+—\s`)
const LOOKS_LIKE_AN_ID = /^\s*(?:AT|CH|MP|TS)-/

/** The ids that open a title, or none when the title has no leading run followed by an em dash. */
export function leadingIds(title: string): string[] {
  const match = LEADING.exec(title)
  if (match?.[1] === undefined) return []
  return match[1].match(ID_PATTERN) ?? []
}

/** Whether a title starts like an id but not in the form that counts as evidence, such as `AT-21 - x`. */
export function isMalformedLeading(title: string): boolean {
  return LOOKS_LIKE_AN_ID.test(title) && leadingIds(title).length === 0
}

/**
 * Leading ids that are neither a checklist id nor a `TS-` id. A typo cannot pass as evidence, because it
 * would otherwise be an id no item names and nothing would notice.
 */
export function unknownLeadingIds(ids: readonly string[], checklistIds: ReadonlySet<string>): string[] {
  return ids.filter((id) => !id.startsWith('TS-') && !checklistIds.has(id))
}

export interface Outcome {
  readonly state: 'passed' | 'failed' | 'skipped' | 'pending'
  /** Why the test skipped, or empty. */
  readonly detail: string
}

export interface GateItem {
  readonly number: number
  readonly ids: readonly string[]
}

export interface Verdict {
  /** Sentences naming the items involved. Empty when there are none. */
  readonly problems: string[]
  /** Item number to the reasons its tests gave for not producing a pass. A skip, not a failure. */
  readonly unverified: Map<number, string[]>
}

/**
 * Classify checklist items against what a run's tests did.
 *
 * @param items - The items to judge.
 * @param byId - Test node ids by checklist id, as collected from titles.
 * @param outcomes - What each node did. A node with no entry never ran.
 * @param narrowing - A description of anything that kept tests out of the run. With it, an item with no
 * collected test is unverified rather than missing.
 */
export function judge(
  items: Iterable<GateItem>,
  byId: ReadonlyMap<string, readonly string[]>,
  outcomes: ReadonlyMap<string, Outcome>,
  narrowing = '',
): Verdict {
  const absent: number[] = []
  const failed: Record<number, string[]> = {}
  const unrun: Record<number, string[]> = {}
  const unverified = new Map<number, string[]>()

  for (const item of items) {
    const nodes = [...new Set(item.ids.flatMap((id) => byId.get(id) ?? []))].sort()
    if (nodes.length === 0) {
      if (narrowing) unverified.set(item.number, [`deselected by ${narrowing}`])
      else absent.push(item.number)
      continue
    }
    const never = nodes.filter((node) => !outcomes.has(node))
    if (never.length > 0) unrun[item.number] = never
    const seen = nodes.flatMap((node) => {
      const outcome = outcomes.get(node)
      return outcome === undefined ? [] : [{ node, outcome }]
    })
    const broke = seen.filter(({ outcome }) => outcome.state === 'failed').map(({ node }) => node)
    if (broke.length > 0) failed[item.number] = broke
    if (!seen.some(({ outcome }) => outcome.state === 'passed')) {
      const reasons = [...new Set(seen.map(({ outcome }) => outcome.detail).filter((d) => d !== ''))].sort()
      unverified.set(item.number, reasons.length > 0 ? reasons : ['no reason recorded'])
    }
  }

  const problems: string[] = []
  if (absent.length > 0) problems.push(`no test at all for items [${absent.join(', ')}]`)
  if (Object.keys(failed).length > 0) problems.push(`failing tests: ${JSON.stringify(failed)}`)
  if (Object.keys(unrun).length > 0) problems.push(`tests that never ran: ${JSON.stringify(unrun)}`)
  return { problems, unverified }
}

/** Group unverified items by their reasons, which is how a missing variable skipping a dozen items reads best. */
export function describeUnverified(unverified: ReadonlyMap<number, readonly string[]>): string {
  const grouped = new Map<string, number[]>()
  for (const [number, reasons] of [...unverified].sort(([a], [b]) => a - b)) {
    const key = reasons.join(' / ')
    grouped.set(key, [...(grouped.get(key) ?? []), number])
  }
  return [...grouped].map(([reasons, numbers]) => `items [${numbers.join(', ')}]: ${reasons}`).join('; ')
}
