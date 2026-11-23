/**
 * Running the README's `run: contract` and `run: autoembed` blocks against a deployment, as a reader would.
 *
 * A block reads its connection string from `MONGODB_URI` and its database from `MONGODB_DATABASE`, the two
 * variables the README tells a reader to set. The runner points both at the tier's deployment and the test's
 * throwaway database for the length of one block, then puts back whatever was there.
 */
import { afterAll, expect, it } from 'vitest'

import { useDeployment } from './deployment.js'
import { removeSnippets, runBlocks, writeSnippet } from './readme.js'
import { type Tier, tierValue } from './tiers.js'

/** The variables a README block reads. */
const BLOCK_VARIABLES = ['MONGODB_URI', 'MONGODB_DATABASE'] as const

/**
 * Register one test per README block tagged `run: <tier>`, run against that tier's deployment.
 *
 * Call it inside a `describeTier` body.
 *
 * @param tier - The tier whose blocks run, and whose variable names the deployment.
 * @param id - The test id each test leads with.
 */
export function runReadmeBlocks(tier: Tier, id: string): void {
  const deployment = useDeployment(tier)
  const documented = runBlocks(tier)

  afterAll(() => {
    removeSnippets()
  })

  it(`${id} — the README has at least one ${tier} block`, () => {
    expect(documented.length).toBeGreaterThan(0)
  })

  for (const [index, block] of documented.entries()) {
    it(`${id} — the ${tier} block at README line ${block.line} runs as written`, async () => {
      const saved = BLOCK_VARIABLES.map((name) => [name, process.env[name]] as const)
      process.env.MONGODB_URI = tierValue(tier)
      process.env.MONGODB_DATABASE = deployment().db.databaseName
      try {
        await import(writeSnippet(block, `${tier}-${index}-${Date.now()}`))
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
    })
  }
}
