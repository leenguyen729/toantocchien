import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DomainError, type ActionProposal, type ApprovalRecord, type AuditEvent, type BusinessConfig, type DataSnapshot, type ExecutionAttempt, type ExecutionReceipt, type FreezeState, type Incident, type PolicyResult, type ProposalStatus } from '@pod/contracts';
import { UNFROZEN, auditEventHash } from './memory';
import { GENESIS_HASH, type AssetRecord, type AuditInput, type EntityChange, type JobRecord, type LockGrant, type ReservationRecord, type ReviewRecord, type SessionRecord, type Store, type VerifiedEntity } from './types';

// BIGINT money columns come back as JS numbers; values are bounded by MAX_SAFE_INTEGER in the contracts.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('BIGINT outside safe integer range');
  return n;
});

type Q = { query: (text: string, values?: unknown[]) => Promise<pg.QueryResult> };
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const applied: string[] = [];
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

/**
 * PostgreSQL Store. Same contract as MemoryStore. Cross-row invariants use
 * row locks (audit_heads), advisory xact locks (budget scope) and
 * SKIP LOCKED leasing (jobs).
 */
export class PgStore implements Store {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly client: Q | null,
  ) {}

  static async connect(url: string, opts: { migrate?: boolean } = {}): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    if (opts.migrate !== false) await migrate(pool);
    return new PgStore(pool, null);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** A tx client must not run overlapping queries (callers use Promise.all), so they are chained. */
  private chain: Promise<unknown> = Promise.resolve();
  private q(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
    if (!this.client) return this.pool.query(text, values);
    const c = this.client;
    const run = this.chain.then(() => c.query(text, values));
    this.chain = run.catch(() => undefined);
    return run;
  }

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(new PgStore(this.pool, c));
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /** Test/ops helper: wipe all data (never used by app code). */
  async truncateAll(): Promise<void> {
    const tables = ['business_configs', 'proposals', 'policy_results', 'approvals', 'jobs', 'reservations', 'locks', 'execution_attempts', 'local_refs', 'receipts', 'audit_heads', 'freeze_state', 'incidents', 'snapshots', 'creative_reviews', 'creative_assets', 'entity_changes', 'verified_entities', 'sessions'];
    await this.q('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
    await this.q(`TRUNCATE ${[...tables, 'audit_events'].join(', ')}`);
    await this.q('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  }

  async putConfig(cfg: BusinessConfig) {
    try {
      await this.q('INSERT INTO business_configs (tenant_id, ad_account_id, version, data) VALUES ($1,$2,$3,$4)', [cfg.tenant_id, cfg.ad_account_id, cfg.version, cfg]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DomainError('INPUT_INVALID', `Config version ${cfg.version} đã tồn tại`);
      throw e;
    }
  }
  async getLatestConfig(t: string, a: string) {
    const r = await this.q('SELECT data FROM business_configs WHERE tenant_id=$1 AND ad_account_id=$2 ORDER BY seq DESC LIMIT 1', [t, a]);
    return (r.rows[0]?.data as BusinessConfig) ?? null;
  }
  async getConfigVersion(t: string, a: string, v: string) {
    const r = await this.q('SELECT data FROM business_configs WHERE tenant_id=$1 AND ad_account_id=$2 AND version=$3', [t, a, v]);
    return (r.rows[0]?.data as BusinessConfig) ?? null;
  }
  async listConfigVersions(t: string, a: string) {
    const r = await this.q('SELECT data FROM business_configs WHERE tenant_id=$1 AND ad_account_id=$2 ORDER BY seq', [t, a]);
    return r.rows.map((x) => x.data as BusinessConfig);
  }

  private rowToProposal(row: { data: ActionProposal; status: ProposalStatus }): ActionProposal {
    return { ...row.data, status: row.status };
  }
  async insertProposal(p: ActionProposal) {
    try {
      await this.q('INSERT INTO proposals (tenant_id, proposal_id, revision, ad_account_id, status, payload_hash, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [p.tenant_id, p.proposal_id, p.revision, p.ad_account_id, p.status, p.payload_hash, p.created_at, p]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DomainError('INPUT_INVALID', 'Proposal revision đã tồn tại');
      throw e;
    }
  }
  async getProposal(t: string, id: string, rev: number) {
    const r = await this.q('SELECT data, status FROM proposals WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3', [t, id, rev]);
    return r.rows[0] ? this.rowToProposal(r.rows[0]) : null;
  }
  async getLatestProposal(t: string, id: string) {
    const r = await this.q('SELECT data, status FROM proposals WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY revision DESC LIMIT 1', [t, id]);
    return r.rows[0] ? this.rowToProposal(r.rows[0]) : null;
  }
  async listProposals(t: string, f: { statuses?: ProposalStatus[]; ad_account_id?: string } = {}) {
    const r = await this.q(
      'SELECT data, status FROM proposals WHERE tenant_id=$1 AND ($2::text[] IS NULL OR status = ANY($2)) AND ($3::text IS NULL OR ad_account_id=$3) ORDER BY created_at DESC, revision DESC',
      [t, f.statuses ?? null, f.ad_account_id ?? null],
    );
    return r.rows.map((x) => this.rowToProposal(x));
  }
  async casProposalStatus(t: string, id: string, rev: number, from: ProposalStatus, to: ProposalStatus) {
    const r = await this.q('UPDATE proposals SET status=$5 WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3 AND status=$4', [t, id, rev, from, to]);
    return r.rowCount === 1;
  }
  async putPolicyResult(t: string, id: string, rev: number, data: PolicyResult) {
    await this.q('INSERT INTO policy_results (tenant_id, proposal_id, revision, data) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, proposal_id, revision) DO UPDATE SET data=EXCLUDED.data', [t, id, rev, data]);
  }
  async getPolicyResult(t: string, id: string, rev: number) {
    const r = await this.q('SELECT data FROM policy_results WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3', [t, id, rev]);
    return (r.rows[0]?.data as PolicyResult) ?? null;
  }

  async insertApproval(a: ApprovalRecord) {
    await this.q('INSERT INTO approvals (approval_id, tenant_id, proposal_id, revision, data) VALUES ($1,$2,$3,$4,$5)', [a.approval_id, a.tenant_id, a.proposal_id, a.revision, a]);
  }
  async listApprovals(t: string, id: string, rev: number) {
    const r = await this.q('SELECT data FROM approvals WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3 ORDER BY seq', [t, id, rev]);
    return r.rows.map((x) => x.data as ApprovalRecord);
  }

  private rowToJob(r: Record<string, unknown>): JobRecord {
    return {
      job_id: r.job_id as string,
      tenant_id: r.tenant_id as string,
      proposal_id: r.proposal_id as string,
      revision: r.revision as number,
      kind: r.kind as JobRecord['kind'],
      status: r.status as JobRecord['status'],
      attempts: r.attempts as number,
      available_at: iso(r.available_at)!,
      lease_owner: (r.lease_owner as string | null) ?? null,
      lease_until: iso(r.lease_until),
      created_at: iso(r.created_at)!,
      last_error: (r.last_error as string | null) ?? null,
    };
  }
  async insertJob(j: JobRecord) {
    await this.q('INSERT INTO jobs (job_id, tenant_id, proposal_id, revision, kind, status, attempts, available_at, lease_owner, lease_until, created_at, last_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [j.job_id, j.tenant_id, j.proposal_id, j.revision, j.kind, j.status, j.attempts, j.available_at, j.lease_owner, j.lease_until, j.created_at, j.last_error]);
  }
  async leaseNextJob(now: string, leaseMs: number, owner: string) {
    const r = await this.q(
      `UPDATE jobs SET status='leased', lease_owner=$2, lease_until=$1::timestamptz + ($3::text || ' milliseconds')::interval, attempts=attempts+1
       WHERE job_id = (
         SELECT job_id FROM jobs
         WHERE (status='pending' AND available_at <= $1) OR (status='leased' AND lease_until <= $1)
         ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [now, owner, String(leaseMs)],
    );
    return r.rows[0] ? this.rowToJob(r.rows[0]) : null;
  }
  async getJob(id: string) {
    const r = await this.q('SELECT * FROM jobs WHERE job_id=$1', [id]);
    return r.rows[0] ? this.rowToJob(r.rows[0]) : null;
  }
  async completeJob(id: string, owner: string, status: 'done' | 'dead', error: string | null = null) {
    const r = await this.q("UPDATE jobs SET status=$3, last_error=$4, lease_until=NULL WHERE job_id=$1 AND lease_owner=$2 AND status='leased'", [id, owner, status, error]);
    return r.rowCount === 1;
  }
  async releaseJob(id: string, owner: string, availableAt: string, error: string | null) {
    const r = await this.q("UPDATE jobs SET status='pending', available_at=$3, lease_owner=NULL, lease_until=NULL, last_error=$4 WHERE job_id=$1 AND lease_owner=$2 AND status='leased'", [id, owner, availableAt, error]);
    return r.rowCount === 1;
  }
  async countJobs(t: string, statuses: JobRecord['status'][]) {
    const r = await this.q('SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND status = ANY($2)', [t, statuses]);
    return r.rows[0].n as number;
  }

  async lockBudgetScope(t: string, a: string) {
    if (!this.client) throw new Error('lockBudgetScope requires a transaction');
    await this.q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`budget:${t}:${a}`]);
  }
  async insertReservation(r: ReservationRecord) {
    await this.q('INSERT INTO reservations (reservation_id, tenant_id, ad_account_id, proposal_id, revision, daily_minor, lifetime_minor, currency, status, created_at, released_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [r.reservation_id, r.tenant_id, r.ad_account_id, r.proposal_id, r.revision, r.daily_minor, r.lifetime_minor, r.currency, r.status, r.created_at, r.released_at]);
  }
  async sumActiveReservations(t: string, a: string, exclude?: { proposal_id: string; revision: number }) {
    const r = await this.q(
      `SELECT COALESCE(sum(daily_minor),0)::bigint AS d, COALESCE(sum(lifetime_minor),0)::bigint AS l FROM reservations
       WHERE tenant_id=$1 AND ad_account_id=$2 AND status='active' AND NOT (proposal_id IS NOT DISTINCT FROM $3::text AND revision IS NOT DISTINCT FROM $4::int)`,
      [t, a, exclude?.proposal_id ?? null, exclude?.revision ?? null],
    );
    return { daily_minor: r.rows[0].d as number, lifetime_minor: r.rows[0].l as number };
  }
  async releaseReservations(t: string, id: string, rev: number, at: string) {
    await this.q("UPDATE reservations SET status='released', released_at=$4 WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3 AND status='active'", [t, id, rev, at]);
  }
  async listReservations(t: string, id: string, rev: number) {
    const r = await this.q('SELECT * FROM reservations WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3', [t, id, rev]);
    return r.rows.map((x) => ({ ...x, created_at: iso(x.created_at)!, released_at: iso(x.released_at), currency: String(x.currency) }) as ReservationRecord);
  }

  async acquireLock(scope: string, holder: string, now: string, ttlMs: number): Promise<LockGrant | null> {
    const expires = new Date(Date.parse(now) + ttlMs).toISOString();
    const r = await this.q(
      `INSERT INTO locks (scope, holder, token, expires_at) VALUES ($1,$2,1,$4)
       ON CONFLICT (scope) DO UPDATE SET holder=EXCLUDED.holder, token=locks.token+1, expires_at=EXCLUDED.expires_at
       WHERE locks.expires_at <= $3 OR locks.holder = $2
       RETURNING token`,
      [scope, holder, now, expires],
    );
    return r.rows[0] ? { scope, holder, token: r.rows[0].token as number, expires_at: expires } : null;
  }
  async isFenceValid(scope: string, token: number, now: string) {
    const r = await this.q('SELECT 1 FROM locks WHERE scope=$1 AND token=$2 AND expires_at > $3', [scope, token, now]);
    return r.rowCount === 1;
  }
  async releaseLock(scope: string, holder: string, token: number) {
    await this.q("UPDATE locks SET expires_at='epoch' WHERE scope=$1 AND holder=$2 AND token=$3", [scope, holder, token]);
  }

  async getAttemptByKey(t: string, k: string) {
    const r = await this.q('SELECT data FROM execution_attempts WHERE tenant_id=$1 AND idempotency_key=$2', [t, k]);
    return (r.rows[0]?.data as ExecutionAttempt) ?? null;
  }
  async insertAttempt(a: ExecutionAttempt, fence: { scope: string; now: string } | null) {
    if (fence && !(await this.isFenceValid(fence.scope, a.fencing_token, fence.now))) {
      throw new DomainError('REMOTE_UNKNOWN', 'Fencing token đã cũ: worker khác đang giữ khóa');
    }
    try {
      await this.q('INSERT INTO execution_attempts (attempt_id, tenant_id, proposal_id, revision, action_id, idempotency_key, status, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [a.attempt_id, a.tenant_id, a.proposal_id, a.revision, a.action_id, a.idempotency_key, a.status, a]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DomainError('INPUT_INVALID', 'Idempotency key đã tồn tại');
      throw e;
    }
  }
  async updateAttempt(a: ExecutionAttempt, fence: { scope: string; now: string } | null) {
    if (fence && !(await this.isFenceValid(fence.scope, a.fencing_token, fence.now))) {
      throw new DomainError('REMOTE_UNKNOWN', 'Fencing token đã cũ: worker khác đang giữ khóa');
    }
    const r = await this.q('UPDATE execution_attempts SET status=$3, data=$4 WHERE tenant_id=$1 AND attempt_id=$2', [a.tenant_id, a.attempt_id, a.status, a]);
    if (r.rowCount !== 1) throw new DomainError('INPUT_INVALID', 'Attempt không tồn tại');
  }
  async listAttempts(t: string, id: string, rev: number) {
    const r = await this.q('SELECT data FROM execution_attempts WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3 ORDER BY seq', [t, id, rev]);
    return r.rows.map((x) => x.data as ExecutionAttempt);
  }

  async putLocalRef(t: string, id: string, rev: number, ref: string, remote: string) {
    await this.q('INSERT INTO local_refs (tenant_id, proposal_id, revision, local_ref, remote_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [t, id, rev, ref, remote]);
  }
  async getLocalRefs(t: string, id: string, rev: number) {
    const r = await this.q('SELECT local_ref, remote_id FROM local_refs WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3', [t, id, rev]);
    return Object.fromEntries(r.rows.map((x) => [x.local_ref as string, x.remote_id as string]));
  }

  async putReceipt(rc: ExecutionReceipt) {
    await this.q('INSERT INTO receipts (tenant_id, proposal_id, revision, data) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, proposal_id, revision) DO UPDATE SET data=EXCLUDED.data', [rc.tenant_id, rc.proposal_id, rc.revision, rc]);
  }
  async getReceipt(t: string, id: string, rev: number) {
    const r = await this.q('SELECT data FROM receipts WHERE tenant_id=$1 AND proposal_id=$2 AND revision=$3', [t, id, rev]);
    return (r.rows[0]?.data as ExecutionReceipt) ?? null;
  }

  async appendAudit(e: AuditInput): Promise<AuditEvent> {
    return this.tx(async (s) => {
      const self = s as PgStore;
      await self.q('INSERT INTO audit_heads (tenant_id, sequence, event_hash) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING', [e.tenant_id, GENESIS_HASH]);
      const head = await self.q('SELECT sequence, event_hash FROM audit_heads WHERE tenant_id=$1 FOR UPDATE', [e.tenant_id]);
      const base = { ...e, sequence: Number(head.rows[0].sequence) + 1, prev_hash: String(head.rows[0].event_hash) };
      const event: AuditEvent = { ...base, event_hash: auditEventHash(base) };
      await self.q('INSERT INTO audit_events (tenant_id, sequence, correlation_id, event_hash, data) VALUES ($1,$2,$3,$4,$5)', [e.tenant_id, event.sequence, e.correlation_id, event.event_hash, event]);
      await self.q('UPDATE audit_heads SET sequence=$2, event_hash=$3 WHERE tenant_id=$1', [e.tenant_id, event.sequence, event.event_hash]);
      return event;
    });
  }
  async listAudit(t: string, f: { correlation_id?: string; limit?: number } = {}) {
    const r = await this.q(
      `SELECT data FROM (SELECT data, sequence FROM audit_events WHERE tenant_id=$1 AND ($2::text IS NULL OR correlation_id=$2) ORDER BY sequence DESC LIMIT $3) x ORDER BY sequence`,
      [t, f.correlation_id ?? null, f.limit ?? 100000],
    );
    return r.rows.map((x) => x.data as AuditEvent);
  }

  async getFreeze(t: string) {
    const r = await this.q('SELECT data FROM freeze_state WHERE tenant_id=$1', [t]);
    return (r.rows[0]?.data as FreezeState) ?? { ...UNFROZEN };
  }
  async setFreeze(t: string, s: FreezeState) {
    await this.q('INSERT INTO freeze_state (tenant_id, data) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET data=EXCLUDED.data', [t, s]);
  }
  async insertIncident(i: Incident) {
    await this.q('INSERT INTO incidents (tenant_id, incident_id, data) VALUES ($1,$2,$3)', [i.tenant_id, i.incident_id, i]);
  }
  async updateIncident(i: Incident) {
    const r = await this.q('UPDATE incidents SET data=$3 WHERE tenant_id=$1 AND incident_id=$2', [i.tenant_id, i.incident_id, i]);
    if (r.rowCount !== 1) throw new DomainError('INPUT_INVALID', 'Incident không tồn tại');
  }
  async listIncidents(t: string) {
    const r = await this.q('SELECT data FROM incidents WHERE tenant_id=$1 ORDER BY seq', [t]);
    return r.rows.map((x) => x.data as Incident);
  }
  async getIncident(t: string, id: string) {
    const r = await this.q('SELECT data FROM incidents WHERE tenant_id=$1 AND incident_id=$2', [t, id]);
    return (r.rows[0]?.data as Incident) ?? null;
  }

  async putSnapshot(s: DataSnapshot) {
    await this.q('INSERT INTO snapshots (tenant_id, snapshot_id, data) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, snapshot_id) DO UPDATE SET data=EXCLUDED.data', [s.tenant_id, s.snapshot_id, s]);
  }
  async getSnapshots(t: string, ids: string[]) {
    const r = await this.q('SELECT data FROM snapshots WHERE tenant_id=$1 AND snapshot_id = ANY($2)', [t, ids]);
    return r.rows.map((x) => x.data as DataSnapshot);
  }
  async listSnapshots(t: string) {
    const r = await this.q('SELECT data FROM snapshots WHERE tenant_id=$1 ORDER BY snapshot_id', [t]);
    return r.rows.map((x) => x.data as DataSnapshot);
  }
  async putReview(rv: ReviewRecord) {
    await this.q('INSERT INTO creative_reviews (tenant_id, review_id, data) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, review_id) DO UPDATE SET data=EXCLUDED.data', [rv.tenant_id, rv.review_id, rv]);
  }
  async getReviews(t: string, ids: string[]) {
    const r = await this.q('SELECT data FROM creative_reviews WHERE tenant_id=$1 AND review_id = ANY($2)', [t, ids]);
    return r.rows.map((x) => x.data as ReviewRecord);
  }
  async putAsset(a: AssetRecord) {
    await this.q('INSERT INTO creative_assets (tenant_id, asset_id, data) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, asset_id) DO UPDATE SET data=EXCLUDED.data', [a.tenant_id, a.asset_id, a]);
  }
  async getAssets(t: string, ids: string[]) {
    const r = await this.q('SELECT data FROM creative_assets WHERE tenant_id=$1 AND asset_id = ANY($2)', [t, ids]);
    return r.rows.map((x) => x.data as AssetRecord);
  }

  async recordEntityChange(c: EntityChange) {
    await this.q('INSERT INTO entity_changes (tenant_id, ad_account_id, entity_id, proposal_id, changed_at) VALUES ($1,$2,$3,$4,$5)', [c.tenant_id, c.ad_account_id, c.entity_id, c.proposal_id, c.changed_at]);
  }
  async lastEntityChanges(t: string, a: string) {
    const r = await this.q('SELECT entity_id, max(changed_at) AS at FROM entity_changes WHERE tenant_id=$1 AND ad_account_id=$2 GROUP BY entity_id', [t, a]);
    return new Map(r.rows.map((x) => [x.entity_id as string, iso(x.at)!]));
  }
  async addVerifiedEntity(v: VerifiedEntity) {
    await this.q('INSERT INTO verified_entities (tenant_id, ad_account_id, entity_id, proposal_id, verified_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [v.tenant_id, v.ad_account_id, v.entity_id, v.proposal_id, v.verified_at]);
  }
  async listVerifiedEntities(t: string, a: string) {
    const r = await this.q('SELECT entity_id FROM verified_entities WHERE tenant_id=$1 AND ad_account_id=$2', [t, a]);
    return new Set(r.rows.map((x) => x.entity_id as string));
  }

  async putSession(s: SessionRecord) {
    await this.q('INSERT INTO sessions (token_hash, tenant_id, principal, expires_at) VALUES ($1,$2,$3,$4)', [s.token_hash, s.principal.tenant_id, s.principal, s.expires_at]);
  }
  async getSession(h: string) {
    const r = await this.q('SELECT principal, expires_at FROM sessions WHERE token_hash=$1', [h]);
    return r.rows[0] ? { token_hash: h, principal: r.rows[0].principal, expires_at: iso(r.rows[0].expires_at)! } : null;
  }
}

/** CLI helper for `pnpm db:migrate`: open a short-lived pool, migrate, close. */
export async function migrateDatabase(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    return await migrate(pool);
  } finally {
    await pool.end();
  }
}
