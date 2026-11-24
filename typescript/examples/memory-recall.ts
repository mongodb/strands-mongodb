/**
 * An agent learns a fact in one process and recalls it in the next, from a query with no words in common.
 *
 * Run the two steps as separate commands, after `npm run build`:
 *
 *     node examples/memory-recall.ts write
 *     node examples/memory-recall.ts recall
 *
 * The write step runs one agent turn. When the turn ends, an extraction trigger fires, an extractor pulls one
 * fact out of the turn, and the fact is stored in MongoDB. The recall step, in a new process, builds the same
 * two stores and searches with a query that shares no word with the stored fact:
 *
 *     stored:  the guest prefers a window table for two on thursday evenings
 *     query:   where should we seat them
 *
 * A keyword search finds nothing for that query. A vector search over embeddings that Atlas generates
 * server-side finds the fact. That is this package's default, and it needs no embedding code, API key or
 * model of your own.
 *
 * Both stores live in one collection and are kept apart by scope. The assistant writes to the guest's notes
 * and reads a curated policy store it cannot write to. Each result shows which store it came from.
 *
 * Needs MONGODB_URI pointing at an Atlas cluster with Atlas Vector Search and a registered embedding model.
 * The turn uses a scripted model bundled with the examples, so no model provider is needed; pass
 * --model bedrock to use a real one. Pass --dry-run to see what a step would do without connecting.
 */
import { Agent, InvocationTrigger, MemoryManager } from '@strands-agents/sdk'
import type { ExtractionConfig, ExtractionResult, Extractor, MessageData } from '@strands-agents/sdk'
import { MongoDBMemoryStore } from 'strands-mongodb'
import type { MongoDBMemoryStoreConfig } from 'strands-mongodb'

import {
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
  redact,
  resolveModel,
  runMain,
  say,
} from './support.ts'

const SCRIPT = 'memory-recall.ts'
const STEPS = ['write', 'recall'] as const
const EXTRA = { scope: 'bistro-demo' } as const

/** What the user says. Only the text after the marker is a fact worth storing; the rest is small talk. */
const MARKER = 'Note for next time: '
const TURN = `Table 7 went well tonight. ${MARKER}the guest prefers a window table for two on Thursday evenings.`

/** Shares no word with the fact. {@link requireDisjoint} checks this at runtime. */
const QUERY = 'where should we seat them?'

const WRITABLE_STORE = 'guest_notes'
const CURATED_STORE = 'house_policies'
const CURATED_ENTRY = 'Window tables are held for parties who booked ahead.'

/** One text reply is enough: the turn only gives `InvocationTrigger` an invocation to fire after. */
const REPLIES: ScriptedReply[] = [{ text: 'Noted. I will keep that in mind for the next booking.' }]

/** The distinct lowercase words in `text`. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
}

/**
 * Fail unless the query and the fact share no word.
 *
 * The example shows that recall is semantic. A shared word would let a keyword match answer the query, so an
 * edit to either string that adds one stops the example.
 *
 * @throws ExampleError when the two share a word.
 */
function requireDisjoint(fact: string, query: string): void {
  const queryWords = words(query)
  const overlap = [...words(fact)].filter((word) => queryWords.has(word)).sort()
  if (overlap.length > 0) {
    throw new ExampleError(
      `the query and the stored fact share ${overlap.join(', ')}, so recall would prove nothing beyond a ` +
        `keyword match. Edit QUERY or TURN in ${SCRIPT} until the two are disjoint.`,
    )
  }
}

/** The durable part of a turn: everything after {@link MARKER}, or an empty string when it is absent. */
function factFrom(turn: string): string {
  const at = turn.indexOf(MARKER)
  if (at < 0) return ''
  return turn
    .slice(at + MARKER.length)
    .trim()
    .replace(/\.$/, '')
}

