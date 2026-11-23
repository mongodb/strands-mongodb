/**
 * The unit-tier half of the shipped examples. Ports the unit classes of `python/tests/test_examples.py`.
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-168 | AT-087 | The bundled scripted model emits exactly the event sequence the SDK's event loop reads |
 * | TS-169 | AT-088 (guard), AT-090 | The credential guard permits only the exact redaction, `redact` produces it, and `examples/` is in every file set that checks code |
 *
 * **Nothing here imports `examples/`.** The scripted model is driven inside a child `node` process, which strips
 * the types the way a reader's `node examples/<name>.ts` does, so the test suite never becomes the one thing
 * depending on an import path into the examples. The subprocess runs of the scripts themselves are in
 * `test/example/examples.test.ts`, because they import the built package.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CREDENTIALED_URI } from '../support/credentials.js'
import { PACKAGE_ROOT } from '../support/program.js'

/** The child that drives `ScriptedModel`: one text reply, one tool-use reply, then a third call that must throw. */
const SCRIPTED_MODEL_EVENTS = `
import { ScriptedModel, redact } from './examples/support.ts'

const model = new ScriptedModel([
  { text: 'the coffee order is a flat white' },
  { toolUse: { name: 'remember', toolUseId: 'tooluse-1', input: { note: 'flat white' } } },
])
const streams = []
for (let i = 0; i < 2; i++) {
  const events = []
  for await (const event of model.stream()) events.push(event)
  streams.push(events)
}
let exhausted = null
try {
  for await (const event of model.stream()) void event
} catch (error) {
  exhausted = error.constructor.name
}
const redacted = redact('mongodb+srv://' + 'appuser:s3cret' + '@cluster.example.mongodb.net/')
console.log(JSON.stringify({ streams, exhausted, redacted }))
`

const TEXT_BLOCK_EVENTS = [
  { type: 'modelMessageStartEvent', role: 'assistant' },
  { type: 'modelContentBlockStartEvent' },
  { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'the coffee order is a flat white' } },
  { type: 'modelContentBlockStopEvent' },
  { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
]

const TOOL_USE_BLOCK_EVENTS = [
  { type: 'modelMessageStartEvent', role: 'assistant' },
  {
    type: 'modelContentBlockStartEvent',
    start: { type: 'toolUseStart', name: 'remember', toolUseId: 'tooluse-1' },
  },
  { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"note":"flat white"}' } },
  { type: 'modelContentBlockStopEvent' },
  { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
]

/** Lines the guard must judge, and whether each is a leak. Concatenated so TS-161's sweep reads no credential here. */
const GUARD_CASES: [string, boolean][] = [
  ['connecting to mongodb+srv://<redacted>@cluster.example.mongodb.net/', false],
  ['connecting to mongodb://<redacted>@127.0.0.1:27017/', false],
  ['connecting to mongodb+srv://' + 'appuser:s3cret' + '@cluster.example.mongodb.net/', true],
  ['connecting to mongodb+srv://' + 'appuser:<redacted>' + '@cluster.example.mongodb.net/', true],
  ['connecting to mongodb+srv://' + '<redacted>:pw' + '@cluster.example.mongodb.net/', true],
  ['connecting to mongodb+srv://cluster.example.mongodb.net/', false],
]

interface ChildPayload {
  streams: unknown[][]
  exhausted: string | null
  redacted: string
}

function drive(): ChildPayload {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPTED_MODEL_EVENTS], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as ChildPayload
}

describe('TS-168 — the bundled model emits the sequence the event loop reads', () => {
  // Whole-list equality rather than spot checks. A stream missing its message stop, or a delta with no block
  // start before it, does not throw: the event loop waits for a block that never closes and the example hangs.
  it('TS-168 — a text reply and a tool-use reply map to the documented sequences, and a fourth call throws', () => {
    const payload = drive()
    expect(payload.streams[0]).toEqual(TEXT_BLOCK_EVENTS)
    expect(payload.streams[1]).toEqual(TOOL_USE_BLOCK_EVENTS)
    expect(payload.exhausted).toBe('Error')
  }, 30_000)
})

describe('TS-169 — the credential guard, the redaction it permits, and the file sets', () => {
  it.each(GUARD_CASES)('TS-169 — the guard judges %s as a leak: %s', (line, isLeak) => {
    expect(CREDENTIALED_URI.test(line)).toBe(isLeak)
  })

  it('TS-169 — redact() writes exactly the redaction the guard permits', () => {
    const { redacted } = drive()
    expect(redacted).toBe('mongodb+srv://<redacted>@cluster.example.mongodb.net/')
    expect(CREDENTIALED_URI.test(redacted)).toBe(false)
  }, 30_000)

  it('TS-169 — examples/ is typechecked, and stays out of the published tarball', () => {
    const tsconfig = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'tsconfig.json'), 'utf8')) as { include: string[] }
    expect(tsconfig.include).toContain('examples')
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { files: string[] }
    expect(manifest.files.some((entry) => entry.startsWith('examples'))).toBe(false)
  })
})
