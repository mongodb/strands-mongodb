/**
 * The package version, in a module of its own so `telemetry.ts` can name its tracer without importing the
 * entry point that re-exports it.
 *
 * @packageDocumentation
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as { version: string }

/** The package version, read from `package.json`. */
export const VERSION: string = manifest.version
