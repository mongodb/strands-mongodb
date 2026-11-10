/**
 * Collects each test's leading ids and its outcome, and passes the release-gate verdict at the end of a run.
 *
 * A Vitest test runs in a worker and cannot see what the other projects did, so the run-wide half of the
 * gate lives here, in the process that sees every result. The `gate` project holds the static half: the
 * table's shape, its equality with the Python checklist, and the resolution of ids to tests.
 *
 * The verdict is only reached when the `gate` project is part of the run, so `npm test -- --project unit`
 * is not held to a gate it never asked for. Then, as `ChecklistGate` does for pytest:
 * - a gate item with a failing test, or one that is missing from a whole run, fails the run;
 * - a gate item whose every test skipped is reported as unverified, never as passed;
 * - a leading id that is neither a checklist id nor a `TS-` id fails the run.
 */
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node'
import { CHECKLIST, RELEASE_GATE, isDue } from '../checklist.js'
import { describeUnverified, isMalformedLeading, judge, leadingIds, unknownLeadingIds, type Outcome } from './gate.js'

const NEEDS = /\[needs ([A-Z_]+)\]/

function titlesOf(test: TestCase): string[] {
  const titles: string[] = []
  let node: TestCase['parent'] | TestModule = test.parent
  while (node.type === 'suite') {
    titles.unshift(node.name)
    node = node.parent
  }
  return titles
}

function outcomeOf(test: TestCase): Outcome {
  const result = test.result()
  if (result.state !== 'skipped') return { state: result.state, detail: '' }
  const needs = NEEDS.exec(test.fullName)?.[1]
  const detail = result.note ?? (needs === undefined ? 'skipped' : `Skipped: needs ${needs}`)
  return { state: 'skipped', detail }
}

export default class GateReporter implements Reporter {
  private narrowing = ''

  onInit(vitest: Vitest): void {
    const narrowing: string[] = []
    const config = vitest.config as { project?: string[]; testNamePattern?: RegExp }
    if (config.project !== undefined && config.project.length > 0) {
      narrowing.push(`--project ${config.project.join(',')}`)
    }
    if (config.testNamePattern !== undefined) narrowing.push(`-t ${String(config.testNamePattern)}`)
    this.narrowing = narrowing.join(', ')
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    if (!modules.some((module) => module.project.name === 'gate')) return

    const byId = new Map<string, string[]>()
    const outcomes = new Map<string, Outcome>()
    const checklistIds = new Set(CHECKLIST.flatMap((item) => item.ids))
    const bad: string[] = []
    const fromClass: Array<[string, string]> = []
    const own = new Set<string>()

    const add = (id: string, node: string): void => {
      byId.set(id, [...(byId.get(id) ?? []), node])
    }

    for (const module of modules) {
      for (const test of module.children.allTests()) {
        const node = `${module.moduleId}::${test.fullName}`
        outcomes.set(node, outcomeOf(test))
        const titles = [...titlesOf(test), test.name]
        for (const title of titles) {
          if (isMalformedLeading(title)) bad.push(`${node}: "${title}" starts like an id but not as "ID — "`)
        }
        const mine = leadingIds(test.name)
        for (const id of unknownLeadingIds(mine, checklistIds)) bad.push(`${node}: unknown id ${id}`)
        for (const id of mine) {
          own.add(id)
          add(id, node)
        }
        // An id on a describe covers the tests inside it, unless some test declares that id for itself.
        for (const title of titlesOf(test)) for (const id of leadingIds(title)) fromClass.push([id, node])
      }
    }
    for (const [id, node] of fromClass) if (!own.has(id)) add(id, node)

    // Items whose milestone has not landed cannot fail the run yet, but they are never reported as passed.
    const gated = CHECKLIST.filter((item) => RELEASE_GATE.has(item.number))
    const { problems, unverified } = judge(gated.filter(isDue), byId, outcomes, this.narrowing)
    for (const item of gated.filter((item) => !isDue(item))) {
      unverified.set(item.number, [`not yet implemented (lands in ${item.landsIn})`])
    }
    if (bad.length > 0) problems.push(`ids that cannot count as evidence: ${bad.join('; ')}`)

    if (problems.length > 0) {
      console.error(`\nrelease gate (checklist items 1-9, 16-19) FAILED: ${problems.join('; ')}`)
      process.exitCode = 1
    } else if (unverified.size > 0) {
      console.warn(`\nrelease gate UNVERIFIED in this run (not passed): ${describeUnverified(unverified)}`)
    } else {
      console.info('\nrelease gate: every gate item ran and passed')
    }
  }
}
