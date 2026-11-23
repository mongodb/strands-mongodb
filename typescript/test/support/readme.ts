/**
 * Reading `typescript/README.md` the way its tests need: fenced blocks with the directive above each, and
 * the tables that follow an HTML-comment marker.
 *
 * A block's directive is the comment on the nearest non-blank line above its fence: `<!-- run: <tier> -->`
 * for a block a test executes, or `<!-- skip: <reason> -->` for one it does not. Blank lines are allowed in
 * between because Prettier puts one there. Ported from the helpers in `python/tests/test_readme.py`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_ROOT } from './program.js'

export const README_PATH = join(PACKAGE_ROOT, 'README.md')

/**
 * Where executed and typechecked blocks are written. Ignored by git, Prettier and ESLint, and outside
 * `node_modules`, which Vitest would hand to Node untransformed.
 */
export const SNIPPET_ROOT = join(PACKAGE_ROOT, '.snippets')

export interface Block {
  /** The 1-based line of the opening fence. */
  readonly line: number
  /** The fence's info string, such as `ts` or `bash`. */
  readonly language: string
  /** `run` or `skip`, or `undefined` when the nearest non-blank line above the fence is not a directive. */
  readonly directive: 'run' | 'skip' | undefined
  /** The tier after `run:`, or the reason after `skip:`. */
  readonly argument: string
  readonly code: string
}

const DIRECTIVE = /^<!-- (run|skip): ?(.*?) ?-->$/

/** The README's text. */
export function readme(): string {
  return readFileSync(README_PATH, 'utf8')
}

/** Every fenced block in `text`, in document order. */
export function blocks(text: string = readme()): Block[] {
  const lines = text.split('\n')
  const found: Block[] = []
  for (let index = 0; index < lines.length; index++) {
    const fence = /^```(\S*)$/.exec(lines[index] ?? '')
    if (fence === null) continue
    const end = lines.indexOf('```', index + 1)
    if (end === -1) break
    let above = index - 1
    while (above >= 0 && (lines[above] ?? '').trim() === '') above--
    const directive = DIRECTIVE.exec(lines[above] ?? '')
    found.push({
      line: index + 1,
      language: fence[1] ?? '',
      directive: directive === null ? undefined : (directive[1] as 'run' | 'skip'),
      argument: directive?.[2] ?? '',
      code: lines.slice(index + 1, end).join('\n') + '\n',
    })
    index = end
  }
  return found
}

/** The blocks a test runs in `tier`. */
export function runBlocks(tier: string, text: string = readme()): Block[] {
  return blocks(text).filter((block) => block.directive === 'run' && block.argument === tier)
}

/**
 * The rows of the first table after `marker`, as trimmed cells, header and separator dropped.
 *
 * @param marker - The full comment line, such as `<!-- limits -->`.
 * @returns The rows, or none when the marker is absent.
 */
export function tableAfter(marker: string, text: string = readme()): string[][] {
  const lines = text.split('\n')
  const start = lines.indexOf(marker)
  if (start === -1) return []
  const rows: string[][] = []
  let header = true
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      if (rows.length > 0 || !header) break
      continue
    }
    if (header) {
      header = false
      continue
    }
    const cells = splitRow(line)
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    rows.push(cells)
  }
  return rows
}

/** A Markdown table row's cells, honouring `\|` inside a cell. */
export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'))
}

/** A cell's text without the backticks around it. */
export function unquote(cell: string): string {
  return cell.replace(/^`(.*)`$/, '$1')
}

/** Every heading's GitHub anchor: lowercased, punctuation dropped, spaces to hyphens. */
export function anchors(text: string = readme()): Set<string> {
  const found = new Set<string>()
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    const heading = inFence ? null : /^#{1,6} (.*)$/.exec(line)
    if (heading?.[1] === undefined) continue
    found.add(
      heading[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, '')
        .replaceAll(' ', '-'),
    )
  }
  return found
}

/**
 * Write a TypeScript block to a module of its own, with the package import pointed at `src/`.
 *
 * The README imports `strands-mongodb`, as a user would. Pointing that at the source rather than at `dist/`
 * means the unit and contract tiers need no build first; the build tier is what proves the published name
 * resolves.
 *
 * @param block - A `ts` block.
 * @param name - The file's base name, unique within a run.
 * @returns The written file's path.
 */
export function writeSnippet(block: Block, name: string): string {
  mkdirSync(SNIPPET_ROOT, { recursive: true })
  const path = join(SNIPPET_ROOT, `${name}.ts`)
  const source = block.code.replaceAll("from 'strands-mongodb'", "from '../src/index.js'")
  writeFileSync(path, source)
  written.push(path)
  return path
}

/**
 * The snippets this module instance wrote. Vitest gives each test file its own module instance, and the tiers
 * run in parallel, so a file removes only its own snippets rather than the directory another file is using.
 */
const written: string[] = []

/** Remove every snippet {@link writeSnippet} wrote for the calling test file. */
export function removeSnippets(): void {
  for (const path of written.splice(0)) rmSync(path, { force: true })
}
