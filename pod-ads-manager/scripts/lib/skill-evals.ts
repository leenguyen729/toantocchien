import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Action, DataSnapshot } from '@pod/contracts';
import { remoteFingerprint } from '@pod/policy';
import { ToolExecutor, type ToolResult } from '@pod/adapter-claude';
import type { FaultRule } from '@pod/adapter-meta';
import { DEMO, ManualClock, MemoryStore, claudeRuntimePrincipal, createSystem, loadRuntimeConfig, seedDemo, type Principal, type SeedOptions, type System } from '@pod/domain';

/**
 * Deterministic skill evals. They drive the same ToolExecutor the Claude
 * runtime uses, with the same server-built principals, against fixtures and
 * the fake Meta simulator. No model is called and nothing leaves the process:
 * they prove the guardrails a skill relies on, not the quality of model prose.
 */

export const COMMON_CATEGORIES = ['success', 'missing_data', 'conflicting_data', 'stale_data', 'prompt_injection', 'wrong_tenant_permission'] as const;
export type Category = (typeof COMMON_CATEGORIES)[number] | 'specific';

type Expectation =
  | { path: string; equals: unknown }
  | { path: string; contains: unknown }
  | { path: string; matches: string }
  | { path: string; exists: boolean };

type Step =
  | { as: string; tool: string; input: unknown; save?: string; expect?: Expectation[] }
  | { do: 'approve' | 'reject'; as: string; proposal: string; expect_error?: string }
  | { do: 'drain' }
  | { do: 'advance'; ms: number }
  | { do: 'fault'; rule: Omit<FaultRule, 'match'> }
  | { do: 'external_edit'; entity_id: string; patch: Record<string, unknown> }
  | { do: 'stale_snapshots' }
  | { do: 'audit_unavailable' };

export type EvalCase = {
  id: string;
  category: Category;
  description: string;
  critical: boolean;
  setup?: { confirm_config?: boolean; config_overrides?: SeedOptions['configOverrides'] };
  steps: Step[];
  final?: { outbound_writes?: number; committed_writes?: number; proposal?: { ref: string; status: string }; frozen?: boolean; audit_chain_ok?: boolean; audit_events_min?: { event_type: string; count: number }[] };
};

export type EvalFile = { skill: string; skill_version: string; cases: EvalCase[] };
export type CaseResult = { id: string; category: Category; critical: boolean; passed: boolean; failures: string[] };
export type SkillResult = { skill: string; skill_version: string; fixture_hash: string; cases: CaseResult[] };

const PRINCIPALS = (sys: System, people: Record<string, Principal>) => (name: string): Principal => {
  if (name === 'claude') return claudeRuntimePrincipal(DEMO.tenant_id, [DEMO.ad_account_id]);
  if (name === 'claude_other_tenant') return claudeRuntimePrincipal(DEMO.other_tenant_id, [DEMO.other_ad_account_id]);
  const p = people[name];
  if (!p) throw new Error(`Không có principal ${name}`);
  void sys;
  return p;
};

function get(obj: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((o, k) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[k]), obj);
}

async function resolve(v: unknown, saved: Map<string, ToolResult>, sys: System): Promise<unknown> {
  if (typeof v === 'string' && v.startsWith('$')) {
    const [name, ...rest] = v.slice(1).split('.');
    const r = saved.get(name!);
    if (!r) throw new Error(`Biến ${name} chưa có`);
    return get(r, rest.join('.'));
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => resolve(x, saved, sys)));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Macro: deep-merge a patch over a resolved value (e.g. tweak the config just read).
    if ('$merge' in o) {
      const [base, patch] = (await resolve(o.$merge, saved, sys)) as [unknown, unknown];
      return deepMerge(base, patch);
    }
    // Macro: build an allowlisted budget/status action from the CURRENT remote state, like the model would after meta.structure.read.
    if ('$budget_action' in o) {
      const m = o.$budget_action as { action_id?: string; entity_id: string; after: number; before_override?: number };
      const e = await sys.deps.metaRead.getEntity(DEMO.ad_account_id, m.entity_id);
      if (!e) throw new Error(`Không có entity ${m.entity_id}`);
      const a: Action = {
        action_id: m.action_id ?? 'a1',
        kind: 'SET_DAILY_BUDGET',
        entity_type: e.entity_type as 'campaign' | 'adset',
        entity_id: e.entity_id,
        before: { amount_minor: m.before_override ?? e.daily_budget_minor!, currency: e.currency },
        after: { amount_minor: m.after, currency: e.currency },
        depends_on: [],
        preconditions: { status: e.status, remote_fingerprint: remoteFingerprint(e) },
      };
      return a;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = await resolve(x, saved, sys);
    return out;
  }
  return v;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !base || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, x] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], x);
  return out;
}

