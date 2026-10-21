import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { DomainError, compileToolSchema, defRef, isDomainError, issuesOf, type Action, type BusinessConfig, type ErrorCode } from '@pod/contracts';
import { remoteFingerprint } from '@pod/policy';
import { MockAnalyst, ToolExecutor, TOOLS } from '@pod/adapter-claude';
import type { FaultKind } from '@pod/adapter-meta';
import {
  DEMO,
  ManualClock,
  RUNNING_ADS_NOTE,
  claudeRuntimePrincipal,
  createSession,
  demoPrincipals,
  resolveSession,
  type Principal,
  type SignalKind,
  type System,
} from '@pod/domain';

const STATUS: Partial<Record<ErrorCode, number>> = {
  INPUT_INVALID: 400,
  PERMISSION_DENIED: 403,
  TENANT_MISMATCH: 403,
  APPROVAL_REQUIRED: 409,
  APPROVAL_EXPIRED: 409,
  PAYLOAD_CHANGED: 409,
  REMOTE_DRIFT: 409,
  WRITE_FROZEN: 423,
  RATE_LIMITED: 429,
};

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type AppOptions = {
  sys: System;
  webOrigin?: string;
  /** Mock-only conveniences: demo login, mock analyst, fault injection, in-process worker drain. */
  mockTools?: boolean;
};

const body = (properties: Record<string, unknown>, optional: string[] = []) =>
  compileToolSchema({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) });

const V = {
  login: body({ actor_id: defRef('Id') }),
  propose: body(
    {
      ad_account_id: defRef('Id'),
      proposal_id: { anyOf: [defRef('Id'), { type: 'null' }] },
      actions: { type: 'array', minItems: 1, maxItems: 50, items: defRef('Action') },
      reason: { type: 'string', minLength: 1, maxLength: 2000 },
      rollback_plan: { type: 'string', minLength: 1, maxLength: 2000 },
      source_snapshot_ids: { type: 'array', items: defRef('Id') },
    },
    ['proposal_id'],
  ),
  decision: body({ decision: { enum: ['approved', 'rejected'] }, expected_payload_hash: defRef('Sha256'), comment: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] } }, ['comment']),
  execute: body({ expected_payload_hash: defRef('Sha256') }),
  reason: body({ reason: { type: 'string', minLength: 1, maxLength: 1000 }, acknowledge_unresolved: { type: 'boolean' } }, ['acknowledge_unresolved']),
  incident: body({ kind: { enum: ['connector_error', 'data_stale', 'permission_lost', 'spend_anomaly', 'unknown_mutation', 'audit_unavailable', 'other'] }, detail: { type: 'string', maxLength: 1000 }, request_freeze: { type: 'boolean' } }),
  resolve: body({ resolution: { type: 'string', minLength: 1, maxLength: 2000 } }),
  configDraft: body({ config_draft: defRef('BusinessConfig') }),
  configConfirm: body({ ad_account_id: defRef('Id'), version: { type: 'string', minLength: 1, maxLength: 64 } }),
  analyst: body({ entity_id: defRef('Id'), new_daily_budget_minor: defRef('NonNegMinor'), source_snapshot_ids: { type: 'array', items: defRef('Id') }, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, ['source_snapshot_ids', 'reason']),
  advance: body({ ms: { type: 'integer', minimum: 1, maximum: 7 * 86_400_000 } }),
  fault: body({ op: { enum: ['create', 'update', 'read'] }, fault: { enum: ['rate_limit', 'auth_error', 'validation_error', 'timeout_before_commit', 'timeout_after_commit', 'duplicate_commit', 'not_found'] }, times: { type: 'integer', minimum: 1, maximum: 10 } }, ['times']),
};

function parse<T>(v: ReturnType<typeof compileToolSchema>, value: unknown): T {
  if (!v(value)) throw new DomainError('INPUT_INVALID', issuesOf(v).map((i) => `${i.path} ${i.message}`).join('; '));
  return value as T;
}

function requireHuman(req: FastifyRequest): Principal {
  if (!req.principal) throw new DomainError('PERMISSION_DENIED', 'Chưa đăng nhập');
  return req.principal;
}

