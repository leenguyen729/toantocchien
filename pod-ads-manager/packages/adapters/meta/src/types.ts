import type { RemoteEntity } from '@pod/contracts';

export type EntityType = RemoteEntity['entity_type'];

export type CapabilityInfo = {
  snapshot_id: string;
  verified: boolean;
  source: 'mock_fixture' | 'official_docs' | 'account_probe';
  api_version: string;
  objectives: string[];
  optimization_goals: string[];
  billing_events: string[];
};

export type CreateRequest = {
  entity_type: EntityType;
  parent_id: string | null;
  name: string;
  daily_budget_minor: number | null;
  lifetime_budget_minor: number | null;
  currency: string;
  /** Embedded in the entity name so reconciliation can find a create whose response was lost. */
  idempotency_tag: string;
  extra: Record<string, string | null>;
};

export type UpdateRequest = {
  entity_id: string;
  set: { daily_budget_minor?: number; lifetime_budget_minor?: number; status?: 'ACTIVE' | 'PAUSED' };
};

export type AdapterErrorKind = 'rate_limited' | 'auth' | 'validation' | 'timeout' | 'network' | 'not_found' | 'unsupported';

/**
 * Error from an upstream call. `timeout`/`network` on a mutation means the
 * outcome is UNKNOWN: the request may or may not have committed remotely.
 * Messages are sanitised (no tokens, no request bodies).
 */
export class AdapterError extends Error {
  constructor(
    readonly kind: AdapterErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Read-only surface. Safe to hand to ingestion jobs and read tools. */
export interface MetaReadAdapter {
  readonly kind: 'mock' | 'live';
  listEntities(accountId: string): Promise<RemoteEntity[]>;
  getEntity(accountId: string, entityId: string): Promise<RemoteEntity | null>;
  findByIdempotencyTag(accountId: string, tag: string): Promise<RemoteEntity[]>;
  capabilities(accountId: string): Promise<CapabilityInfo>;
}

/** Write surface. Only the execution worker may hold an instance. */
export interface MetaWriteAdapter extends MetaReadAdapter {
  create(accountId: string, req: CreateRequest): Promise<{ remote_id: string; remote_request_id: string }>;
  update(accountId: string, req: UpdateRequest): Promise<{ remote_request_id: string }>;
}

export const tagSuffix = (tag: string): string => ` [pam:${tag.slice(0, 16)}]`;
