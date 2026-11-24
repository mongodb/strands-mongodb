/**
 * A throwaway database on a tier's deployment, for the tests inside one `describeTier` block.
 *
 * Every database is named `strands_mongodb_test_<8 hex>` and dropped when the block ends, so a shared
 * deployment only ever holds this suite's databases for as long as a block runs. The Python suite names its
 * databases the same way, so one cleanup pattern covers both.
 */
import { randomBytes } from 'node:crypto'

import { type Db, MongoClient } from 'mongodb'
import { afterAll, beforeAll } from 'vitest'

import { type Tier, tierValue } from './tiers.js'

/** The prefix every test database carries. */
export const TEST_DATABASE_PREFIX = 'strands_mongodb_test_'

/** A fresh name under {@link TEST_DATABASE_PREFIX}, or a fresh collection name when `prefix` is given. */
export function uniqueName(prefix = TEST_DATABASE_PREFIX): string {
  return `${prefix}${randomBytes(4).toString('hex')}`
}

/** What {@link useDeployment} hands the tests: the client and the database, once `beforeAll` has run. */
export interface Deployment {
  readonly client: MongoClient
  readonly db: Db
}

/**
 * Connect to a tier's deployment for the enclosing block, and drop the block's database after it.
 *
 * Call it at the top of a `describeTier` body. When the tier is disabled the block is skipped, its hooks
 * never run and nothing connects.
 *
 * @param tier - The tier whose variable names the deployment.
 * @returns A getter, valid inside tests, for the client and database.
 */
export function useDeployment(tier: Tier): () => Deployment {
  let deployment: Deployment | undefined
  beforeAll(async () => {
    const client = new MongoClient(tierValue(tier))
    await client.connect()
    deployment = { client, db: client.db(uniqueName()) }
  })
  afterAll(async () => {
    if (deployment === undefined) return
    try {
      await deployment.db.dropDatabase()
    } finally {
      await deployment.client.close()
    }
  })
  return () => {
    if (deployment === undefined) throw new Error('the deployment is only available inside a test')
    return deployment
  }
}