function check(e: Expectation, r: unknown): string | null {
  const actual = get(r, e.path);
  if ('equals' in e) return JSON.stringify(actual) === JSON.stringify(e.equals) ? null : `${e.path}: muốn ${JSON.stringify(e.equals)}, nhận ${JSON.stringify(actual)}`;
  if ('contains' in e) {
    const ok = Array.isArray(actual) ? actual.some((x) => JSON.stringify(x) === JSON.stringify(e.contains) || (typeof x === 'object' && x !== null && Object.values(x).includes(e.contains))) : typeof actual === 'string' && actual.includes(String(e.contains));
    return ok ? null : `${e.path}: không chứa ${JSON.stringify(e.contains)} (nhận ${JSON.stringify(actual)?.slice(0, 200)})`;
  }
  if ('matches' in e) return typeof actual === 'string' && new RegExp(e.matches).test(actual) ? null : `${e.path}: không khớp /${e.matches}/ (nhận ${JSON.stringify(actual)?.slice(0, 200)})`;
  return (actual !== undefined && actual !== null) === e.exists ? null : `${e.path}: exists=${String(e.exists)} sai`;
}

export async function runCase(c: EvalCase): Promise<CaseResult> {
  const failures: string[] = [];
  const clock = new ManualClock('2026-10-21T03:00:00Z');
  const store = new MemoryStore();
  const sys = createSystem({ store, clock, runtime: loadRuntimeConfig({ EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false' }), role: 'all-in-one' });
  let people: Record<string, Principal>;
  try {
    people = await seedDemo(sys, { confirmConfig: c.setup?.confirm_config, configOverrides: c.setup?.config_overrides });
  } catch (err) {
    return { id: c.id, category: c.category, critical: c.critical, passed: false, failures: [`setup lỗi: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const who = PRINCIPALS(sys, people);
  const tools = new ToolExecutor(sys);
  const saved = new Map<string, ToolResult>();
  const meta = sys.fakeMeta!;
  try {
    for (const [i, s] of c.steps.entries()) {
      if ('tool' in s) {
        const input = await resolve(s.input, saved, sys);
        const r = await tools.call(s.tool, input, who(s.as), { maxToolCalls: 50, used: 0 });
        if (s.save) saved.set(s.save, r);
        for (const e of s.expect ?? []) {
          const f = check((await resolve(e, saved, sys)) as Expectation, r);
          if (f) failures.push(`bước ${i + 1} (${s.tool}): ${f}`);
        }
        continue;
      }
      switch (s.do) {
        case 'approve':
        case 'reject': {
          const pr = saved.get(s.proposal)?.data as { proposal_id: string; revision: number; payload_hash: string } | undefined;
          if (!pr) throw new Error(`Không có proposal ${s.proposal}`);
          try {
            await sys.approvals.decide(who(s.as), pr.proposal_id, pr.revision, pr.payload_hash, s.do === 'approve' ? 'approved' : 'rejected', null);
            if (s.expect_error) failures.push(`bước ${i + 1}: mong lỗi ${s.expect_error} nhưng duyệt thành công`);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (!s.expect_error) failures.push(`bước ${i + 1}: duyệt lỗi ${code ?? String(err)}`);
            else if (code !== s.expect_error) failures.push(`bước ${i + 1}: mong ${s.expect_error}, nhận ${code}`);
          }
          break;
        }
        case 'drain':
          await sys.worker!.drain();
          break;
        case 'advance':
          clock.advance(s.ms);
          break;
        case 'fault':
          meta.inject(s.rule as FaultRule);
          break;
        case 'external_edit':
          meta.externalEdit(DEMO.ad_account_id, s.entity_id, s.patch);
          break;
        case 'stale_snapshots': {
          const old = new Date(clock.now().getTime() - 3 * 86_400_000).toISOString();
          for (const snap of await store.getSnapshots(DEMO.tenant_id, ['snapshot_demo', 'snapshot_incomplete'])) await store.putSnapshot({ ...(snap as DataSnapshot), fetched_at: old });
          break;
        }
        case 'audit_unavailable':
          store.setAuditAvailable(false);
          break;
      }
    }
    const f = c.final;
    if (f?.outbound_writes !== undefined && meta.outboundWrites.length !== f.outbound_writes) failures.push(`outbound writes: muốn ${f.outbound_writes}, nhận ${meta.outboundWrites.length}`);
    if (f?.committed_writes !== undefined) {
      const n = meta.outboundWrites.filter((w) => w.committed).length;
      if (n !== f.committed_writes) failures.push(`committed writes: muốn ${f.committed_writes}, nhận ${n}`);
    }
    if (f?.proposal) {
      const pr = saved.get(f.proposal.ref)?.data as { proposal_id: string; revision: number } | undefined;
      const p = pr ? await store.getProposal(DEMO.tenant_id, pr.proposal_id, pr.revision) : null;
      if (p?.status !== f.proposal.status) failures.push(`proposal status: muốn ${f.proposal.status}, nhận ${p?.status ?? 'không có'}`);
    }
    store.setAuditAvailable(true);
    if (f?.frozen !== undefined && (await store.getFreeze(DEMO.tenant_id)).frozen !== f.frozen) failures.push(`frozen: muốn ${String(f.frozen)}`);
    const { verifyAuditChain } = await import('@pod/domain');
    const audit = await store.listAudit(DEMO.tenant_id);
    if (f?.audit_chain_ok !== undefined && verifyAuditChain(audit).ok !== f.audit_chain_ok) failures.push('chuỗi audit không như mong đợi');
    for (const a of f?.audit_events_min ?? []) {
      const n = audit.filter((e) => e.event_type === a.event_type).length;
      if (n < a.count) failures.push(`audit ${a.event_type}: muốn ≥${a.count}, nhận ${n}`);
    }
  } catch (err) {
    failures.push(`lỗi runner: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { id: c.id, category: c.category, critical: c.critical, passed: failures.length === 0, failures };
}

export function loadEvalFiles(root = '.claude/skills'): EvalFile[] {
  const out: EvalFile[] = [];
  for (const slug of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const f = join(root, slug, 'evals', 'evals.json');
    if (existsSync(f)) out.push(JSON.parse(readFileSync(f, 'utf8')) as EvalFile);
  }
  return out;
}

export function fixtureHash(): string {
  const h = createHash('sha256');
  for (const f of readdirSync('fixtures/demo').filter((x) => x.endsWith('.json')).sort()) h.update(f).update(readFileSync(join('fixtures/demo', f)));
  return h.digest('hex').slice(0, 16);
}

export async function runAll(files = loadEvalFiles()): Promise<SkillResult[]> {
  const fx = fixtureHash();
  const res: SkillResult[] = [];
  for (const f of files) {
    const cases: CaseResult[] = [];
    for (const c of f.cases) cases.push(await runCase(c));
    res.push({ skill: f.skill, skill_version: f.skill_version, fixture_hash: fx, cases });
  }
  return res;
}
