/**
 * The keyword tokenizer `MongoDBStorage.search` scores keys with.
 *
 * Copied from `dist/src/storage/search/keyword.js` in `@strands-agents/sdk` 1.26.0, which does not export it.
 * The server-side half of storage search applies the same pattern, `[\p{L}\p{N}_]+`, to the stored keys, so a
 * query token and a key token are cut by one rule.
 *
 * The SDK's `KeywordSearchStrategy` also drops stop words from the query and strips a file extension from each
 * key. The Python package's storage search does neither, and this package follows Python, so neither is copied.
 * `test/unit/tokenize.test.ts` holds the copy to the SDK's strategy on inputs where the two must agree.
 *
 * @packageDocumentation
 */

/** Runs of anything that is not a letter, a number or an underscore. */
const SEPARATOR = /[^\p{L}\p{N}_]+/u

/**
 * Split text into a set of lowercased word tokens for keyword matching.
 *
 * @param text - The text to split.
 * @returns The distinct tokens, in order of first appearance.
 */
export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(SEPARATOR).filter(Boolean))
}

/**
 * Lexical relevance: how many distinct query tokens appear in the content.
 *
 * @param queryTokens - The query's tokens, from {@link tokenize}.
 * @param content - The text to score.
 * @returns The overlap, `0` when there is none.
 */
export function tokenOverlapScore(queryTokens: ReadonlySet<string>, content: string): number {
  let score = 0
  for (const token of tokenize(content)) {
    if (queryTokens.has(token)) score++
  }
  return score
}
