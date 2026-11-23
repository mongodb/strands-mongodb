/**
 * Index specs, search-index definitions and the commands that create them.
 *
 * Ported from `python/src/strands_mongodb/_indexes.py:82-560`. The other half of that module (the probes,
 * `ensure` and the ready wait) is `index-lifecycle.ts`.
 *
 * Every spec here is the same on every call and for every caller, which is what lets a caller without DDL
 * rights hand an operator a fixed list of commands. The commands are rendered the way Python's `json.dumps`
 * writes them, so `python/README.md` can document one set of commands for both packages and a test in each
 * tree holds its renderer to it.
 *
 * Messages start with `strands_mongodb: ` rather than a class name, as Python's do: this module is shared by
 * both stores and does not know which one called it.
 *
 * Internal: not exported from the entry point.
 *
 * @packageDocumentation
 */
import type { Document } from 'mongodb'

import {
  CONTENT_FIELD,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEXT_INDEX_NAME,
  DEFAULT_VECTOR_INDEX_NAME,
  EXPIRES_FIELD,
  MAX_DIMENSIONS,
  type MongoDBConfig,
  SIMILARITIES,
  VECTOR_FIELD,
  type VectorSimilarity,
} from './types.js'

/**
 * The two fields every vector index declares filterable, before any the caller adds.
 *
 * Not optional and not caller supplied: `scope` and `store_name` are how one collection isolates many stores.
 * The filter module re-exports this, so the index and the filter that queries it cannot name different pairs.
 */
export const BAKED_IN_FILTER_FIELDS: readonly string[] = ['scope', 'store_name']

/** How a search-index status reads: usable, broken for good, or not yet either. */
export type Readiness = 'ready' | 'failed' | 'building'

/** The resolved vector path: Atlas embeds the text, or the caller supplies vectors of a fixed length. */
export interface VectorMode {
  /** True when the deployment embeds the text itself. */
  readonly autoEmbed: boolean
  /** The Atlas embedding model, on the AutoEmbeddings path only. */
  readonly model?: string
  /** The vector length, on the manual path only. */
  readonly dimensions?: number
  /** The distance metric, on the manual path only. */
  readonly similarity?: VectorSimilarity
}

/** One field entry in a vector index definition. */
export interface VectorField {
  readonly type: 'autoEmbed' | 'vector' | 'filter'
  readonly path: string
  readonly [option: string]: unknown
}

/** A vector index definition as `createSearchIndexes` takes it. */
export interface VectorDefinition {
  readonly fields: VectorField[]
}

/** The full-text index definition as `createSearchIndexes` takes it. */
export interface TextDefinition {
  readonly mappings: { readonly dynamic: boolean; readonly fields: Record<string, Document[]> }
}

/** An index key direction: ascending or descending. */
export type Direction = 1 | -1

/**
 * The message for a negative lifetime.
 *
 * @param ttl - The configured lifetime.
 * @returns The message.
 */
const NEGATIVE_TTL = (ttl: number): string =>
  `strands_mongodb: 'ttlSeconds' is ${ttl}, and a lifetime cannot be negative. A negative value stamps an ` +
  'expiry in the past, so every write would be deleted on the next TTL sweep. Use 0 to expire at the next ' +
  'sweep, or undefined for no expiry.'

/**
 * The message for a config that selects both vector paths.
 *
 * The two index different fields with different contents, so a silent precedence rule would build an index
 * nobody asked for.
 *
 * @param also - The manual-path keys that are set, quoted and joined.
 * @returns The message.
 */
const BOTH_VECTOR_PATHS = (also: string): string =>
  "strands_mongodb: 'embeddingModel' selects the Atlas AutoEmbeddings path, where the deployment embeds the " +
  `text, and ${also} selects the manual path, where you supply the vectors. They index different fields with ` +
  "different contents, so set one or the other. Remove 'embeddingModel' to embed client-side, or remove " +
  `${also} to let Atlas do it.`

/**
 * The message for a similarity with no vector length.
 *
 * @returns The message.
 */
