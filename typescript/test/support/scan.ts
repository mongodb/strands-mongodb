/**
 * Static discovery of test titles, for the half of the release gate that must hold without running anything:
 * whether each id the checklist names is declared by some test at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export interface FoundTitle {
  readonly file: string
  readonly title: string
}

const STRING = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60((?:[^\x60\\]|\\.)*)\x60)`
const CALL = new RegExp(String.raw`\b(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^)]*\))?)*\(\s*${STRING}`, 'g')
const TIER_CALL = new RegExp(String.raw`\bdescribeTier\(\s*'[a-z]+'\s*,\s*${STRING}`, 'g')

/** Every `*.test.ts` file under `test/`. */
export function testFiles(dir: string = TEST_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return testFiles(path)
    return entry.endsWith('.test.ts') ? [path] : []
  })
}

/** The string-literal title of every `it`, `test`, `describe` and `describeTier` call in the suite. */
export function scanTitles(files: readonly string[] = testFiles()): FoundTitle[] {
  const found: FoundTitle[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of [CALL, TIER_CALL]) {
      for (const match of source.matchAll(pattern)) {
        const title = match[1] ?? match[2] ?? match[3]
        if (title !== undefined) found.push({ file, title })
      }
    }
  }
  return found
}
