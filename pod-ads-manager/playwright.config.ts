import { defineConfig } from '@playwright/test';

/**
 * UI E2E against the in-memory mock demo. No token, no network to Meta.
 * API :4100 (fixed ManualClock so expiry is deterministic), web :3100.
 */
const API = 'http://127.0.0.1:4100';
const WEB = 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: 'tests/e2e/ui',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'reports/e2e-ui/results.json' }]],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: 'npx tsx apps/api/src/main.ts',
      url: `${API}/api/health`,
      env: { EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false', API_PORT: '4100', WEB_ORIGIN: WEB, DEMO_FIXED_CLOCK: '2026-10-21T03:00:00Z' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @pod/web exec next build && pnpm --filter @pod/web exec next start -p 3100 -H 127.0.0.1',
      url: WEB,
      env: { NEXT_PUBLIC_API_URL: API, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