const SIMILARITY_WITHOUT_DIMENSIONS = (): string =>
  "strands_mongodb: 'similarity' is set but 'embeddingDimensions' is not, and a vector index cannot be " +
  "created without the vector length. Set 'embeddingDimensions' to the length your embedding model produces, " +
  "or remove 'similarity' to use Atlas AutoEmbeddings."

/**
 * The message for a vector length with no similarity.
 *
 * There is no default, because the right metric is a property of the embeddings and the wrong one returns
 * plausible neighbours that are the wrong neighbours.
 *
 * @returns The message.
 */
const DIMENSIONS_WITHOUT_SIMILARITY = (): string =>
  "strands_mongodb: 'embeddingDimensions' is set but 'similarity' is not. There is no default: the right " +
  'metric is a property of your embeddings, and the wrong one returns plausible neighbours that are the wrong ' +
  `neighbours. Set one of ${SIMILARITIES.join(', ')}.`

/**
 * The message for a vector length Atlas would refuse with code 8.
 *
 * @param dimensions - The configured length.
 * @returns The message.
 */
const DIMENSIONS_OUT_OF_RANGE = (dimensions: number): string =>
  `strands_mongodb: 'embeddingDimensions' is ${dimensions}, and Atlas requires a value within bounds ` +
  `[1..${MAX_DIMENSIONS}]. Set it to the length your embedding model produces.`

/**
 * The message for a metric Atlas does not know.
 *
 * @param similarity - The configured metric.
 * @returns The message.
 */
const UNKNOWN_SIMILARITY = (similarity: unknown): string =>
  `strands_mongodb: 'similarity' is ${repr(similarity)}, which Atlas does not accept. Choose one of ` +
  `${SIMILARITIES.join(', ')}.`

/**
 * Refuse a negative `ttlSeconds`.
 *
 * A negative lifetime stamps an `expires_at` in the past, so the TTL monitor deletes every write on its next
 * sweep. Zero is allowed: it asks for expiry at the next sweep.
 *
 * @param ttlSeconds - The configured lifetime, or `undefined` for no expiry.
 * @throws RangeError when `ttlSeconds` is below zero.
 */
export function checkTtl(ttlSeconds: number | undefined): void {
  if (ttlSeconds !== undefined && ttlSeconds < 0) throw new RangeError(NEGATIVE_TTL(ttlSeconds))
}

/**
 * Read a reported search-index status.
 *
 * Only `READY` and `FAILED` are terminal. Anything else, including a status added to the server after this
 * package was written, is treated as a build still in progress, so the wait goes on until the timeout
 * rather than failing on a word it does not know.
 *
 * @param status - The `status` field `listSearchIndexes` reported.
 * @returns What the status means here.
 */
export function readiness(status: string): Readiness {
  if (status === 'READY') return 'ready'
  if (status === 'FAILED') return 'failed'
  return 'building'
}

/**
 * Resolve which vector path a config selects, refusing a config that selects both or half of one.
 *
 * Checked here rather than left to the server, because the server refuses a bad definition only at index
 * creation, after the collection has been created and the store has started.
 *
 * @param config - The store's config. Only the three vector keys are read.
 * @returns The resolved mode.
 * @throws Error when the config sets both paths, or one of the two manual keys without the other.
 * @throws RangeError when `embeddingDimensions` is outside `[1..8192]` or `similarity` is not one Atlas accepts.
 */
export function vectorMode(
  config: Pick<MongoDBConfig, 'embeddingModel' | 'embeddingDimensions' | 'similarity'>,
): VectorMode {
  const { embeddingModel: model, embeddingDimensions: dimensions, similarity } = config
  if (model !== undefined && (dimensions !== undefined || similarity !== undefined)) {
    const also = [
      ...(dimensions !== undefined ? ["'embeddingDimensions'"] : []),
      ...(similarity !== undefined ? ["'similarity'"] : []),
    ].join(', ')
    throw new Error(BOTH_VECTOR_PATHS(also))
  }
  if (dimensions === undefined && similarity === undefined) {
    return { autoEmbed: true, model: model ?? DEFAULT_EMBEDDING_MODEL }
  }
  if (dimensions === undefined) throw new Error(SIMILARITY_WITHOUT_DIMENSIONS())
  if (similarity === undefined) throw new Error(DIMENSIONS_WITHOUT_SIMILARITY())
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
    throw new RangeError(DIMENSIONS_OUT_OF_RANGE(dimensions))
  }
  if (!SIMILARITIES.includes(similarity)) throw new RangeError(UNKNOWN_SIMILARITY(similarity))
  return { autoEmbed: false, dimensions, similarity }
}

