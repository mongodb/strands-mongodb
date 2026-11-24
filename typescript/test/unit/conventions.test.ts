/**
 * The house conventions a tool can check, ported from `python/tests/test_conventions.py` where TypeScript has an
 * equivalent. None is a checklist item, so each leads with a `TS-` id:
 *
 * | Id | Python counterpart | What it holds |
 * |---|---|---|
 * | TS-161 | AT-114 | No Markdown file in the repository, and no file under `typescript/`, carries a credentialed URI |
 * | TS-162 | AT-113 | Every placeholder under `typescript/` names what has to be settled |
 * | TS-163 | none | `LANDED_THROUGH` is at its final value, so the gate checks every checklist item |
 * | TS-164 | `Optional[X]` | No configuration key admits `null`: absent is `undefined`, one way to say it |
 * | TS-165 | no pydantic | `src/` imports no schema or validation library |
 * | TS-166 | ruff `G` rules | A log call's message is a named message constructor, never built at the call site |
 * | TS-167 | `Raises:` | Every exported function, and every public member of an exported class, that throws says so |
 *
 * The log helper itself, every call passing `eventFields(...)` with a known event, is TS-020 in
 * `test/unit/telemetry.test.ts`, and is not repeated here.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

import { CHECKLIST, isDue, LANDED_THROUGH } from '../checklist.js'
import { declaredKeys, exportedType, PACKAGE_ROOT, SOURCE_ROOT } from '../support/program.js'
import { sourceProgram } from '../support/program.js'

const REPOSITORY_ROOT = join(PACKAGE_ROOT, '..')

/** Building a program over `src/` takes seconds, well past the unit tier's 10 s default on a cold cache. */
const PROGRAM_TIMEOUT_MS = 120_000

/** The expression `python/tests/test_conventions.py` uses: a URI with userinfo that is not the redacted form. */
const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/(?!<redacted>@)[^\s/`]*@/

/**
 * A placeholder marker not followed by a parenthesised name. Built by concatenation so that this file, which has to spell
 * the word, is not itself a match.
 */
const BARE_PLACEHOLDER = new RegExp('TO' + 'DO(?!\\([^)\\s][^)]*\\))')

/** The configuration types a caller writes, each of which must say "absent" one way only. */
const CONFIG_TYPES = [
  'MongoDBConfig',
  'MongoDBMemoryStoreConfig',
  'MongoDBSearchQuery',
  'MongoDBStorageOptions',
  'MongoDBVectorSearchStrategyOptions',
]

/** Schema and validation libraries. The package validates by hand, as Python's does without pydantic. */
const SCHEMA_LIBRARIES = ['zod', 'yup', 'joi', 'valibot', 'superstruct', 'io-ts', 'ajv', 'arktype', 'typebox']

/** A message constructor's name: a module constant in upper snake case. */
const MESSAGE_CONSTRUCTOR = /^[A-Z][A-Z0-9_]*$/

/** Files git would commit: tracked, or untracked and not ignored. `.env`, `.claude/` and `node_modules` are out. */
function committable(): string[] {
  const output = execFileSync(
    'git',
    ['-C', REPOSITORY_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    },
  )
  return output.split('\n').filter((path) => path !== '')
}

/** A file's text, or `undefined` for a binary file or one deleted from the working tree. */
function text(path: string): string | undefined {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(REPOSITORY_ROOT, path))
  } catch {
    return undefined
  }
  return bytes.includes(0) ? undefined : bytes.toString('utf8')
}

/** The source files under `src/`. */
function sources(program: ts.Program): ts.SourceFile[] {
  return program.getSourceFiles().filter((file) => file.fileName.startsWith(SOURCE_ROOT))
}

/** Whether `node` contains a `throw` anywhere inside it, closures included. */
function containsThrow(node: ts.Node): boolean {
  if (ts.isThrowStatement(node)) return true
  return ts.forEachChild(node, containsThrow) ?? false
}

/** Whether `node` is exported from its module. */
function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
}

/** Whether a class member is part of the public surface: not `#private`, `private` or `protected`. */
function isPublicMember(member: ts.ClassElement): boolean {
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) return false
  const flags = ts.getCombinedModifierFlags(member as ts.Declaration)
  return (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) === 0
}

