/**
 * The README's `run: autoembed` blocks, run as written against a cluster with a registered embedding model.
 * Ports the autoembed half of `python/tests/test_readme.py`.
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-159 | AT-092 | The memory quickstart runs unedited where a reader is told it will |
 */
import { runReadmeBlocks } from '../support/readme-run.js'
import { describeTier } from '../support/tiers.js'

describeTier('autoembed', 'TS-159 — the README autoembed blocks run', () => {
  runReadmeBlocks('autoembed', 'TS-159')
})
