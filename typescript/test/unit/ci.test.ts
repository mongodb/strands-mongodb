/**
 * The TypeScript workflow, read as YAML and held to the rules `python/tests/test_ci.py` holds the Python one to,
 * plus the two files beside it that exist for this package: the zizmor exception and the pre-commit hooks.
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-160 | none | The README's `<!-- ci-jobs -->` table names every job in `ci-typescript.yml`, in order, and no other |
 * | TS-174 | AT-169, AT-244 and the `test_ci.py` structure tests | Triggers and their paths, permissions, budgets, digest-pinned actions, the pinned npm, secrets only under `env:`, the static gates, the tiers and where each runs, the zizmor exception and the pre-commit hooks |
 *
 * Nothing here runs the workflow. It reads what the file says, so a job that is renamed, unpinned or given a
 * secret on its command line fails here before it reaches GitHub.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { PACKAGE_ROOT } from '../support/program.js'
import { tableAfter, unquote } from '../support/readme.js'

const REPOSITORY_ROOT = join(PACKAGE_ROOT, '..')
const WORKFLOW_FILE = 'ci-typescript.yml'
const WORKFLOW_PATH = join(REPOSITORY_ROOT, '.github', 'workflows', WORKFLOW_FILE)
const ZIZMOR_PATH = join(REPOSITORY_ROOT, '.github', 'zizmor.yml')
const PRE_COMMIT_PATH = join(REPOSITORY_ROOT, '.pre-commit-config.yaml')

/**
 * The npm every job installs before `npm ci`. npm 11.5.1 skips Vitest's native binding on a clean install and the
 * suite cannot start; 11.21.3 installs it. A test, so a bump is a reviewed change rather than drift.
 */
const PINNED_NPM = '11.21.3'

/** A commit digest, as an action reference. A tag can be moved; a digest names the content that was reviewed. */
const DIGEST = /^[0-9a-f]{40}$/

/**
 * Every file outside `typescript/` the suite reads, and the files that configure this workflow. A change to one
 * that runs no job looks the same as passing.
 */
const WATCHED_PATHS = [
  'typescript/**',
  '.github/workflows/ci-typescript.yml',
  '.github/workflows/zizmor.yml',
  '.github/zizmor.yml',
  '.pre-commit-config.yaml',
  '.gitignore',
  'python/README.md',
  'python/src/strands_mongodb/_telemetry.py',
]

/** The pre-commit hooks, each the `Lint` job's command of the same name. */
const HOOKS: [string, string][] = [
  ['typescript-format-check', 'format:check'],
  ['typescript-lint', 'lint'],
  ['typescript-typecheck', 'typecheck'],
]

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

interface Job {
  name?: string
  if?: string
  'runs-on'?: string
  'timeout-minutes'?: number
  env?: Record<string, unknown>
  services?: Record<string, unknown>
  strategy?: { matrix?: Record<string, unknown> }
  steps?: Step[]
}

interface Workflow {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>
  permissions?: Record<string, string>
  defaults?: { run?: { 'working-directory'?: string } }
  jobs: Record<string, Job>
}

function workflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow
}

function steps(job: Job): Step[] {
  return job.steps ?? []
}

/** Every `run:` command in a job, joined, for asserting on what a job runs. */
function commands(job: Job): string {
  return steps(job)
    .map((step) => step.run ?? '')
    .join('\n')
}

/** `${{ matrix.x }}` in a job name, and `<x>` in the README, both read as one placeholder. */
function placeholder(name: string): string {
  return name.replace(/\$\{\{[^}]*\}\}/g, '<>').replace(/<[^>]*>/g, '<>')
}

/** Every value that is an expression naming `secrets.`, with where it sits. */
function secretReferences(node: unknown, path: string[] = []): string[][] {
  if (typeof node === 'string') return /\$\{\{[^}]*\bsecrets\./.test(node) ? [path] : []
  if (Array.isArray(node)) return node.flatMap((item, index) => secretReferences(item, [...path, String(index)]))
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) => secretReferences(value, [...path, key]))
  }
  return []
}

