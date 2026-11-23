/**
 * Shared scaffolding for the two examples in this directory.
 *
 * Holds the scripted model, the connection lookup, the argument parser and the key-prefix census, so each
 * example script contains only what it demonstrates. Not part of the published package and not an API.
 *
 * Written in the subset of TypeScript Node runs by stripping types: no enums, no namespaces and no parameter
 * properties, so `node examples/<name>.ts` needs no build step for the examples themselves.
 */
import { parseArgs } from 'node:util'

import { BedrockModel, Model } from '@strands-agents/sdk'
import type { BaseModelConfig, ModelStreamEvent } from '@strands-agents/sdk'
import type { Collection, Document } from 'mongodb'
import type { MongoDBConfig } from 'strands-mongodb'

/** The environment variable both examples read the connection string from. */
export const URI_VARIABLE = 'MONGODB_URI'

/** Everything between the scheme and the host, which is where a password sits. */
const CREDENTIALS = /:\/\/[^@/]+@/

let line = 0

/**
 * A condition the reader can fix, reported as one line without a stack trace.
 *
 * Any other error propagates with its stack, since it points at a bug in the example.
 */
export class ExampleError extends Error {
  override readonly name = 'ExampleError'
}

/** Print one numbered line of output, so a transcript can be referred to by line. */
export function say(message: string): void {
  line += 1
  console.log(`${String(line).padStart(2)}. ${message}`)
}

/**
 * Return `uri` with any credentials replaced.
 *
 * @param uri - A MongoDB connection string.
 * @returns The same string with everything between `://` and `@` replaced by `<redacted>`. A URI with no
 *   credentials comes back unchanged.
 */
export function redact(uri: string): string {
  return uri.replace(CREDENTIALS, '://<redacted>@')
}

/**
 * Read the connection string, or explain what to set.
 *
 * @returns The value of `MONGODB_URI`.
 * @throws ExampleError when the variable is unset or empty. The message names the variable and shows the
 *   shape of the value without ever printing a real one.
 */
export function connection(): string {
  const uri = process.env[URI_VARIABLE] ?? ''
  if (uri === '') {
    throw new ExampleError(
      `${URI_VARIABLE} is not set. Point it at a deployment this example may write to, for example with a ` +
        'shell that reads it from a file you keep out of version control:\n' +
        '    set -a; . ./.env; set +a\n' +
        'Pass --dry-run to see what a step would do without connecting to anything.',
    )
  }
  return uri
}

/**
 * Say which model runs the turn and which parts of the output it affects.
 *
 * The scripted model's replies are canned, so the banner says so. Otherwise a reader could take a canned
 * reply as evidence of model behaviour.
 */
export function modelBanner(name: string): string {
  if (name === 'scripted') {
    return (
      "model: scripted. The assistant's replies come from a list in the script, so the turn costs nothing and " +
      'reads the same on every run. Only the model is scripted: when a step runs, its MongoDB calls are real. ' +
      "Pass --model bedrock to run the same script against the SDK's default provider."
    )
  }
  return (
    `model: ${name}. Replies come from the provider, so the wording below will differ from run to run and the ` +
    'turn costs whatever the provider charges. Pass --model scripted to remove that.'
  )
}

/**
 * Build a `MongoDBConfig` from a connection string.
 *
 * Passing a connection string rather than a client leaves the client's lifecycle to the package.
 */
export function mongodbConfig(uri: string, database: string): MongoDBConfig {
  return { connectionString: uri, database }
}

/** The options both examples take, after parsing. */
export interface StepArguments {
  readonly step: string
  readonly model: string
  readonly database: string
  readonly collection: string
  readonly dryRun: boolean
  readonly summaryJson: boolean
  /** Example-specific string options, such as `--scope` or `--session-id`. */
  readonly extra: Readonly<Record<string, string>>
}

/** The defaults of the options every example shares. Fixed strings, so a printed next command still works. */
const SHARED_DEFAULTS = { model: 'scripted', database: 'strands_examples', collection: 'example' } as const

