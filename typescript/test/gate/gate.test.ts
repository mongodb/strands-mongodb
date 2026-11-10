import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKLIST, RELEASE_GATE, isDue, LANDED_THROUGH } from '../checklist.js'
import {
  describeUnverified,
  isMalformedLeading,
  judge,
  leadingIds,
  unknownLeadingIds,
  type GateItem,
  type Outcome,
} from '../support/gate.js'
import { TEST_ROOT, scanTitles, testFiles } from '../support/scan.js'

const PYTHON_GATE = join(TEST_ROOT, '..', '..', 'python', 'tests', 'test_gate.py')

describe('TS-002 — the checklist table is whole', () => {
  it('the twenty-nine items are each here once', () => {
    expect(CHECKLIST.map((item) => item.number)).toEqual(Array.from({ length: 29 }, (_, i) => i + 1))
  })

  it('the release gate is items 1 to 9 and 16 to 19, and the flags agree with the separate set', () => {
    expect(new Set(CHECKLIST.filter((item) => item.gate).map((item) => item.number))).toEqual(RELEASE_GATE)
  })

  it('every item names a test and describes its behaviour', () => {
    expect(CHECKLIST.filter((item) => item.ids.length === 0).map((item) => item.number)).toEqual([])
    expect(CHECKLIST.filter((item) => item.behaviour.length < 20).map((item) => item.number)).toEqual([])
  })
})

describe('TS-003 — the checklist is held equal to the Python one', () => {
  const source = readFileSync(PYTHON_GATE, 'utf8')
  const block = source.slice(source.indexOf('CHECKLIST: tuple'), source.indexOf('RELEASE_GATE ='))
  const pattern = /Item\(\s*(\d+),\s*(True|False),\s*"[^"]*",\s*\(([^)]*)\)\s*,?\s*\)/g
  const python = [...block.matchAll(pattern)].map((m) => ({
    number: Number(m[1]),
    gate: m[2] === 'True',
    ids: [...(m[3] ?? '').matchAll(/"([^"]+)"/g)].map((id) => id[1]),
  }))

  it('the parse found all twenty-nine Python items, so the comparison below is not vacuous', () => {
    expect(python).toHaveLength(29)
  })

  it('numbers, gate flags and ids match item for item', () => {
    expect(CHECKLIST.map(({ number, gate, ids }) => ({ number, gate, ids: [...ids] }))).toEqual(python)
  })
})

describe('TS-004 — ids resolve to tests, and only well-formed ids count', () => {
  const titles = scanTitles()

  it('the scan finds this suite, so the checks below are not vacuous', () => {
    expect(testFiles().length).toBeGreaterThan(0)
    expect(titles.length).toBeGreaterThan(0)
  })

  it('every id of every item due by the last landed milestone is declared by some test title', () => {
    const declared = new Set(titles.flatMap(({ title }) => leadingIds(title)))
    const unresolved = CHECKLIST.filter(isDue)
      .map((item) => ({ number: item.number, missing: item.ids.filter((id) => !declared.has(id)) }))
      .filter((entry) => entry.missing.length > 0)
    expect(unresolved, `milestones through ${LANDED_THROUGH} are due`).toEqual([])
  })

  it('no title starts like an id without being one that counts', () => {
    expect(titles.filter(({ title }) => isMalformedLeading(title))).toEqual([])
  })

  it('every leading id is a checklist id or a TS- id', () => {
    const known = new Set(CHECKLIST.flatMap((item) => item.ids))
    const unknown = titles.flatMap(({ file, title }) =>
      unknownLeadingIds(leadingIds(title), known).map((id) => `${file}: ${id}`),
    )
    expect(unknown).toEqual([])
  })
})

describe('TS-005 — reading ids from a title', () => {
  it('a leading run before an em dash counts, with , / & separators', () => {
    expect(leadingIds('AT-021 — x')).toEqual(['AT-021'])
    expect(leadingIds('AT-050a, AT-050b / TS-001 — x')).toEqual(['AT-050a', 'AT-050b', 'TS-001'])
  })

  it('an id after the dash, or with no dash, is not evidence', () => {
    expect(leadingIds('reads an absent key — AT-021')).toEqual([])
    expect(leadingIds('reads an absent key (AT-021)')).toEqual([])
    expect(leadingIds('AT-021 reads an absent key')).toEqual([])
  })

  it('a title that starts like an id without counting is malformed, and an ordinary title is not', () => {
    expect(isMalformedLeading('AT-21 - x')).toBe(true)
    expect(isMalformedLeading('AT-021 x')).toBe(true)
    expect(isMalformedLeading('AT-021 — x')).toBe(false)
    expect(isMalformedLeading('a read returns null')).toBe(false)
  })

  it('an id that is neither a checklist id nor a TS- id is unknown', () => {
    expect(unknownLeadingIds(['AT-021', 'AT-999', 'TS-123'], new Set(['AT-021']))).toEqual(['AT-999'])
  })
})

describe('TS-006 — the verdict the gate reaches', () => {
  const item: GateItem = { number: 1, ids: ['AT-999'] }
  const passed: Outcome = { state: 'passed', detail: '' }

  it('a passing test leaves nothing to report', () => {
    const { problems, unverified } = judge([item], new Map([['AT-999', ['t::one']]]), new Map([['t::one', passed]]))
    expect(problems).toEqual([])
    expect(unverified.size).toBe(0)
  })

  it('a failing test is a problem naming the item and the node', () => {
    const { problems } = judge(
      [item],
      new Map([['AT-999', ['t::one']]]),
      new Map([['t::one', { state: 'failed', detail: '' }]]),
    )
    expect(problems).toEqual(['failing tests: {"1":["t::one"]}'])
  })

  it('one pass among several carriers covers the item, but a failure among them is still reported', () => {
    const { problems, unverified } = judge(
      [item],
      new Map([['AT-999', ['t::one', 't::two']]]),
      new Map<string, Outcome>([
        ['t::one', passed],
        ['t::two', { state: 'failed', detail: '' }],
      ]),
    )
    expect(problems).toEqual(['failing tests: {"1":["t::two"]}'])
    expect(unverified.size).toBe(0)
  })

  it('every carrier skipping is unverified rather than a problem', () => {
    const skipped: Outcome = { state: 'skipped', detail: 'Skipped: needs MONGODB_URI' }
    const { problems, unverified } = judge([item], new Map([['AT-999', ['t::one']]]), new Map([['t::one', skipped]]))
    expect(problems).toEqual([])
    expect(describeUnverified(unverified)).toBe('items [1]: Skipped: needs MONGODB_URI')
  })

  it('a carrier with no recorded outcome is a problem, because it never ran', () => {
    const { problems } = judge([item], new Map([['AT-999', ['t::one']]]), new Map())
    expect(problems).toEqual(['tests that never ran: {"1":["t::one"]}'])
  })

  it('an item with no test fails a whole run and is unverified in a narrowed one', () => {
    expect(judge([item], new Map(), new Map()).problems).toEqual(['no test at all for items [1]'])
    const narrowed = judge([item], new Map(), new Map(), '--project unit')
    expect(narrowed.problems).toEqual([])
    expect(describeUnverified(narrowed.unverified)).toBe('items [1]: deselected by --project unit')
  })

  it('items skipping for the same reason are grouped into one sentence', () => {
    const reason = ['Skipped: needs MONGODB_URI']
    expect(
      describeUnverified(
        new Map([
          [2, reason],
          [1, reason],
        ]),
      ),
    ).toBe('items [1, 2]: Skipped: needs MONGODB_URI')
  })
})
