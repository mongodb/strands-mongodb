import { describe, expect, it } from 'vitest'
import { VERSION } from '../../src/index.js'
import { parseDotenv } from '../support/tiers.js'

describe('TS-000 — the scaffold', () => {
  it('TS-000 — the package exports a semver VERSION read from package.json', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('TS-000 — a .env line parses with quotes stripped and comments ignored', () => {
    expect(parseDotenv('# c\nA="x y"\nexport B=2\n\nC=')).toEqual({ A: 'x y', B: '2', C: '' })
  })
})