/**
 * The fields a vector index declares filterable: the baked-in pair, then the caller's, each once.
 *
 * Atlas rejects a definition with two `filter` entries on one path, so a caller listing `scope` again, or one
 * field twice, gets it declared once.
 *
 * @param extra - The caller's `filterFields`.
 * @returns The paths, in declaration order.
 */
export function declaredFilterFields(extra: readonly string[] = []): string[] {
  return [...new Set([...BAKED_IN_FILTER_FIELDS, ...extra])]
}

/**
 * The vector index definition for a mode.
 *
 * @param mode - The resolved vector path.
 * @param options - The text and vector fields, and the caller's extra filter fields.
 * @returns The definition.
 */
export function vectorIndexDefinition(
  mode: VectorMode,
  options: { textField?: string; vectorField?: string; filterFields?: readonly string[] } = {},
): VectorDefinition {
  const { textField = CONTENT_FIELD, vectorField = VECTOR_FIELD, filterFields = [] } = options
  const embedded: VectorField = mode.autoEmbed
    ? { type: 'autoEmbed', path: textField, model: mode.model, modality: 'text' }
    : { type: 'vector', path: vectorField, numDimensions: mode.dimensions, similarity: mode.similarity }
  return {
    fields: [embedded, ...declaredFilterFields(filterFields).map((path): VectorField => ({ type: 'filter', path }))],
  }
}

/**
 * The full-text index definition: the content field as a string, and nothing mapped dynamically.
 *
 * @returns The definition.
 */
export function textIndexDefinition(): TextDefinition {
  return { mappings: { dynamic: false, fields: { [CONTENT_FIELD]: [{ type: 'string' }] } } }
}

/**
 * One ordinary index: its name, its key list in order, the options it exists for, and whether its
 * collation can be ignored.
 */
export class IndexSpec {
  /**
   * @param name - The index name. Matching is on the keys, so this is what a created index is called.
   * @param keys - The key list, in order, as field and direction pairs.
   * @param options - The options the index exists for. Only these are compared against an existing index.
   * @param dateOnly - True for an index over dates alone, where a collation changes nothing.
   */
  constructor(
    readonly name: string,
    readonly keys: ReadonlyArray<readonly [string, Direction]>,
    readonly options: Readonly<Document> = {},
    readonly dateOnly = false,
  ) {}

  /** The key list as the document the server takes, in order. */
  get key(): Document {
    return Object.fromEntries(this.keys)
  }

  /**
   * The index as `createIndexes` takes it, which is also what the driver's `createIndexes` takes.
   *
   * @returns The description.
   */
  description(): Document {
    return { key: this.key, name: this.name, ...this.options }
  }

  /**
   * The `db.runCommand` that creates this index, to hand to whoever holds the rights.
   *
   * @param collection - The collection the index belongs on.
   * @returns The command, one line, runnable in `mongosh`.
   */
  creationCommand(collection: string): string {
    return `db.runCommand(${pythonJson({ createIndexes: collection, indexes: [this.description()] })})`
  }
}

/**
 * The `db.runCommand` that drops an ordinary index.
 *
 * The name comes from the deployment, so whoever created the index chose it. It is JSON-encoded, which keeps
 * a hostile name inside its string.
 *
 * @param collection - The collection holding the index.
 * @param name - The index name.
 * @returns The command.
 */
export function dropIndexCommand(collection: string, name: string): string {
  return `db.runCommand(${pythonJson({ dropIndexes: collection, index: name })})`
}

/** One search index: its name, its definition, and whether it is a vector or a full-text index. */
export class SearchIndexSpec {
  /**
   * @param name - The index name. Search indexes are found by name.
   * @param definition - The definition `createSearchIndexes` takes.
   * @param type - `vectorSearch` or `search`.
   */
  constructor(
    readonly name: string,
    readonly definition: Readonly<Document>,
    readonly type: 'vectorSearch' | 'search',
  ) {}

