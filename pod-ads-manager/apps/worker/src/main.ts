import { createSystem, loadRuntimeConfig, newId } from '@pod/domain';

/**
 * Execution worker process. The only role that receives a Meta write adapter.
 * Requires DATABASE_URL (the in-memory demo runs the worker inside the API process).
 */
async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  if (runtime.mode === 'mock') throw new Error('Mock mode: fake Meta là in-memory nên worker chạy chung process với API (pnpm dev:api).');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Worker cần DATABASE_URL. Demo không DB: chạy `pnpm dev:api` (worker chạy trong process).');
  const { PgStore } = await import('@pod/domain/pg');
  const store = await PgStore.connect(url);
  const workerId = process.env.WORKER_ID ?? newId('wrk');
  const sys = createSystem({ runtime, store, role: 'worker', workerId });
  if (!sys.worker) throw new Error('Không có write adapter cho mode hiện tại (read_only?)');
  console.log(`worker ${workerId} mode=${runtime.mode} live_writes=${runtime.liveWritesEnabled}`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    const n = await sys.worker.drain(10).catch(() => 0);
    if (n === 0) await new Promise((r) => setTimeout(r, Number(process.env.WORKER_POLL_MS ?? 1000)));
  }
  await store.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'worker failed');
  process.exit(1);
});
