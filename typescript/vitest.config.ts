import { defineConfig } from 'vitest/config'

const tiers = ['unit', 'contract', 'integration', 'autoembed', 'build', 'example', 'gate'] as const

export default defineConfig({
  test: {
    // The gate reporter reads every project's results, which no test running in a worker can.
    reporters: ['default', './test/support/gate-reporter.ts'],
    projects: tiers.map((name) => ({
      test: {
        name,
        include: [`test/${name}/**/*.test.ts`],
        // Search indexes take minutes to become READY, so the deployment tiers get a long ceiling.
        testTimeout: name === 'unit' || name === 'gate' ? 10_000 : 600_000,
        hookTimeout: name === 'unit' || name === 'gate' ? 10_000 : 600_000,
      },
    })),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 90 across the package, and no file below 70, matching the Python suite's two floors.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        perFile: { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
  },
})
