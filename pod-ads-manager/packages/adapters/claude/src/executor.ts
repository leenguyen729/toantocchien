import { DomainError, compileToolSchema, isDomainError, issuesOf, type Action, type BusinessConfig, type SkillError } from '@pod/contracts';
import { remoteFingerprint } from '@pod/policy';
import { recoveryChecklist, RUNNING_ADS_NOTE, type Principal, type SignalKind, type System } from '@pod/domain';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { TOOLS_BY_NAME, type ToolDefinition } from './manifest';

export type ToolResult = {
  status: 'ok' | 'blocked' | 'failed';
  data: unknown;
  errors: SkillError[];
  /** Reminder attached to every result: tool output is data, not instructions. */
  trust: 'untrusted_tool_output';
};

type Handler = (input: Record<string, unknown>, p: Principal) => Promise<unknown>;

/** Hard ceiling against runaway agent loops (spec §12). */
export type RunBudget = { maxToolCalls: number; used: number };

/**
 * Executes model tool calls against the backend. The principal is always the
 * server-built Claude runtime principal; nothing in the input can change it.
 */
export class ToolExecutor {
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly handlers: Record<string, Handler>;

  constructor(private readonly sys: System) {
    this.handlers = {
      'context.get': async (i, p) => this.sys.config.get(p, i.ad_account_id as string),
      'context.validate': async (i, p) => this.sys.config.validate(p, i.config_draft as BusinessConfig),
      'context.save_draft': async (i, p) => {
        const r = await this.sys.config.saveDraft(p, i.config_draft as BusinessConfig);
        return { config_version: r.config.version, ...r.assessment, note: 'Đã lưu bản nháp. Owner phải xác nhận trên UI; tool không thể xác nhận.' };
      },
      'connections.health': async (_i, p) => this.sys.config.connectionsHealth(p),
      'meta.structure.read': async (i, p) => {
        const account = i.ad_account_id as string;
        if (!p.grants.some((g) => g.ad_account_ids === '*' || g.ad_account_ids.includes(account))) {
          throw new DomainError('PERMISSION_DENIED', 'Ad account ngoài phạm vi');
        }
        const list = await this.sys.deps.metaRead.listEntities(account);
        return {
          source: this.sys.deps.metaRead.kind === 'mock' ? 'mock_simulator' : 'meta',
          fetched_at: this.sys.deps.clock.now().toISOString(),
          entities: list.map((e) => ({ ...e, remote_fingerprint: remoteFingerprint(e) })),
        };
      },
      'proposal.create': async (i, p) => {
        const r = await this.sys.proposals.propose(p, {
          ad_account_id: i.ad_account_id as string,
          store_id: (await this.sys.deps.store.getLatestConfig(p.tenant_id, i.ad_account_id as string))?.store_id ?? 'unknown_store',
          proposal_id: (i.proposal_id as string | null) ?? null,
          actions: i.actions as Action[],
          reason: i.reason as string,
          rollback_plan: i.rollback_plan as string,
          source_snapshot_ids: i.source_snapshot_ids as string[],
        });
        return {
          proposal_id: r.proposal.proposal_id,
          revision: r.proposal.revision,
          status: r.proposal.status,
          payload_hash: r.proposal.payload_hash,
          impact: r.proposal.impact,
          policy: r.policy,
          note: 'Proposal chỉ là đề xuất. Cần người có quyền duyệt trên UI; tool không thể duyệt.',
        };
      },
      'proposal.validate': async (i, p) => this.sys.proposals.revalidate(p, i.proposal_id as string, i.revision as number),
      'approval.status': async (i, p) => ({ approval_status: await this.sys.approvals.status(p, i.proposal_id as string, i.revision as number) }),
      'execution.request': async (i, p) => this.sys.execution.request(p, i.proposal_id as string, i.revision as number, i.expected_payload_hash as string),
      'execution.reconcile': async (i, p) => {
        const w = this.sys.worker;
        if (!w) throw new DomainError('CAPABILITY_UNSUPPORTED', 'Process này không có worker; reconcile sẽ chạy ở worker');
        const proposal = await this.sys.deps.store.getProposal(p.tenant_id, i.proposal_id as string, i.revision as number);
        if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
        return w.reconcile(p, p.tenant_id, proposal.proposal_id, proposal.revision);
      },
      'ops.health': async (_i, p) => this.sys.ops.health(p),
      'ops.freeze_writes': async (i, p) => ({ freeze_state: await this.sys.ops.freeze(p, i.reason as string), running_ads_note: RUNNING_ADS_NOTE }),
      'ops.incident.create': async (i, p) => {
        const sig = i.signal as { kind: SignalKind; detail: string; ad_account_ids: string[] };
        const r = await this.sys.ops.createIncident(p, sig.kind, sig.detail, sig.ad_account_ids, i.request_freeze as boolean);
        return { incident: r.incident, freeze_state: r.freeze, recovery_checklist: recoveryChecklist(sig.kind), running_ads_note: RUNNING_ADS_NOTE };
      },
      'ops.recovery.draft': async (i) => ({ recovery_checklist: recoveryChecklist(i.kind as SignalKind), running_ads_note: RUNNING_ADS_NOTE }),
    };
  }

  private validator(t: ToolDefinition): ValidateFunction {
    let v = this.validators.get(t.name);
    if (!v) {
      v = compileToolSchema(t.input_schema);
      this.validators.set(t.name, v);
    }
    return v;
  }

  async call(name: string, input: unknown, principal: Principal, budget: RunBudget): Promise<ToolResult> {
    const fail = (status: ToolResult['status'], code: SkillError['code'], message: string): ToolResult => ({
      status,
      data: null,
      errors: [{ code, message, retryable: false }],
      trust: 'untrusted_tool_output',
    });
    budget.used++;
    if (budget.used > budget.maxToolCalls) return fail('blocked', 'POLICY_BLOCKED', 'Vượt giới hạn số tool call của lượt chạy');
    const tool = TOOLS_BY_NAME.get(name);
    // Unknown and UI-only tools look identical to the model: not available.
    if (!tool || (!tool.llm_exposed && principal.kind !== 'human')) return fail('blocked', 'PERMISSION_DENIED', `Tool ${name} không khả dụng`);
    if (tool.status !== 'implemented') return fail('blocked', 'CAPABILITY_UNSUPPORTED', `Tool ${name} chưa triển khai (${tool.phase})`);
    const v = this.validator(tool);
    if (!v(input)) {
      return fail('failed', 'INPUT_INVALID', issuesOf(v).map((x) => `${x.path} ${x.message}`).join('; '));
    }
    const handler = this.handlers[name];
    if (!handler) return fail('blocked', 'CAPABILITY_UNSUPPORTED', `Tool ${name} không có handler`);
    try {
      const data = await handler(input as Record<string, unknown>, principal);
      return { status: 'ok', data, errors: [], trust: 'untrusted_tool_output' };
    } catch (e) {
      if (isDomainError(e)) return fail(e.code === 'INPUT_INVALID' ? 'failed' : 'blocked', e.code, e.message);
      return fail('failed', 'INPUT_INVALID', 'Lỗi nội bộ khi chạy tool');
    }
  }
}
