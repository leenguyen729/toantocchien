import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/ui/**', ...(process.env.DATABASE_URL ? [] : ['tests/integration/pg/**'])],
    env: { EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false' },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'reports/coverage',
      // Core money/state modules carry the >=90% branch target from the spec.
      include: [
        'packages/policy/src/**/*.ts',
        'packages/domain/src/state-machine.ts',
        'packages/domain/src/rbac.ts',
        'packages/domain/src/proposal-service.ts',
        'packages/domain/src/approval-service.ts',
        'packages/domain/src/execution-service.ts',
        'packages/contracts/src/canonical.ts',
        'packages/contracts/src/currency.ts',
      ],
      thresholds: { branches: 90 },
    },
  },
});
