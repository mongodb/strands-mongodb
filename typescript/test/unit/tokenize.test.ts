/**
 * The keyword tokenizer `MongoDBStorage.search` scores keys with.
 *
 * Python imports the SDK's `tokenize` and `token_overlap_score`. The TypeScript SDK does not export its copies,
 * so `src/tokenize.ts` reimplements them, and the comparison below runs the SDK's own `KeywordSearchStrategy`
 * over the same keys so that a drift in the SDK fails a test rather than ranking differently.
 *
 * Python's `MongoDBStorage.search` does not drop stop words and does not strip an extension, both of which the
 * SDK's strategy does. This package follows Python, so the comparison uses keys with no extension and no stop
 * word in them, where the two must agree exactly.
 */
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
import { describe, expect, it } from 'vitest'

import { tokenize, tokenOverlapScore } from '../../src/tokenize.js'

describe('TS-012 — the tokenizer splits on anything that is not a letter, a number or an underscore', () => {
  it.each([
    ['Dark-Mode toggle', ['dark', 'mode', 'toggle']],
    ['state.json', ['state', 'json']],
    ['dark_mode', ['dark_mode']],
    ['münchen café', ['münchen', 'café']],
    ['日本語', ['日本語']],
    ['v2 x²', ['v2', 'x²']],
    ['the the THE', ['the']],
    ['  ', []],
    ['', []],
  ])('TS-012 — %j tokenizes to %j', (text, expected) => {
    expect([...tokenize(text)]).toEqual(expected)
  })

  it('TS-012 — stop words are kept, as Python keeps them in storage search', () => {
    expect(tokenize('what is the state')).toEqual(new Set(['what', 'is', 'the', 'state']))
  })

  it('TS-012 — the overlap score counts distinct query tokens found in the content', () => {
    const query = tokenize('dark mode toggle')

    expect(tokenOverlapScore(query, 'ui/dark-mode/dark')).toBe(2)
    expect(tokenOverlapScore(query, 'Toggle')).toBe(1)
    expect(tokenOverlapScore(query, 'dark_mode')).toBe(0)
  })
})

const KEYS = [
  'settings/dark_mode',
  'ui/dark-mode-toggle',
  'ui/toggle',
  'notes/münchen/café',
  'notes/日本語',
  'state/json',
  'session/state',
  'misc/nothing',
  'Dark/MODE',
]

const QUERIES = ['dark mode toggle', 'münchen café', '日本語', 'state json', 'toggle', 'nothing here', 'absent']

describe("TS-012 — scoring agrees with the SDK's KeywordSearchStrategy", () => {
  it.each(QUERIES)('TS-012 — %j ranks the same keys with the same scores', async (query) => {
    const memory = new InMemoryStorage()
    for (const key of KEYS) await memory.write(key, new Uint8Array())

    const expected = (await KeywordSearchStrategy.search(memory, query)).map(({ key, score }) => ({ key, score }))

    const tokens = tokenize(query)
    const actual = [...KEYS]
      .sort()
      .map((key) => ({ key, score: tokenOverlapScore(tokens, key) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)

    expect(actual).toEqual(expected)
  })
})
