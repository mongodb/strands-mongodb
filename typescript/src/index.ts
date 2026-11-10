/**
 * MongoDB storage and memory backends for the Strands Agents SDK.
 *
 * @packageDocumentation
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as { version: string }

/** The package version, read from `package.json`. */
export const VERSION: string = manifest.version