/** Whether `node`'s doc comment, or that of an overload signature before it, has a `@throws` tag. */
function documentsThrows(node: ts.Node, siblings: readonly ts.Node[]): boolean {
  const name = (node as { name?: ts.Node }).name?.getText()
  const overloads = siblings.filter(
    (sibling) =>
      sibling !== node && sibling.kind === node.kind && (sibling as { name?: ts.Node }).name?.getText() === name,
  )
  return [node, ...overloads].some((each) => ts.getJSDocTags(each).some((tag) => tag.tagName.text === 'throws'))
}

/** Every public declaration in `file` whose body throws without a `@throws` tag, as `file: name`. */
function undocumentedThrows(file: ts.SourceFile): string[] {
  const where = file.fileName.slice(SOURCE_ROOT.length + 1)
  const missing: string[] = []
  for (const statement of file.statements) {
    if (!isExported(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.body !== undefined && containsThrow(statement.body)) {
      if (!documentsThrows(statement, file.statements)) missing.push(`${where}: ${statement.name?.text ?? 'default'}`)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer
        if (value === undefined || !(ts.isArrowFunction(value) || ts.isFunctionExpression(value))) continue
        if (containsThrow(value.body) && !documentsThrows(statement, [])) {
          missing.push(`${where}: ${declaration.name.getText()}`)
        }
      }
    }
    if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text ?? 'default'
      for (const member of statement.members) {
        if (!isPublicMember(member)) continue
        const body = (member as { body?: ts.Node }).body
        if (body === undefined || !containsThrow(body)) continue
        if (!documentsThrows(member, statement.members)) {
          const name = ts.isConstructorDeclaration(member) ? 'constructor' : (member.name?.getText() ?? '?')
          missing.push(`${where}: ${className}.${name}`)
        }
      }
    }
  }
  return missing
}

/** Every `logger.<level>(fields, message)` call in `file`. */
function logCalls(file: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'logger' &&
      ['debug', 'info', 'warn', 'error'].includes(node.expression.name.text)
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

/** Whether a log message expression is a message constructor's output, following one local variable. */
function isNamedMessage(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isCallExpression(expression)) {
    return ts.isIdentifier(expression.expression) && MESSAGE_CONSTRUCTOR.test(expression.expression.text)
  }
  if (ts.isIdentifier(expression)) {
    if (MESSAGE_CONSTRUCTOR.test(expression.text)) return true
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return false
    if (declaration.initializer === undefined || ts.isIdentifier(declaration.initializer)) return false
    return isNamedMessage(declaration.initializer, checker)
  }
  return false
}

let program: ts.Program

beforeAll(() => {
  program = sourceProgram()
}, PROGRAM_TIMEOUT_MS)

describe('TS-161 — no connection string with credentials in it, anywhere a reader or the package can reach', () => {
  it('TS-161 — the detector matches a planted credential and not the redacted form', () => {
    // Assembled here so that this file does not itself carry the shape it hunts for.
    const planted = 'mongodb+srv://' + 'user:pass' + '@cluster.example.net/'
    expect(CREDENTIALED_URI.test(planted)).toBe(true)
    expect(CREDENTIALED_URI.test(planted.replace(/:\/\/[^@/]+@/, '://<redacted>@'))).toBe(false)
    expect(CREDENTIALED_URI.test('mongodb://localhost:27017/?directConnection=true')).toBe(false)
  })

  it('TS-161 — the sweep reaches both READMEs and every file of the package', () => {
    const swept = committable()
    expect(swept).toContain('README.md')
    expect(swept).toContain('python/README.md')
    expect(swept).toContain('typescript/README.md')
    expect(swept).toContain('typescript/src/index.ts')
  })

  it('TS-161 — no Markdown file, and no file under typescript/, contains one', () => {
    const leaking = committable()
      .filter((path) => path.endsWith('.md') || path.startsWith('typescript/'))
      .filter((path) => CREDENTIALED_URI.test(text(path) ?? ''))
    expect(leaking).toEqual([])
  })
})