describe('TS-160 — the README names every job the workflow runs', () => {
  it('TS-160 — the ci-jobs table equals the job names, in order', () => {
    const documented = tableAfter('<!-- ci-jobs -->').map((row) => placeholder(unquote(row[0] ?? '')))
    const declared = Object.values(workflow().jobs).map((job) => placeholder(job.name ?? ''))
    expect(documented).toEqual(declared)
  })
})

describe('TS-174 — the TypeScript workflow', () => {
  it('TS-174 — a pull request and a push to main both run it, and a person can start it', () => {
    const on = workflow().on
    expect(Object.keys(on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    // No branch filter on a pull request: one stacked on a topic branch would otherwise run no job.
    expect(on.pull_request?.branches).toBeUndefined()
    expect(on.push?.branches).toEqual(['main'])
  })

  it('TS-174 — both change triggers watch the package and every file outside it the suite reads', () => {
    const on = workflow().on
    for (const trigger of ['pull_request', 'push']) {
      expect(on[trigger]?.paths, trigger).toEqual(WATCHED_PATHS)
    }
  })

  it('TS-174 — the token is read-only and every step runs from typescript/', () => {
    const parsed = workflow()
    expect(parsed.permissions).toEqual({ contents: 'read' })
    expect(parsed.defaults?.run?.['working-directory']).toBe('typescript')
  })

  it('TS-174 — every job declares a budget, and every job with a MongoDB container avoids the newest kernel', () => {
    for (const [id, job] of Object.entries(workflow().jobs)) {
      expect(job['timeout-minutes'], id).toBeGreaterThan(0)
      expect(job['timeout-minutes'], id).toBeLessThanOrEqual(30)
      if (job.services !== undefined) expect(job['runs-on'], id).toBe('ubuntu-22.04')
    }
  })

  it('TS-174 — every action is pinned to a commit digest, and no checkout keeps its credential', () => {
    let checkouts = 0
    for (const [id, job] of Object.entries(workflow().jobs)) {
      for (const step of steps(job)) {
        if (step.uses === undefined) continue
        const [action, reference] = step.uses.split('@')
        expect(reference, `${id} uses ${step.uses}`).toMatch(DIGEST)
        if (action === 'actions/checkout') {
          checkouts++
          expect(step.with?.['persist-credentials'], id).toBe(false)
        }
      }
    }
    expect(checkouts).toBeGreaterThanOrEqual(4)
  })

  it(`TS-174 — every job that installs installs npm ${PINNED_NPM} first`, () => {
    for (const [id, job] of Object.entries(workflow().jobs)) {
      const runs = steps(job).map((step) => step.run ?? '')
      const install = runs.findIndex((run) => /\bnpm ci\b/.test(run))
      expect(install, `${id} never runs npm ci`).toBeGreaterThanOrEqual(0)
      const pin = runs.findIndex((run) => run.includes(`npm install --global npm@${PINNED_NPM}`))
      expect(pin, `${id} does not pin npm before npm ci`).toBeGreaterThanOrEqual(0)
      expect(pin).toBeLessThan(install)
    }
  })

  it('TS-174 — no command interpolates an expression, and every secret sits under env', () => {
    const parsed = workflow()
    for (const [id, job] of Object.entries(parsed.jobs)) {
      for (const step of steps(job)) expect(step.run ?? '', `${id}: ${step.name}`).not.toMatch(/\$\{\{/)
    }
    for (const path of secretReferences(parsed)) expect(path.at(-2), path.join('.')).toBe('env')
  })

  it('TS-174 — the three static gates run, and nothing runs the rewriting formatter', () => {
    const all = Object.values(workflow().jobs).map(commands).join('\n')
    for (const script of ['format:check', 'lint', 'typecheck']) expect(all).toContain(`npm run ${script}`)
    expect(all).not.toMatch(/npm run format(?!:)/)
  })

  it('TS-174 — the unit tier runs on more than one Node release, the floor among them', () => {
    const jobs = Object.values(workflow().jobs)
    const unit = jobs.find((job) => /^npm test$/m.test(commands(job)))
    expect(unit).toBeDefined()
    const versions = unit?.strategy?.matrix?.['node-version'] as string[]
    expect(versions.length).toBeGreaterThan(1)
    expect(versions).toContain('22')
    for (const version of versions) expect(typeof version).toBe('string')
  })

  it('TS-174 — the contract tier runs on two deployments, and integration on the one with a search process', () => {
    const contract = workflow().jobs.contract
    expect(contract).toBeDefined()
    const legs = (contract?.strategy?.matrix?.deployment ?? []) as { image: string; uri: string; search: string }[]
    expect(new Set(legs.map((leg) => leg.image)).size).toBe(2)
    expect(legs.filter((leg) => leg.search === '1')).toHaveLength(1)
    expect(contract?.env?.MONGODB_URI).toBe('${{ matrix.deployment.uri }}')
    const integration = steps(contract ?? {}).find((step) => step.run?.includes('--project integration'))
    expect(integration?.if).toBe("matrix.deployment.search == '1'")
    expect(integration?.env?.MONGODB_ATLAS_URI).toBe('${{ matrix.deployment.uri }}')
    expect(commands(contract ?? {})).toContain('--project contract')
    expect(commands(contract ?? {})).toContain('--project example')
  })

  it('TS-174 — the tiers that run shipped code ask afterwards whether the tree is still clean', () => {
    const contract = steps(workflow().jobs.contract ?? {})
    const clean = contract.findIndex((step) => step.run?.includes('git status --porcelain'))
    const lastTier = contract.findLastIndex((step) => step.run?.includes('npm test'))
    expect(clean).toBeGreaterThan(lastTier)
  })

  it('TS-174 — exactly one job switches the build tier on, and it is the one enforcing both coverage floors', () => {
    const jobs = Object.values(workflow().jobs).filter((job) => job.env?.STRANDS_MONGODB_BUILD_TIER !== undefined)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.env?.STRANDS_MONGODB_BUILD_TIER).toBe('1')
    expect(commands(jobs[0] ?? {})).toContain('npm run cov')
  })

  it('TS-174 — no job holds a cluster credential: autoembed is not run by this workflow', () => {
    expect(secretReferences(workflow())).toEqual([])
    expect(readFileSync(WORKFLOW_PATH, 'utf8')).not.toContain('MONGODB_AUTOEMBED_URI')
  })
})

describe('TS-174 — the zizmor exception and the pre-commit hooks', () => {
  it('TS-174 — the service images are an argued unpinned-images exception', () => {
    const text = readFileSync(ZIZMOR_PATH, 'utf8')
    const parsed = parse(text) as { rules: Record<string, { ignore?: string[] }> }
    expect(parsed.rules['unpinned-images']?.ignore).toContain(WORKFLOW_FILE)
    // Every action here is digest-pinned, so this workflow needs no unpinned-uses exception.
    expect(parsed.rules['unpinned-uses']?.ignore ?? []).not.toContain(WORKFLOW_FILE)
    const comments = text.split('\n').filter((line) => line.trimStart().startsWith('#')).length
    const ignored = Object.values(parsed.rules).reduce((total, rule) => total + (rule.ignore?.length ?? 0), 0)
    expect(comments).toBeGreaterThanOrEqual(3 * ignored)
  })

  it.each(HOOKS)('TS-174 — the %s hook runs npm run %s over the package, as the Lint job does', (id, script) => {
    const parsed = parse(readFileSync(PRE_COMMIT_PATH, 'utf8')) as {
      repos: { repo: string; hooks: Record<string, unknown>[] }[]
    }
    const hook = parsed.repos.flatMap((repo) => repo.hooks).find((candidate) => candidate.id === id)
    expect(hook).toBeDefined()
    expect(hook?.entry).toBe(`npm --prefix typescript run ${script}`)
    expect(hook?.language).toBe('system')
    expect(hook?.files).toBe('^typescript/')
    expect(hook?.pass_filenames).toBe(false)
    expect(commands(workflow().jobs.lint ?? {})).toContain(`npm run ${script}`)
  })
})
