/**
 * The shipped examples, run the way a reader runs them: `node examples/<name>.ts`, as a child process. Ports the
 * subprocess classes of `python/tests/test_examples.py`.
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-170 | AT-088 | Unconfigured, a script exits non-zero naming `MONGODB_URI`; `--dry-run` needs no deployment and prints the next command with the carried option; only `--summary-json` puts JSON on stdout |
 * | TS-171 | AT-089 | One collection serves three SDK subsystems, and the session survives a second process |
 * | TS-172 | AT-086 | A fact written by one process is recalled by another, on a query sharing no word with it |
 *
 * **Why TS-170 is in this tier and not `unit`.** The examples import `strands-mongodb` by its package name, which
 * Node resolves through the package's own `exports` to `dist/`. A script cannot start until the package is built,
 * so this file builds it once in `beforeAll`, and the unit tier stays free of a compile step.
 *
 * Every run is checked for a credentialed URI on both streams, and for the password of the URI it was given.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { beforeAll, describe, expect, it } from 'vitest'

import { CREDENTIALED_URI, uriPasswords } from '../support/credentials.js'
import { useDeployment, uniqueName } from '../support/deployment.js'
import { PACKAGE_ROOT } from '../support/program.js'
import { describeTier, tierValue } from '../support/tiers.js'

/** How long the recall step is retried while Atlas embeds the written fact. */
const EMBEDDING_BUDGET_MS = 90_000
const EMBEDDING_POLL_MS = 5_000

/** Each script, its first step, and the option its dry run must carry into the printed next command. */
const SCRIPTS: [string, string, string][] = [
  ['unified-storage.ts', 'run', '--session-id'],
  ['memory-recall.ts', 'write', '--scope'],
]

type Run = SpawnSyncReturns<string>

/** Run one example as a child process. Never throws on a non-zero exit, because some tests require one. */
function runExample(script: string, args: readonly string[], env: NodeJS.ProcessEnv): Run {
  return spawnSync(process.execPath, [join('examples', script), ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env,
    timeout: 300_000,
  })
}

function bothStreams(run: Run): string {
  return `${run.stdout}\n${run.stderr}`
}

