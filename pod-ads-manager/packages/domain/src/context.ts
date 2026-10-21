import { canonicalHash } from '@pod/contracts';
import type { MetaReadAdapter, MetaWriteAdapter } from '@pod/adapter-meta';
import type { Clock } from './clock';
import type { Principal } from './rbac';
import type { RuntimeConfig } from './runtime-config';
import type { Store } from './store/types';

export type Deps = {
  store: Store;
  clock: Clock;
  runtime: RuntimeConfig;
  metaRead: MetaReadAdapter;
  /** Only the execution worker receives a write adapter. API/tool processes get null. */
  metaWrite: MetaWriteAdapter | null;
};

export type Actor = Pick<Principal, 'actor_id' | 'tenant_id' | 'kind'> | { actor_id: string; tenant_id: string; kind: 'system' };

/** Append a hash-chained audit event. Payload is hashed, never stored raw, so no PII/secret lands in audit. */
export async function audit(
  store: Store,
  clock: Clock,
  actor: Actor,
  correlationId: string,
  eventType: string,
  payload: unknown,
  summary: string,
): Promise<void> {
  await store.appendAudit({
    tenant_id: actor.tenant_id,
    actor_id: actor.actor_id,
    actor_kind: actor.kind,
    correlation_id: correlationId,
    event_type: eventType,
    payload_hash: canonicalHash(payload ?? null),
    summary: summary.slice(0, 500),
    occurred_at: clock.now().toISOString(),
  });
}