/**
 * Turns a conversation into facts by looking for a marker, with no model call.
 *
 * An extractor implements the SDK's `Extractor`, a single `extract` method whose results the coordinator
 * passes to the store's `add`. This one keeps the text after {@link MARKER} in each user message, so the write
 * path costs no model calls and gives the same output on every run.
 *
 * In a real application, pass `extraction: true` instead. That selects the SDK's `ModelExtractor`, which uses
 * the agent's own model to extract facts, at one model call per turn.
 */
class MarkerExtractor implements Extractor {
  readonly extracted: string[] = []

  /** One result per user message carrying the marker, tagged with the extractor that produced it. */
  async extract(messages: MessageData[]): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = []
    for (const message of messages) {
      if (message.role !== 'user') continue
      for (const block of message.content) {
        const fact = 'text' in block && typeof block.text === 'string' ? factFrom(block.text) : ''
        if (fact === '') continue
        this.extracted.push(fact)
        results.push({ content: fact, metadata: { extractor: 'MarkerExtractor' } })
      }
    }
    return results
  }
}

/**
 * Build the two stores both steps use: one collection, two scopes.
 *
 * The writable store holds what the assistant learns about this guest. The curated store holds house policy
 * and has `writable: false`, so the agent can search it but cannot write to it.
 *
 * @returns The writable store first, the curated store second.
 */
function buildStores(
  parsed: StepArguments,
  uri: string,
  extraction: ExtractionConfig | undefined,
): [MongoDBMemoryStore, MongoDBMemoryStore] {
  const config = mongodbConfig(uri, parsed.database)
  const scope = parsed.extra.scope ?? EXTRA.scope
  // The SDK types `extraction` as `ExtractionConfig | boolean`, not optional with `undefined`, and the
  // package's config is checked with `exactOptionalPropertyTypes`: the read-only step omits the key rather
  // than passing `undefined`.
  const writableConfig: MongoDBMemoryStoreConfig = {
    name: WRITABLE_STORE,
    description: 'what the assistant has learned about this guest',
    config,
    collection: parsed.collection,
    scope,
    writable: true,
    ...(extraction === undefined ? {} : { extraction }),
  }
  const curated = new MongoDBMemoryStore({
    name: CURATED_STORE,
    description: 'house policy, curated by the restaurant and read-only to the assistant',
    config,
    collection: parsed.collection,
    scope: `${scope}-house`,
    writable: false,
  })
  return [new MongoDBMemoryStore(writableConfig), curated]
}

/**
 * Run one turn and let the extraction trigger store what it extracted.
 *
 * Nothing here calls `add` on the writable store. The store carries an `ExtractionConfig`, the trigger fires
 * after the invocation, and the coordinator passes each extracted entry to `add` in the background.
 * `flush()` waits for that write, so the process does not exit with it still in flight.
 */
async function write(parsed: StepArguments, uri: string): Promise<Record<string, unknown>> {
  const extractor = new MarkerExtractor()
  const scope = parsed.extra.scope ?? EXTRA.scope
  const stores = buildStores(parsed, uri, { trigger: [new InvocationTrigger()], extractor })

  // The curated store is read-only to the agent, so a writable instance outside the manager stands in for
  // whoever curates it. Seeding it is setup.
  const curator = new MongoDBMemoryStore({
    name: CURATED_STORE,
    config: mongodbConfig(uri, parsed.database),
    collection: parsed.collection,
    scope: `${scope}-house`,
    writable: true,
  })

  const manager = new MemoryManager({ stores })
  const agent = new Agent({ model: resolveModel(parsed.model, REPLIES), memoryManager: manager, printer: false })

  try {
    await curator.add(CURATED_ENTRY)
    say(`curated '${CURATED_ENTRY}' into scope '${scope}-house' of store '${CURATED_STORE}'`)

    say(`the user says: '${TURN}'`)
    await agent.invoke(TURN)
    say(`the turn settled with ${agent.messages.length} messages in context`)

    // With `--model bedrock` the reply often says the assistant cannot save anything. That is true:
    // `MemoryManager` builds an `add_memory` tool only with `addToolConfig`, which this script does not pass.
    // The extractor does the writing.
    say('the assistant has no tool for writing memories, only search. What follows writes them:')

    await manager.flush()
    say(`MarkerExtractor produced ${extractor.extracted.length} fact(s), written by extraction`)
    for (const fact of extractor.extracted) say(`  stored in '${WRITABLE_STORE}', scope '${scope}': '${fact}'`)
    if (extractor.extracted.length === 0) {
      throw new ExampleError(
        'extraction produced nothing, so there is nothing for the recall step to find. The turn has to ' +
          `contain '${MARKER}' for this extractor to see a fact in it.`,
      )
    }
  } finally {
    await Promise.all([curator.close(), ...stores.map((store) => store.close())])
  }

  return {
    step: 'write',
    stored: extractor.extracted.map((fact) => ({ content: fact, store_name: WRITABLE_STORE })),
    curated: [{ content: CURATED_ENTRY, store_name: CURATED_STORE }],
    writable_store: WRITABLE_STORE,
  }
}