/** The final `--summary-json` line, decoded. Fails, naming both streams, when the last line is not an object. */
function summary(run: Run): Record<string, unknown> {
  const lines = run.stdout.split('\n').filter((line) => line.trim() !== '')
  const last = lines.at(-1)
  if (last === undefined) throw new Error(`the script printed nothing on stdout\n${bothStreams(run)}`)
  const parsed: unknown = JSON.parse(last)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the summary line is not an object: ${last}`)
  }
  return parsed as Record<string, unknown>
}

/** Neither stream carries a credentialed URI, nor the password of the one the run was given. */
function expectNoCredentials(run: Run, uri?: string): void {
  const output = bothStreams(run)
  expect(CREDENTIALED_URI.test(output), `a credentialed URI reached the output\n${output}`).toBe(false)
  for (const password of uri === undefined ? [] : uriPasswords(uri)) {
    expect(output.includes(password), 'the URI password reached the output').toBe(false)
  }
}

/**
 * Every tier variable emptied. `tiers.ts` fills them from `.env` at import, so a child inheriting this process's
 * environment unchanged would find a live deployment and the refusal under test would never happen.
 */
function unconfiguredEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, MONGODB_URI: '', MONGODB_ATLAS_URI: '', MONGODB_AUTOEMBED_URI: '' }
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== ''),
  )
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'pipe' })
}, 120_000)

describe('TS-170 — the scripts refuse to start, and say why', () => {
  it.each(SCRIPTS)('TS-170 — %s %s, unconfigured, exits non-zero naming MONGODB_URI', (script, first) => {
    const run = runExample(script, [first], unconfiguredEnvironment())
    expect(run.status, bothStreams(run)).not.toBe(0)
    expect(run.stderr).toContain('MONGODB_URI')
    expectNoCredentials(run)
  })

  it.each(SCRIPTS)('TS-170 — %s %s --dry-run prints the next command carrying %s', (script, first, carried) => {
    const run = runExample(script, [first, '--dry-run', carried, 'ts170'], unconfiguredEnvironment())
    expect(run.status, bothStreams(run)).toBe(0)
    const next = run.stdout.split('\n').find((line) => line.includes(`node examples/${script}`))
    expect(next, run.stdout).toBeDefined()
    expect(next).toContain(`${carried} ts170`)
    expectNoCredentials(run)
  })

  it.each(SCRIPTS)('TS-170 — %s %s puts JSON on stdout only with --summary-json', (script, first) => {
    const quiet = runExample(script, [first, '--dry-run'], unconfiguredEnvironment())
    expect(quiet.status, bothStreams(quiet)).toBe(0)
    for (const line of quiet.stdout.split('\n')) expect(line.trimStart().startsWith('{'), line).toBe(false)
    const loud = runExample(script, [first, '--dry-run', '--summary-json'], unconfiguredEnvironment())
    expect(loud.status, bothStreams(loud)).toBe(0)
    expect(summary(loud).step).toBe(first)
  })
})

describeTier('contract', 'TS-171 — one collection serves three SDK subsystems, across two processes', () => {
  const deployment = useDeployment('contract')

  // The prefixes are read with a direct client, not from the script's census. The script prints what it reads,
  // so asserting on its census would only confirm that it agrees with itself.
  it('TS-171 — three key prefixes after run, and a restored message count after resume', async () => {
    const uri = tierValue('contract')
    const environment = { ...process.env, MONGODB_URI: uri }
    const collection = uniqueName('example_')
    const args = [
      '--database',
      deployment().db.databaseName,
      '--collection',
      collection,
      '--session-id',
      `ts171-${randomBytes(4).toString('hex')}`,
      '--summary-json',
    ]

    const first = runExample('unified-storage.ts', ['run', ...args], environment)
    expect(first.status, bothStreams(first)).toBe(0)
    expectNoCredentials(first, uri)

    const keys = (
      await deployment()
        .db.collection(collection)
        .find({}, { projection: { _id: 1 } })
        .toArray()
    ).map((document) => String(document._id))
    for (const prefix of ['session/', 'context/', 'memory/']) {
      expect(
        keys.some((key) => key.startsWith(prefix)),
        `nothing under ${prefix}: ${keys.sort().join(', ')}`,
      ).toBe(true)
    }

    const second = runExample('unified-storage.ts', ['resume', ...args], environment)
    expect(second.status, bothStreams(second)).toBe(0)
    expectNoCredentials(second, uri)
    expect(summary(second).restored_messages, bothStreams(second)).toBeGreaterThan(0)

    // The storage-versus-memory sentence, found by its one technical term so the wording is not pinned.
    const cited = second.stdout.split('\n').filter((line) => line.includes('token overlap'))
    expect(cited, second.stdout).not.toHaveLength(0)
    expect(cited.some((line) => line.toLowerCase().includes('storage') && line.toLowerCase().includes('memor'))).toBe(
      true,
    )
  })
})

interface Hit {
  content: string
  score: unknown
  store_name: string
}

describeTier('autoembed', 'TS-172 — a fact written by one process is recalled by another', () => {
  const deployment = useDeployment('autoembed')

  it('TS-172 — two processes, one collection, and a hit from the writable store on a disjoint query', async () => {
    const uri = tierValue('autoembed')
    const environment = { ...process.env, MONGODB_URI: uri }
    const scope = `ts172-${randomBytes(4).toString('hex')}`
    const args = [
      '--database',
      deployment().db.databaseName,
      '--collection',
      uniqueName('example_'),
      '--scope',
      scope,
      '--summary-json',
    ]

    const write = runExample('memory-recall.ts', ['write', ...args], environment)
    expect(write.status, bothStreams(write)).toBe(0)
    expectNoCredentials(write, uri)
    expect(write.stdout).toContain('recall')
    expect(write.stdout).toContain(scope)
    const stored = (summary(write).stored as { content: string }[]).map((entry) => entry.content)
    expect(stored).not.toHaveLength(0)

    // Polled on a hit matching what was stored, not on any hit: the curated fact is written first and becomes
    // searchable first, so waiting on any hit would pass with the extracted memory still unembedded.
    const deadline = Date.now() + EMBEDDING_BUDGET_MS
    for (let attempt = 1; ; attempt++) {
      const recall = runExample('memory-recall.ts', ['recall', ...args], environment)
      expect(recall.status, bothStreams(recall)).toBe(0)
      expectNoCredentials(recall, uri)
      const found = summary(recall)
      const recalled = (found.hits as Hit[]).filter((hit) => stored.includes(hit.content))
      const hit = recalled[0]
      if (hit !== undefined) {
        expect(recall.stdout).toContain(hit.content)
        expect(typeof hit.score).toBe('number')
        expect(recalled.some((entry) => entry.store_name === found.writable_store)).toBe(true)
        const overlap = [...words(String(found.query))].filter((word) => words(hit.content).has(word))
        expect(overlap, 'the query and the fact share a word').toEqual([])
        return
      }
      if (Date.now() >= deadline) {
        throw new Error(`no hit matched ${JSON.stringify(stored)} after ${attempt} attempt(s)\n${bothStreams(recall)}`)
      }
      await sleep(EMBEDDING_POLL_MS)
    }
  })
})
