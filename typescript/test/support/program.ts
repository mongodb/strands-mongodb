/**
 * One TypeScript program over `src/`, built once per test file, for the tests that read declarations rather
 * than text: the README's key and API tables, the `@throws` and no-`null` conventions.
 *
 * Built from `tsconfig.json`'s own options, so what the tests see is what `npm run typecheck` sees. Building
 * takes a few seconds, so callers build it in a `beforeAll` with a timeout of its own.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SOURCE_ROOT = join(PACKAGE_ROOT, 'src')
export const ENTRY_POINT = join(SOURCE_ROOT, 'index.ts')

/** The compiler options `tsconfig.json` declares, resolved against the package root. */
export function compilerOptions(): ts.CompilerOptions {
  const path = join(PACKAGE_ROOT, 'tsconfig.json')
  const read = ts.readConfigFile(path, (file) => ts.sys.readFile(file))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PACKAGE_ROOT)
  return parsed.options
}

/** A program whose roots are every file under `src/`, plus any extra roots given. */
export function sourceProgram(extraRoots: readonly string[] = [], options = compilerOptions()): ts.Program {
  const roots = ts.sys.readDirectory(SOURCE_ROOT, ['.ts']).concat(extraRoots)
  return ts.createProgram(roots, options)
}

/** The source file for a path under `src/`, or a thrown error naming it. */
export function sourceFile(program: ts.Program, path: string): ts.SourceFile {
  const file = program.getSourceFile(path)
  if (file === undefined) throw new Error(`${path} is not in the program`)
  return file
}

/** Every name the entry point exports, values and types alike, sorted. */
export function entryPointExports(program: ts.Program): string[] {
  const checker = program.getTypeChecker()
  const module = checker.getSymbolAtLocation(sourceFile(program, ENTRY_POINT))
  if (module === undefined) throw new Error('src/index.ts has no module symbol')
  return checker
    .getExportsOfModule(module)
    .map((symbol) => symbol.getName())
    .sort()
}

/** The interface or type alias `name` exported from the entry point, as a type. */
export function exportedType(program: ts.Program, name: string): ts.Type {
  const checker = program.getTypeChecker()
  const module = checker.getSymbolAtLocation(sourceFile(program, ENTRY_POINT))
  const symbol = module === undefined ? undefined : checker.tryGetMemberInModuleExports(name, module)
  if (symbol === undefined) throw new Error(`src/index.ts does not export ${name}`)
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  return checker.getDeclaredTypeOfSymbol(target)
}

/** Every property of an exported interface, inherited ones included, with whether it is optional. */
export function declaredKeys(program: ts.Program, name: string): Map<string, boolean> {
  const checker = program.getTypeChecker()
  const keys = new Map<string, boolean>()
  for (const property of checker.getPropertiesOfType(exportedType(program, name))) {
    keys.set(property.getName(), (property.flags & ts.SymbolFlags.Optional) === 0)
  }
  return keys
}