/**
 * Search from a fresh process, with a query that shares no word with the answer.
 *
 * The process builds the same two stores from the same connection string and calls `MemoryManager.search`,
 * which needs no agent and no model.
 */
async function recall(parsed: StepArguments, uri: string): Promise<Record<string, unknown>> {
  const stores = buildStores(parsed, uri, undefined)
  const manager = new MemoryManager({ stores })
  const hits: Record<string, unknown>[] = []

  try {
    say(`searching ${stores.length} store(s) in one collection for '${QUERY}'`)
    const results = await manager.search(QUERY)
    say(`${results.length} hit(s), each attributed to the store that answered`)
    for (const entry of results) {
      const score = Number(entry.metadata?._relevance_score ?? 0)
      const scope = entry.metadata?._scope ?? null
      say(`  [${entry.storeName}] score ${score.toFixed(4)}, scope '${scope}': '${entry.content}'`)
      hits.push({ content: entry.content, score, store_name: entry.storeName, scope })
    }
    if (hits.length === 0) {
      // Atlas embeds a new document after the write is acknowledged, and a search before then returns nothing
      // rather than failing. `MemoryManager.search` also turns a store that threw into a logged warning and
      // returns the other stores' results, so a failed search looks the same as an empty scope.
      say('nothing came back. Three causes, in the order worth checking:')
      say('  the write step has not run against this database and collection;')
      say('  Atlas has not finished embedding it yet, which takes a few seconds after the write')
      say('    returns, so if the write step just printed its summary, wait and run this again;')
      say("  or a store's search failed. Check for a 'store search failed' warning above: the")
      say('    manager logs those and returns the hits it did get, so a failure looks like this.')
    }
  } finally {
    await Promise.all(stores.map((store) => store.close()))
  }

  return { step: 'recall', query: QUERY, hits, writable_store: WRITABLE_STORE }
}

/** What a step would do, for `--dry-run`. */
function describe(step: string): string[] {
  if (step === 'write') {
    return [
      `seed '${CURATED_STORE}' with one curated entry, through a writable instance of it`,
      `build '${WRITABLE_STORE}' (writable, extraction on) and '${CURATED_STORE}' (read-only)`,
      'run one agent turn, so InvocationTrigger has an invocation to fire after',
      'await MemoryManager.flush(), so the background extraction write completes before exit',
    ]
  }
  return [
    'build the same two stores in this process, which has seen none of the above',
    `search both for '${QUERY}' and print each hit with its score and store`,
  ]
}

runMain(SCRIPT, async () => {
  requireDisjoint(factFrom(TURN), QUERY)
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

  const summary = parsed.step === 'write' ? await write(parsed, uri) : await recall(parsed, uri)
  if (following !== undefined) say(`now run, in a new process: ${nextCommand(SCRIPT, following, options)}`)
  emitSummary(summary, parsed.summaryJson)
})
