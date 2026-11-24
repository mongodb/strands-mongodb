/**
 * Three SDK subsystems, one MongoDB collection, and a session that survives the process that made it.
 *
 * Run the two steps as separate commands, after `npm run build`:
 *
 *     node examples/unified-storage.ts run
 *     node examples/unified-storage.ts resume
 *
 * `new Agent({ storage })` takes one backend and hands it to every subsystem that does not bring its own, so
 * one `MongoDBStorage` serves three writers, each under its own key prefix:
 *
 *     session/    conversation snapshots, from SessionManager
 *     context/    an oversized tool result, offloaded by the context manager
 *     memory/     a knowledge file, from FileMemoryStore({ storage })
 *
 * The run step runs a turn that writes all three, then prints a census of the collection read back from
 * MongoDB: each top-level prefix with its document count and byte total. The resume step, in a new process,
 * restores the session from session/ and prints how many messages came back.
 *
 * The memory/ documents are not vector memory. Storage holds opaque bytes under a string key, and on this
 * backend FileMemoryStore recalls by token overlap over the keys alone. MongoDBMemoryStore, shown in
 * memory-recall.ts, uses a separate collection with typed fields and a vector index.
 *
 * Needs MONGODB_URI. Any MongoDB deployment works; Atlas Search is not needed. Pass --dry-run to see what a
 * step would do without connecting.
 */
import { Agent, SessionManager, tool } from '@strands-agents/sdk'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { MongoClient } from 'mongodb'
import { MongoDBStorage } from 'strands-mongodb'

import {
  type CensusEntry,
  ExampleError,
  type ScriptedReply,
  type StepArguments,
  carriedOptions,
  connection,
  emitSummary,
  modelBanner,
  mongodbConfig,
  nextCommand,
  parseStep,
  prefixCensus,
  redact,
  resolveModel,
  runMain,
  say,
} from './support.ts'

const SCRIPT = 'unified-storage.ts'
const STEPS = ['run', 'resume'] as const
const EXTRA = { 'session-id': 'dinner-service' } as const

/** Enough rows that the tool result is over the `'auto'` context manager's offload threshold. */
const BOOKINGS = 200

const MEMORY_STORE = 'kitchen_notes'
const KNOWLEDGE =
  'Closing checklist: wipe the pass, log the waste sheet, and leave the walk-in door propped open ' +
  'for ten minutes before setting the alarm.'

/** The first reply calls the tool, giving the context manager an oversized result to move. The second ends the turn. */
const REPLIES: ScriptedReply[] = [
  { toolUse: { name: 'reservation_book', toolUseId: 'tooluse-1', input: { service: 'dinner' } } },
  { text: 'Dinner is fully committed. I have filed the closing notes.' },
]

const PROMPT = "Pull up tonight's reservation book and file the closing checklist."

/** Every booking for one service, which is more text than a turn should carry. */
const reservationBook = tool({
  name: 'reservation_book',
  description: 'Return every booking for one service.',
  inputSchema: {
    type: 'object',
    properties: { service: { type: 'string', description: 'Which service to list.' } },
    required: ['service'],
  },
  callback: (input) => {
    const service = String((input as { service?: unknown }).service ?? 'dinner')
    const rows = Array.from({ length: BOOKINGS }, (_, offset) => {
      const number = offset + 1
      const time = `${19 + (number % 4)}:${String((number * 15) % 60).padStart(2, '0')}`
      const room = number % 3 === 0 ? 'window' : 'main room'
      return `table ${String(number).padStart(2)} | ${time} | party of ${2 + (number % 6)} | guest ${String(number).padStart(3, '0')} | ${room}`
    })
    return `${service} service, ${rows.length} bookings\n${rows.join('\n')}`
  },
})

/**
 * Build the one storage instance every subsystem in this example shares.
 *
 * No `prefix` is set, so the census shows the SDK's own keys. A real application usually sets one per tenant.
 */
function buildStorage(parsed: StepArguments, uri: string): MongoDBStorage {
  return new MongoDBStorage(mongodbConfig(uri, parsed.database), { collection: parsed.collection })
}

/**
 * Read the prefix census with a separate driver client, and print each line.
 *
 * A plain client shows that these are ordinary documents that any MongoDB tool, `mongosh` included, can read.
 */
async function censusLines(parsed: StepArguments, uri: string): Promise<CensusEntry[]> {
  const client = new MongoClient(uri)
  let census: CensusEntry[]
  try {
    census = await prefixCensus(client.db(parsed.database).collection(parsed.collection))
  } finally {
    await client.close()
  }
  say(`census of ${parsed.database}.${parsed.collection}, read back with a plain driver:`)
  if (census.length === 0) {
    say("  the collection is empty. Run the 'run' step against this database and collection first.")
  }
  for (const entry of census) {
    say(
      `  ${entry.prefix.padEnd(12)} ${String(entry.documents).padStart(3)} document(s)  ${String(entry.bytes).padStart(7)} bytes`,
    )
  }
  return census
}

/**
 * Assemble the agent and the session manager that shares its storage.
 *
 * Neither the session manager nor the context manager's stash gets a backend of its own. Both use the agent's
 * `storage`: one connection pool, one collection, and the subsystems kept apart by key prefix.
 */
