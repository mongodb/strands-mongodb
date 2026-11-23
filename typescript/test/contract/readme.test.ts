/**
 * The README's `run: contract` blocks, run as written against any MongoDB. Ports the contract half of
 * `python/tests/test_readme.py`.
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-159 | AT-092 | Every block a reader is told will run against a plain deployment does, unedited |
 */
import { runReadmeBlocks } from '../support/readme-run.js'
import { describeTier } from '../support/tiers.js'

describeTier('contract', 'TS-159 — the README contract blocks run', () => {
  runReadmeBlocks('contract', 'TS-159')
})