describe('TS-162 — every placeholder names the thing that has to be settled', () => {
  it('TS-162 — the detector tells a named placeholder from a bare one', () => {
    const word = 'TO' + 'DO'
    expect(BARE_PLACEHOLDER.test(`// ${word} fix this`)).toBe(true)
    expect(BARE_PLACEHOLDER.test(`// ${word}() fix this`)).toBe(true)
    expect(BARE_PLACEHOLDER.test(`// ${word}(NODE-1234) fix this`)).toBe(false)
  })

  it('TS-162 — no file under typescript/ carries a bare one', () => {
    const bare = committable()
      .filter((path) => path.startsWith('typescript/') && path !== 'typescript/package-lock.json')
      .filter((path) => BARE_PLACEHOLDER.test(text(path) ?? ''))
    expect(bare).toEqual([])
  })
})

describe('TS-163 — the release gate checks every checklist item', () => {
  it('TS-163 — LANDED_THROUGH is the last milestone, and every item is due', () => {
    expect(LANDED_THROUGH).toBe('M9')
    expect(CHECKLIST.filter((item) => !isDue(item)).map((item) => item.number)).toEqual([])
  })
})

describe('TS-164 — a configuration key is absent one way: undefined, never null', () => {
  it.each(CONFIG_TYPES)('TS-164 — no key of %s admits null', (name) => {
    const checker = program.getTypeChecker()
    const nullable = checker
      .getPropertiesOfType(exportedType(program, name))
      .filter((property) => {
        const type = checker.getTypeOfSymbol(property)
        const parts = type.isUnion() ? type.types : [type]
        return parts.some((part) => (part.flags & ts.TypeFlags.Null) !== 0)
      })
      .map((property) => property.getName())
    expect(declaredKeys(program, name).size).toBeGreaterThan(0)
    expect(nullable).toEqual([])
  })
})

describe('TS-165 — no schema library', () => {
  it('TS-165 — nothing in src/ imports one', () => {
    const imports = sources(program).flatMap((file) =>
      file.statements
        .filter(ts.isImportDeclaration)
        .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text),
    )
    expect(imports.length).toBeGreaterThan(0)
    const schema = imports.filter((specifier) =>
      SCHEMA_LIBRARIES.some((library) => specifier === library || specifier.startsWith(`${library}/`)),
    )
    expect(schema).toEqual([])
  })

  it('TS-165 — and the package declares none, at any level', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    const declared = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) =>
      Object.keys(manifest[field] ?? {}),
    )
    expect(declared.filter((name) => SCHEMA_LIBRARIES.includes(name))).toEqual([])
  })
})

describe('TS-166 — a log message is a named constructor, not assembled where it is logged', () => {
  it('TS-166 — every log call in src/ passes a message constructor, so a test can assert on it by name', () => {
    const checker = program.getTypeChecker()
    const calls = sources(program).flatMap((file) => logCalls(file).map((call) => ({ file, call })))
    expect(calls.length).toBeGreaterThan(0)
    const assembled = calls
      .filter(({ call }) => {
        const message = call.arguments[1]
        return message === undefined || !isNamedMessage(message, checker)
      })
      .map(
        ({ file, call }) =>
          `${file.fileName.slice(SOURCE_ROOT.length + 1)}:${file.getLineAndCharacterOfPosition(call.getStart()).line + 1}`,
      )
    expect(assembled).toEqual([])
  })
})

describe('TS-167 — anything public that throws says so', () => {
  it('TS-167 — the detector finds a throw in a closure and honours an overload tag', () => {
    const file = ts.createSourceFile(
      join(SOURCE_ROOT, 'planted.ts'),
      [
        'export function bare(): void { [1].forEach(() => { throw new Error("x") }) }',
        '/** @throws RangeError when it is out of range. */',
        'export function tagged(): void { throw new RangeError("x") }',
        'export class Thing {',
        '  method(): void { throw new TypeError("x") }',
        '  #hidden(): void { throw new TypeError("x") }',
        '  /** @throws TypeError always. */',
        '  over(x: string): void',
        '  over(x: string | number): void { throw new TypeError(String(x)) }',
        '}',
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    )
    expect(undocumentedThrows(file)).toEqual(['planted.ts: bare', 'planted.ts: Thing.method'])
  })

  it('TS-167 — every exported function and public member in src/ whose body throws has a @throws tag', () => {
    expect(sources(program).flatMap(undocumentedThrows)).toEqual([])
  })
})
