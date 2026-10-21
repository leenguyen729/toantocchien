import { ManualClock, createSystem, loadRuntimeConfig, seedDemo, systemClock } from '@pod/domain';
import { buildApp } from './app';

/**
 * Local entrypoint. Without DATABASE_URL it runs the zero-dependency demo:
 * in-memory store + fake Meta + in-process worker loop, mock mode only.
 * With DATABASE_URL: Postgres store; in mock mode the worker still runs in-process
 * (fake Meta is in-memory), outside mock apps/worker holds the write adapter.
 */
async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  if (process.env.DATABASE_URL) {
    const { PgStore } = await import('@pod/domain/pg');
    const store = await PgStore.connect(process.env.DATABASE_URL);
    // The fake Meta simulator is in-memory, so in mock mode the worker must share this process.
    // Outside mock the API never holds a write adapter; apps/worker does.
    const mock = runtime.mode === 'mock';
    const sys = createSystem({ runtime, store, role: mock ? 'all-in-one' : 'api' });
    if (mock && process.env.SEED_DEMO === 'true') await seedDemo(sys);
    const app = await buildApp({ sys, mockTools: mock, webOrigin: process.env.WEB_ORIGIN });
    if (mock) {
      const timer = setInterval(() => void sys.worker?.drain(10).catch(() => undefined), 1000);
      app.addHook('onClose', async () => clearInterval(timer));
    }
    await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: process.env.API_HOST ?? '127.0.0.1' });
    console.log(`API (Postgres, mode=${runtime.mode}, role=${mock ? 'all-in-one' : 'api'}) :${process.env.API_PORT ?? 4000}`);
    return;
  }
  if (runtime.mode !== 'mock') throw new Error('Demo in-memory chỉ chạy EXECUTION_MODE=mock');
  const clock = process.env.DEMO_FIXED_CLOCK ? new ManualClock(process.env.DEMO_FIXED_CLOCK) : systemClock;
  const sys = createSystem({ runtime, clock, role: 'all-in-one' });
  await seedDemo(sys);
  const app = await buildApp({ sys, mockTools: true, webOrigin: process.env.WEB_ORIGIN });
  const timer = setInterval(() => {
    sys.worker?.drain(10).catch(() => undefined);
  }, 1000);
  app.addHook('onClose', async () => clearInterval(timer));
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: process.env.API_HOST ?? '127.0.0.1' });
  console.log(`API demo (in-memory, mock, LIVE_WRITES_ENABLED=false) http://127.0.0.1:${port}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'startup failed');
  process.exit(1);
});