/**
 * Parse the command line both examples share.
 *
 * Every default is a fixed string, not a generated one, so the next-step command one run prints still points
 * at the same data when the reader runs it.
 *
 * @param argv - The arguments after the script name.
 * @param steps - Step names, in the order they are meant to be run.
 * @param extra - Example-specific string options and their defaults, keyed by flag name without dashes.
 * @returns The parsed arguments.
 * @throws ExampleError when the step is missing or unknown, or an option is not recognized.
 */
export function parseStep(
  argv: readonly string[],
  steps: readonly string[],
  extra: Readonly<Record<string, string>>,
): StepArguments {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        model: { type: 'string', default: SHARED_DEFAULTS.model },
        database: { type: 'string', default: SHARED_DEFAULTS.database },
        collection: { type: 'string', default: SHARED_DEFAULTS.collection },
        'dry-run': { type: 'boolean', default: false },
        'summary-json': { type: 'boolean', default: false },
        ...Object.fromEntries(Object.entries(extra).map(([name, value]) => [name, { type: 'string', default: value }])),
      },
    })
  } catch (error) {
    throw new ExampleError((error as Error).message)
  }
  const step = parsed.positionals[0]
  if (step === undefined || !steps.includes(step)) {
    throw new ExampleError(`name a step: one of ${steps.join(', ')}`)
  }
  const values = parsed.values as Record<string, string | boolean | undefined>
  const model = String(values.model)
  if (model !== 'scripted' && model !== 'bedrock') throw new ExampleError(`unknown model '${model}'`)
  return {
    step,
    model,
    database: String(values.database),
    collection: String(values.collection),
    dryRun: values['dry-run'] === true,
    summaryJson: values['summary-json'] === true,
    extra: Object.fromEntries(Object.keys(extra).map((name) => [name, String(values[name])])),
  }
}

/**
 * Return the options to repeat in the next command, leaving out any that hold their default.
 *
 * A dropped option would send the next step to a namespace the previous step never wrote to.
 */
export function carriedOptions(
  parsed: StepArguments,
  extraDefaults: Readonly<Record<string, string>>,
): [string, string][] {
  const options: [string, string][] = []
  for (const name of ['model', 'database', 'collection'] as const) {
    if (parsed[name] !== SHARED_DEFAULTS[name]) options.push([`--${name}`, parsed[name]])
  }
  for (const [name, fallback] of Object.entries(extraDefaults)) {
    const value = parsed.extra[name]
    if (value !== undefined && value !== fallback) options.push([`--${name}`, value])
  }
  return options
}

/** Quote one shell word, so a printed command survives a copy into a POSIX shell. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`
}

/**
 * Build the verbatim command for the next step.
 *
 * @param script - File name of the running example.
 * @param step - The step to run next.
 * @param options - Flag and value pairs to carry over, already filtered by {@link carriedOptions}.
 * @returns A command line, quoted so it survives a copy into a shell.
 */
export function nextCommand(script: string, step: string, options: readonly (readonly [string, string])[]): string {
  const parts = ['node', `examples/${script}`, step]
  for (const [flag, value] of options) parts.push(flag, shellQuote(value))
  return parts.join(' ')
}

/**
 * Print one line of JSON when `--summary-json` was passed.
 *
 * The tests read this line instead of parsing the prose, so the prose can change freely.
 */
export function emitSummary(payload: Record<string, unknown>, enabled: boolean): void {
  if (enabled) console.log(JSON.stringify(payload))
}

/** One line of the prefix census. */
export interface CensusEntry {
  readonly prefix: string
  readonly documents: number
  readonly bytes: number
}

/**
 * Count documents and bytes per top-level key prefix, as read from the collection.
 *
 * The prefixes belong to the SDK (`session/` from `SessionManager`, `context/` from the context manager's
 * stash, `memory/` from `FileMemoryStore`), so they are discovered, not hard-coded.
 *
 * @param collection - A collection holding storage documents.
 * @returns One entry per prefix, sorted by prefix.
 */