function buildAgent(parsed: StepArguments, storage: MongoDBStorage): { agent: Agent; sessions: SessionManager } {
  const sessions = new SessionManager({ sessionId: parsed.extra['session-id'] ?? EXTRA['session-id'] })
  const agent = new Agent({
    model: resolveModel(parsed.model, REPLIES),
    tools: [reservationBook],
    contextManager: 'auto',
    sessionManager: sessions,
    storage,
    printer: false,
  })
  return { agent, sessions }
}

/** Produce all three prefixes in one turn, then report what MongoDB holds. */
async function run(parsed: StepArguments, uri: string): Promise<Record<string, unknown>> {
  const storage = buildStorage(parsed, uri)
  const knowledge = new FileMemoryStore({ name: MEMORY_STORE, storage })
  const sessionId = parsed.extra['session-id']

  try {
    const { agent, sessions } = buildAgent(parsed, storage)
    // Initializing restores any existing session from the shared storage.
    await agent.initialize()
    say(`session '${sessionId}' opened with ${agent.messages.length} message(s) in context`)

    say(`the user says: '${PROMPT}'`)
    await agent.invoke(PROMPT)
    say(`the turn settled with ${agent.messages.length} message(s) in context`)

    const entryId = await knowledge.add(KNOWLEDGE)
    say(`FileMemoryStore('${MEMORY_STORE}') wrote '${entryId}' through the same backend`)

    await sessions.saveSnapshot({ target: agent, isLatest: false })
    const snapshotIds = await sessions.listSnapshotIds({ target: agent })
    const snapshotId = snapshotIds.at(-1) ?? null
    say(`snapshot_latest was written when the turn ended; immutable checkpoint '${snapshotId}' added`)

    const census = await censusLines(parsed, uri)

    const prefixes = census.map((entry) => entry.prefix)
    const missing = ['session/', 'context/', 'memory/'].filter((expected) => !prefixes.includes(expected))
    if (missing.length > 0) {
      throw new ExampleError(
        `nothing was written under ${missing.join(', ')}, so this run does not show what it claims. ` +
          `The census found ${prefixes.join(', ') || 'nothing'}.`,
      )
    }
    say(`three subsystems, one collection: ${prefixes.join(', ')}`)

    return {
      step: 'run',
      session_id: sessionId,
      messages: agent.messages.length,
      snapshot_id: snapshotId,
      memory_entry_id: entryId,
      census,
    }
  } finally {
    await storage.close()
  }
}

/** Restore the session in a fresh process that has run no turn. */
async function resume(parsed: StepArguments, uri: string): Promise<Record<string, unknown>> {
  const storage = buildStorage(parsed, uri)
  const sessionId = parsed.extra['session-id']

  try {
    const { agent } = buildAgent(parsed, storage)
    await agent.initialize()
    const restored = agent.messages.length
    say(`restored ${restored} message(s) from session '${sessionId}', before any turn ran`)
    const first = agent.messages[0]
    if (first !== undefined) {
      const text = first.content.find((block) => block.type === 'textBlock')
      if (text !== undefined && 'text' in text) {
        say(`  the first restored message (${first.role}): '${text.text.slice(0, 90)}'`)
      }
    } else {
      say("  nothing came back. Run the 'run' step first, with this same --session-id.")
    }

    const census = await censusLines(parsed, uri)
    say(
      'on the memory/ prefix: Storage moves opaque bytes under a string key, and FileMemoryStore recall is ' +
        'token overlap over that key space, so it matches file names and not the text inside them. ' +
        'MongoDBMemoryStore is a different collection with typed fields and a vector index. See ' +
        'memory-recall.ts for that one.',
    )

    return { step: 'resume', session_id: sessionId, restored_messages: restored, census }
  } finally {
    await storage.close()
  }
}

/** What a step would do, for `--dry-run`. */
function describe(step: string): string[] {
  if (step === 'run') {
    return [
      'build one MongoDBStorage and pass it as new Agent({ storage })',
      "add a SessionManager and contextManager: 'auto', neither carrying storage of its own",
      "run one turn in which the model calls 'reservation_book', whose result is far over the offload " +
        'threshold; the context manager stashes it under context/',
      `write one knowledge file through FileMemoryStore({ name: '${MEMORY_STORE}', storage })`,
      'save an immutable snapshot, then read the prefix census back with a plain driver',
    ]
  }
  return [
    'rebuild the same storage and the same session manager in this process',
    'let agent.initialize() restore snapshot_latest, and print how many messages came back',
    'read the census again, and say what the memory/ prefix is and is not',
  ]
}

runMain(SCRIPT, async () => {
  const parsed = parseStep(process.argv.slice(2), STEPS, EXTRA)
  const options = carriedOptions(parsed, EXTRA)
  const following = parsed.step === STEPS[0] ? STEPS[1] : undefined

  if (parsed.dryRun) {
    say(`dry run of the '${parsed.step}' step. Nothing connects, nothing is written.`)
    say(modelBanner(parsed.model))
    for (const line of describe(parsed.step)) say(`  would ${line}`)
    if (following !== undefined) say(`then run: ${nextCommand(SCRIPT, following, options)}`)
    emitSummary({ step: parsed.step, dry_run: true }, parsed.summaryJson)
    return
  }

  const uri = connection()
  say(`connecting to ${redact(uri)}, database '${parsed.database}', collection '${parsed.collection}'`)
  say(modelBanner(parsed.model))

  const summary = parsed.step === 'run' ? await run(parsed, uri) : await resume(parsed, uri)
  if (following !== undefined) say(`now run, in a new process: ${nextCommand(SCRIPT, following, options)}`)
  emitSummary(summary, parsed.summaryJson)
})
