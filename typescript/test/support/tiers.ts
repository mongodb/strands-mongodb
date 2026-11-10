/**
 * Tier gating. A tier that needs a deployment runs only when its environment variable is non-empty, and
 * otherwise skips with a reason that names the variable. Variables come from the process environment and
 * from `typescript/.env` if one exists. A variable set to the empty string opts out, so a value already in
 * the environment always wins over the file, including an empty one.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe } from 'vitest'

export type Tier = 'contract' | 'integration' | 'autoembed' | 'build'

/** The environment variable that gates each tier. The names are shared with the Python suite on purpose. */
export const TIER_VARIABLES: Readonly<Record<Tier, string>> = {
  contract: 'MONGODB_URI',
  integration: 'MONGODB_ATLAS_URI',
  autoembed: 'MONGODB_AUTOEMBED_URI',
  build: 'STRANDS_MONGODB_BUILD_TIER',
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Parse `KEY=value` lines. Quotes around a value are stripped; comments and blank lines are ignored. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function loadDotenv(): void {
  const path = join(PACKAGE_ROOT, '.env')
  if (!existsSync(path)) return
  for (const [key, value] of Object.entries(parseDotenv(readFileSync(path, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotenv()

/** The value of a tier's variable, or the empty string when it is unset or empty. */
export function tierValue(tier: Tier): string {
  return process.env[TIER_VARIABLES[tier]] ?? ''
}

/** Whether a tier's variable is non-empty. */
export function tierEnabled(tier: Tier): boolean {
  return tierValue(tier) !== ''
}

/**
 * `describe` for a tier: skipped, with a reason naming the variable, when the variable is empty.
 *
 * @param tier - The tier whose variable gates the block.
 * @param title - The block title. The ids that open it count as evidence for the release gate.
 * @param body - The tests.
 */
export function describeTier(tier: Tier, title: string, body: () => void): void {
  const variable = TIER_VARIABLES[tier]
  describe.skipIf(!tierEnabled(tier))(`${title} [needs ${variable}]`, body)
}