export async function prefixCensus(collection: Collection<Document>): Promise<CensusEntry[]> {
  const groups = await collection
    .aggregate<{ _id: string; documents: number; bytes: number }>([
      {
        $project: {
          prefix: { $arrayElemAt: [{ $split: [{ $toString: '$_id' }, '/'] }, 0] },
          size: { $bsonSize: '$$ROOT' },
        },
      },
      { $group: { _id: '$prefix', documents: { $sum: 1 }, bytes: { $sum: '$size' } } },
      { $sort: { _id: 1 } },
    ])
    .toArray()
  return groups.map((group) => ({ prefix: `${group._id}/`, documents: group.documents, bytes: group.bytes }))
}

/** One scripted assistant reply: text blocks, tool calls, or both. */
export interface ScriptedReply {
  readonly text?: string
  readonly toolUse?: { readonly name: string; readonly toolUseId: string; readonly input: Record<string, unknown> }
}

/**
 * A `Model` that reads its replies from a list instead of calling a provider.
 *
 * The examples need a model only to produce a turn, so the extraction trigger and the context manager have
 * something to fire on. A scripted reply does that at no cost and needs no provider credentials.
 *
 * The event sequence is the one the SDK's own providers emit: a message start, then a content-block start,
 * delta and stop per block, then a message stop with the stop reason. A tool call sets the reason to
 * `toolUse`, which makes the event loop run the tool and ask for another reply.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  private readonly replies: readonly ScriptedReply[]
  private index = 0

  /** Script the replies this model will give, in order. */
  constructor(replies: readonly ScriptedReply[]) {
    super()
    this.replies = replies
  }

  /** Accept and ignore configuration; there is none. */
  updateConfig(): void {}

  /** Return an empty configuration. */
  getConfig(): BaseModelConfig {
    return {}
  }

  /**
   * Stream the next scripted reply. Every argument is ignored, so the output depends only on the script.
   *
   * @throws Error when the script has run out of replies. An empty stream would read as a reply with no
   *   content.
   */
  async *stream(): AsyncIterable<ModelStreamEvent> {
    const reply = this.replies[this.index]
    if (reply === undefined) {
      throw new Error(`ScriptedModel ran out of replies after ${this.replies.length}; the turn asked for another`)
    }
    this.index += 1
    yield* scriptedEvents(reply)
  }
}

/**
 * The stream events one scripted reply maps to. Exported so the unit tier can pin the sequence exactly: a
 * stream missing its message stop does not throw, it hangs the event loop.
 */
export function scriptedEvents(reply: ScriptedReply): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [{ type: 'modelMessageStartEvent', role: 'assistant' }]
  if (reply.text !== undefined) {
    events.push(
      { type: 'modelContentBlockStartEvent' },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: reply.text } },
      { type: 'modelContentBlockStopEvent' },
    )
  }
  if (reply.toolUse !== undefined) {
    const { name, toolUseId, input } = reply.toolUse
    events.push(
      { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } },
      { type: 'modelContentBlockStopEvent' },
    )
  }
  events.push({ type: 'modelMessageStopEvent', stopReason: reply.toolUse === undefined ? 'endTurn' : 'toolUse' })
  return events
}

/**
 * Return the model the `--model` option asked for.
 *
 * The Bedrock branch takes no arguments, so it uses whatever region and credentials the environment already
 * provides and whichever model id the SDK defaults to.
 */
export function resolveModel(name: string, replies: readonly ScriptedReply[]): Model {
  return name === 'bedrock' ? new BedrockModel() : new ScriptedModel(replies)
}

/**
 * Run an example's entry point, turning an {@link ExampleError} into one line on stderr and exit status 1.
 *
 * @param script - File name of the example, which prefixes the error line.
 * @param main - The example's body.
 */
export function runMain(script: string, main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    if (error instanceof ExampleError) {
      console.error(`${script}: ${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  })
}
