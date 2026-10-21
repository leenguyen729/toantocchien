import { FakeMetaAdapter, UnverifiedLiveMetaAdapter, type MetaReadAdapter, type MetaWriteAdapter } from '@pod/adapter-meta';
import { ApprovalService } from './approval-service';
import { systemClock, type Clock } from './clock';
import { ConfigService } from './config-service';
import type { Deps } from './context';
import { ExecutionService, ExecutionWorker } from './execution-service';
import { OpsService } from './ops-service';
import { ProposalService } from './proposal-service';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime-config';
import { MemoryStore } from './store/memory';
import type { Store } from './store/types';

export type System = {
  deps: Deps;
  config: ConfigService;
  proposals: ProposalService;
  approvals: ApprovalService;
  execution: ExecutionService;
  ops: OpsService;
  /** Present only when the process is allowed a write adapter (worker role). */
  worker: ExecutionWorker | null;
  /** The fake adapter in mock mode (for seeding/tests); null otherwise. */
  fakeMeta: FakeMetaAdapter | null;
};

export type SystemOptions = {
  store?: Store;
  clock?: Clock;
  runtime?: RuntimeConfig;
  env?: Record<string, string | undefined>;
  fakeMeta?: FakeMetaAdapter;
  /** 'api' processes never get a write adapter. 'all-in-one' is for local demo/tests only. */
  role?: 'api' | 'worker' | 'all-in-one';
  workerId?: string;
};

export function createSystem(opts: SystemOptions = {}): System {
  const runtime = opts.runtime ?? loadRuntimeConfig(opts.env ?? process.env);
  const clock = opts.clock ?? systemClock;
  const store = opts.store ?? new MemoryStore();
  const role = opts.role ?? 'all-in-one';
  let fakeMeta: FakeMetaAdapter | null = null;
  let read: MetaReadAdapter;
  let write: MetaWriteAdapter | null;
  if (runtime.mode === 'mock') {
    fakeMeta = opts.fakeMeta ?? new FakeMetaAdapter({ now: () => clock.now() });
    read = fakeMeta;
    write = role === 'api' ? null : fakeMeta;
  } else {
    const live = new UnverifiedLiveMetaAdapter();
    read = live;
    // read_only never holds a write credential.
    write = role === 'api' || runtime.mode === 'read_only' ? null : live;
  }
  const deps: Deps = { store, clock, runtime, metaRead: read, metaWrite: write };
  return {
    deps,
    config: new ConfigService(deps),
    proposals: new ProposalService(deps),
    approvals: new ApprovalService(deps),
    execution: new ExecutionService(deps),
    ops: new OpsService(deps),
    worker: write ? new ExecutionWorker(deps, { workerId: opts.workerId ?? 'worker-1' }) : null,
    fakeMeta,
  };
}