const revParam = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new DomainError('INPUT_INVALID', 'revision không hợp lệ');
  return n;
};

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { sys } = opts;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  await app.register(cors, { origin: opts.webOrigin ?? 'http://localhost:3000', credentials: false });
  const tools = new ToolExecutor(sys);
  const mockTools = opts.mockTools === true && sys.deps.runtime.mode === 'mock';

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    req.principal = await resolveSession(sys.deps.store, sys.deps.clock, token);
  });

  app.setErrorHandler((err: unknown, _req, reply: FastifyReply) => {
    if (isDomainError(err)) return reply.status(STATUS[err.code] ?? 422).send({ error: err.toJSON() });
    const e = err as { statusCode?: number; validation?: unknown };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'INPUT_INVALID', message: 'Request không hợp lệ', retryable: false } });
    // Never echo internal messages: they could carry upstream data.
    return reply.status(500).send({ error: { code: 'INPUT_INVALID', message: 'Lỗi nội bộ', retryable: false } });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ---- Auth (mock only). Production auth is an external IdP; see docs/adr/0003.
  app.get('/api/auth/demo-users', async () => {
    if (!mockTools) throw new DomainError('CAPABILITY_UNSUPPORTED', 'Demo login chỉ có ở mock mode');
    return Object.values(demoPrincipals()).map((p) => ({ actor_id: p.actor_id, display_name: p.display_name, tenant_id: p.tenant_id, roles: p.grants.map((g) => g.role) }));
  });
  app.post('/api/auth/mock-login', async (req) => {
    if (!mockTools) throw new DomainError('CAPABILITY_UNSUPPORTED', 'Demo login chỉ có ở mock mode');
    const { actor_id } = parse<{ actor_id: string }>(V.login, req.body);
    const principal = demoPrincipals()[actor_id];
    if (!principal) throw new DomainError('PERMISSION_DENIED', 'Người dùng demo không tồn tại');
    return { token: await createSession(sys.deps.store, sys.deps.clock, principal), principal };
  });
  app.get('/api/me', async (req) => requireHuman(req));

  app.get('/api/status', async (req) => {
    const p = requireHuman(req);
    const freeze = await sys.ops.getFreeze(p);
    return {
      mode: sys.deps.runtime.mode,
      live_writes_enabled: sys.deps.runtime.liveWritesEnabled,
      meta_adapter: sys.deps.metaRead.kind,
      tenant_id: p.tenant_id,
      freeze,
      running_ads_note: RUNNING_ADS_NOTE,
      mock_tools: mockTools,
    };
  });

  app.get('/api/dashboard', async (req) => {
    const p = requireHuman(req);
    const account = (req.query as { account?: string }).account ?? (p.tenant_id === DEMO.tenant_id ? DEMO.ad_account_id : DEMO.other_ad_account_id);
    const cfg = await sys.config.get(p, account);
    const [snapshots, entities, health] = await Promise.all([sys.deps.store.listSnapshots(p.tenant_id), sys.deps.metaRead.listEntities(account), sys.ops.health(p).catch(() => null)]);
    return {
      ad_account_id: account,
      config: cfg && {
        version: cfg.version,
        status: cfg.status,
        account_currency: cfg.account_currency,
        store_currency: cfg.store_currency,
        reporting_timezone: cfg.reporting_timezone,
        account_timezone: cfg.account_timezone,
        caps: cfg.caps,
        max_change_pct: cfg.max_change_pct,
        max_change_amount_minor: cfg.max_change_amount_minor,
        cooldown_seconds: cfg.cooldown_seconds,
        approval_ttl_seconds: cfg.approval_ttl_seconds,
        confirmed_by: cfg.confirmed_by,
      },
      snapshots,
      remote: {
        source: sys.deps.metaRead.kind === 'mock' ? 'mock_simulator' : 'meta',
        fetched_at: sys.deps.clock.now().toISOString(),
        entities: entities.map((e) => ({ ...e, remote_fingerprint: remoteFingerprint(e) })),
      },
      health,
    };
  });

  // ---- Config (S01)
  app.get('/api/config', async (req) => {
    const p = requireHuman(req);
    const account = (req.query as { account?: string }).account ?? DEMO.ad_account_id;
    return { versions: await sys.config.listVersions(p, account) };
  });
  app.post('/api/config/draft', async (req) => {
    const p = requireHuman(req);
    const { config_draft } = parse<{ config_draft: BusinessConfig }>(V.configDraft, req.body);
    return sys.config.saveDraft(p, config_draft);
  });
  app.post('/api/config/confirm', async (req) => {
    const p = requireHuman(req);
    const b = parse<{ ad_account_id: string; version: string }>(V.configConfirm, req.body);
    return sys.config.confirm(p, b.ad_account_id, b.version);
  });

  // ---- Proposals / approval / execution (S17)
  app.get('/api/proposals', async (req) => ({ proposals: await sys.proposals.list(requireHuman(req)) }));
  app.get('/api/proposals/:id', async (req) => {
    const p = requireHuman(req);
    const { id } = req.params as { id: string };
    const rev = (req.query as { revision?: string }).revision;
    const r = await sys.proposals.get(p, id, rev ? revParam(rev) : undefined);
    if (!r) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
    const { proposal } = r;
    const [approvals, receipt, attempts, auditTrail, reservations] = await Promise.all([
      sys.deps.store.listApprovals(p.tenant_id, id, proposal.revision),
      sys.deps.store.getReceipt(p.tenant_id, id, proposal.revision),
      sys.deps.store.listAttempts(p.tenant_id, id, proposal.revision),
      sys.deps.store.listAudit(p.tenant_id, { correlation_id: id }),
      sys.deps.store.listReservations(p.tenant_id, id, proposal.revision),
    ]);
    return {
      ...r,
      approvals: approvals.map(({ signature: _s, ...a }) => a),
      receipt,
      attempts: attempts.map(({ idempotency_key, ...a }) => ({ ...a, idempotency_tag: idempotency_key.slice(0, 16) })),
      audit: auditTrail,
      reservations,
      now: sys.deps.clock.now().toISOString(),
    };
  });
  app.post('/api/proposals', async (req) => {
    const p = requireHuman(req);
    const b = parse<{ ad_account_id: string; proposal_id?: string | null; actions: Action[]; reason: string; rollback_plan: string; source_snapshot_ids: string[] }>(V.propose, req.body);
    const cfg = await sys.deps.store.getLatestConfig(p.tenant_id, b.ad_account_id);
    return sys.proposals.propose(p, { ...b, store_id: cfg?.store_id ?? 'unknown_store' });
  });
  app.post('/api/proposals/:id/revisions/:rev/decision', async (req) => {
    const p = requireHuman(req);
    const { id, rev } = req.params as { id: string; rev: string };
    const b = parse<{ decision: 'approved' | 'rejected'; expected_payload_hash: string; comment?: string | null }>(V.decision, req.body);
    const rec = await sys.approvals.decide(p, id, revParam(rev), b.expected_payload_hash, b.decision, b.comment ?? null);
    const { signature: _s, ...rest } = rec;
    return rest;
  });
  app.post('/api/proposals/:id/revisions/:rev/execute', async (req) => {
    const p = requireHuman(req);
    const { id, rev } = req.params as { id: string; rev: string };
    const b = parse<{ expected_payload_hash: string }>(V.execute, req.body);
    return sys.execution.request(p, id, revParam(rev), b.expected_payload_hash);
  });
  app.post('/api/proposals/:id/revisions/:rev/cancel', async (req) => {
    const p = requireHuman(req);
    const { id, rev } = req.params as { id: string; rev: string };
    await sys.proposals.cancel(p, id, revParam(rev));
    return { ok: true };
  });
  app.post('/api/proposals/:id/revisions/:rev/reconcile', async (req) => {
    const p = requireHuman(req);
    const { id, rev } = req.params as { id: string; rev: string };
    return sys.execution.requestReconcile(p, id, revParam(rev));
  });

  app.get('/api/audit', async (req) => {
    const p = requireHuman(req);
    if (!p.grants.some((g) => ['analyst', 'approver', 'operator', 'owner'].includes(g.role))) throw new DomainError('PERMISSION_DENIED', 'Không có quyền xem audit');
    return { events: await sys.deps.store.listAudit(p.tenant_id, { limit: 200 }) };
  });

  // ---- Ops (S18)
  app.get('/api/ops/health', async (req) => sys.ops.health(requireHuman(req)));
  app.post('/api/ops/freeze', async (req) => {
    const b = parse<{ reason: string }>(V.reason, req.body);
    return { freeze: await sys.ops.freeze(requireHuman(req), b.reason), running_ads_note: RUNNING_ADS_NOTE };
  });
  app.post('/api/ops/unfreeze', async (req) => {
    const b = parse<{ reason: string; acknowledge_unresolved?: boolean }>(V.reason, req.body);
    return { freeze: await sys.ops.unfreeze(requireHuman(req), b.reason, b.acknowledge_unresolved ?? false), running_ads_note: RUNNING_ADS_NOTE };
  });
  app.get('/api/ops/incidents', async (req) => ({ incidents: await sys.ops.listIncidents(requireHuman(req)) }));
  app.post('/api/ops/incidents', async (req) => {
    const p = requireHuman(req);
    const b = parse<{ kind: SignalKind; detail: string; request_freeze: boolean }>(V.incident, req.body);
    return sys.ops.createIncident(p, b.kind, b.detail, [], b.request_freeze);
  });
  app.post('/api/ops/incidents/:id/resolve', async (req) => {
    const b = parse<{ resolution: string }>(V.resolve, req.body);
    return sys.ops.resolveIncident(requireHuman(req), (req.params as { id: string }).id, b.resolution);
  });

  app.get('/api/tools', async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, status: t.status, phase: t.phase, llm_exposed: t.llm_exposed, side_effect: t.side_effect, permission: t.permission })),
  }));

  // ---- Mock-only helpers
  if (mockTools) {
    app.post('/api/mock/analyst/draft', async (req) => {
      const p = requireHuman(req);
      const b = parse<{ entity_id: string; new_daily_budget_minor: number; source_snapshot_ids?: string[]; reason?: string }>(V.analyst, req.body);
      const account = p.tenant_id === DEMO.tenant_id ? DEMO.ad_account_id : DEMO.other_ad_account_id;
      // The analyst runs as the server-built Claude principal, not as the human who clicked.
      const analyst = new MockAnalyst(tools, claudeRuntimePrincipal(p.tenant_id, [account]));
      return analyst.draftDailyBudgetChange(account, b.entity_id, b.new_daily_budget_minor, b.source_snapshot_ids ?? ['snapshot_demo'], b.reason ?? 'Mock analyst: CPA fixture dưới target 7 ngày; đề xuất tăng thử (dữ liệu mô phỏng).');
    });
    app.post('/api/mock/worker/drain', async (req) => {
      requireHuman(req);
      if (!sys.worker) throw new DomainError('CAPABILITY_UNSUPPORTED', 'Process này không chạy worker');
      return { processed: await sys.worker.drain(20) };
    });
    app.post('/api/mock/meta/fault', async (req) => {
      const p = requireHuman(req);
      if (!p.grants.some((g) => g.role === 'operator' || g.role === 'owner')) throw new DomainError('PERMISSION_DENIED', 'Chỉ operator/owner mô phỏng lỗi');
      const b = parse<{ op: 'create' | 'update' | 'read'; fault: FaultKind; times?: number }>(V.fault, req.body);
      sys.fakeMeta?.inject({ op: b.op, fault: b.fault, times: b.times ?? 1 });
      return { injected: b };
    });
    // Only when the demo runs on a fixed ManualClock (DEMO_FIXED_CLOCK): lets UI tests reach expiry deterministically.
    if (sys.deps.clock instanceof ManualClock) {
      const clock = sys.deps.clock;
      app.post('/api/mock/clock/advance', async (req) => {
        requireHuman(req);
        const b = parse<{ ms: number }>(V.advance, req.body);
        clock.advance(b.ms);
        return { now: clock.now().toISOString() };
      });
    }
  }

  return app;
}
