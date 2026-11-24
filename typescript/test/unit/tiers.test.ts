import { relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_ROOT, testFiles } from '../support/scan.js'
import { TIER_VARIABLES } from '../support/tiers.js'

const TIER_DIRECTORIES = ['unit', 'contract', 'integration', 'autoembed', 'build', 'example', 'gate']

describe('TS-007 — every test file sits under a tier', () => {
  it('no test file falls outside every vitest project, which is the equivalent of --strict-markers', () => {
    const outside = testFiles()
      .map((file) => relative(TEST_ROOT, file))
      .filter((file) => !TIER_DIRECTORIES.includes(file.split(sep)[0] ?? ''))
    expect(outside).toEqual([])
  })

  it('the tiers are gated on the same variables as the Python suite', () => {
    expect(TIER_VARIABLES).toEqual({
      contract: 'MONGODB_URI',
      integration: 'MONGODB_ATLAS_URI',
      autoembed: 'MONGODB_AUTOEMBED_URI',
      build: 'STRANDS_MONGODB_BUILD_TIER',
    })
  })
})