  /**
   * The `db.runCommand` that creates this index.
   *
   * @param collection - The collection the index belongs on.
   * @returns The command.
   */
  creationCommand(collection: string): string {
    return `db.runCommand(${pythonJson({
      createSearchIndexes: collection,
      indexes: [{ name: this.name, type: this.type, definition: this.definition }],
    })})`
  }

  /**
   * The `db.runCommand` that drops this index.
   *
   * @param collection - The collection holding the index.
   * @returns The command.
   */
  dropCommand(collection: string): string {
    return `db.runCommand(${pythonJson({ dropSearchIndex: collection, name: this.name })})`
  }
}

/**
 * The TTL index both surfaces declare.
 *
 * `expireAfterSeconds: 0` makes each document's own `expires_at` the moment it goes. Date-only, so a
 * collation on it is accepted: a collation affects string comparison, and this index holds none.
 */
function ttlSpec(): IndexSpec {
  return new IndexSpec('strands_expires_at_ttl', [[EXPIRES_FIELD, 1]], { expireAfterSeconds: 0 }, true)
}

/**
 * The ordinary indexes on a `MongoDBStorage` collection: its TTL index alone.
 *
 * @returns The specs.
 */
export function storageSpecs(): IndexSpec[] {
  return [ttlSpec()]
}

/**
 * The ordinary indexes on a `MongoDBMemoryStore` collection: dedup, recency and TTL, in that order.
 *
 * The dedup index is partial, because a unique index treats a missing field as `null` and documents without
 * a hash would otherwise collide. The TTL index is declared whether or not a lifetime is configured, so
 * turning one on later needs no DDL.
 *
 * @returns The specs.
 */
export function memorySpecs(): IndexSpec[] {
  return [
    new IndexSpec(
      'strands_scope_store_content_hash_unique',
      [
        ['scope', 1],
        ['store_name', 1],
        ['content_hash', 1],
      ],
      { unique: true, partialFilterExpression: { content_hash: { $exists: true } } },
    ),
    new IndexSpec('strands_scope_store_created_at', [
      ['scope', 1],
      ['store_name', 1],
      ['created_at', -1],
    ]),
    ttlSpec(),
  ]
}

/**
 * The two search indexes on a memory collection: vector first, then full text.
 *
 * Built from the config, because both names and the vector definition come from it. The mode is resolved
 * here as well, so a conflicting config is refused on the path `initialize()` actually takes.
 *
 * @param config - The store's config.
 * @returns The vector spec and the text spec.
 * @throws Error when the vector keys conflict, as {@link vectorMode} does.
 * @throws RangeError when a vector key is out of range, as {@link vectorMode} does.
 */
export function memorySearchSpecs(config: MongoDBConfig): [SearchIndexSpec, SearchIndexSpec] {
  const mode = vectorMode(config)
  return [
    new SearchIndexSpec(
      config.vectorIndexName || DEFAULT_VECTOR_INDEX_NAME,
      vectorIndexDefinition(mode, { filterFields: config.filterFields ?? [] }),
      'vectorSearch',
    ),
    new SearchIndexSpec(config.textIndexName || DEFAULT_TEXT_INDEX_NAME, textIndexDefinition(), 'search'),
  ]
}

/**
 * Serialise `value` exactly as Python's `json.dumps` does with its defaults.
 *
 * One space after each comma and colon, and every character outside ASCII escaped as `\uXXXX`. That is what
 * lets `python/README.md` document one command for both packages. Only the JSON types are expected: an
 * `undefined` member is left out, as `JSON.stringify` leaves it out.
 *
 * @param value - A JSON value.
 * @returns The text.
 */
export function pythonJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(
      /[\u007f-￿]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, member]) => member !== undefined)
  return `{${entries.map(([name, member]) => `${pythonJson(name)}: ${pythonJson(member)}`).join(', ')}}`
}

/**
 * A value as Python's `repr` would show it in a message: strings in single quotes, the rest as JSON.
 *
 * @param value - The value.
 * @returns The text.
 */
export function repr(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  if (value === undefined) return 'undefined'
  return JSON.stringify(value) ?? String(value)
}
