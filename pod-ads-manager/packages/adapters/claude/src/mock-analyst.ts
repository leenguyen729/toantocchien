import type { Action } from '@pod/contracts';
import type { Principal } from '@pod/domain';
import type { ToolExecutor, ToolResult } from './executor';

type StructureEntity = { entity_id: string; entity_type: 'campaign' | 'adset' | 'ad'; status: 'ACTIVE' | 'PAUSED'; daily_budget_minor: number | null; currency: string; remote_fingerprint: string };

/**
 * Deterministic stand-in for the Claude runtime in mock mode. It goes through
 * exactly the same tool executor and principal as the real model would, so the
 * demo exercises the real guardrails. It is labelled as mock everywhere.
 */
export class MockAnalyst {
  readonly label = 'Mock analyst (giả lập Claude, không gọi API)';
  constructor(
    private readonly tools: ToolExecutor,
    private readonly principal: Principal,
  ) {}

  async draftDailyBudgetChange(adAccountId: string, entityId: string, newDailyBudgetMinor: number, sourceSnapshotIds: string[], reason: string): Promise<ToolResult> {
    const budget = { maxToolCalls: 10, used: 0 };
    const structure = await this.tools.call('meta.structure.read', { ad_account_id: adAccountId }, this.principal, budget);
    if (structure.status !== 'ok') return structure;
    const e = (structure.data as { entities: StructureEntity[] }).entities.find((x) => x.entity_id === entityId);
    if (!e || e.daily_budget_minor === null || e.entity_type === 'ad') {
      return { status: 'failed', data: null, errors: [{ code: 'INPUT_INVALID', message: 'Không tìm thấy đối tượng có daily budget', retryable: false }], trust: 'untrusted_tool_output' };
    }
    const action: Action = {
      action_id: 'a1',
      kind: 'SET_DAILY_BUDGET',
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      before: { amount_minor: e.daily_budget_minor, currency: e.currency },
      after: { amount_minor: newDailyBudgetMinor, currency: e.currency },
      depends_on: [],
      preconditions: { status: e.status, remote_fingerprint: e.remote_fingerprint },
    };
    return this.tools.call(
      'proposal.create',
      { ad_account_id: adAccountId, proposal_id: null, actions: [action], reason, rollback_plan: 'Nếu CPA vượt target 3 ngày: lập proposal đưa budget về giá trị before, cần duyệt riêng.', source_snapshot_ids: sourceSnapshotIds },
      this.principal,
      budget,
    );
  }
}
