import { describe, expect, it } from 'vitest';
import { assertCan, assertTenant, can, claudeRuntimePrincipal, type Principal } from '@pod/domain';

const human = (role: Principal['grants'][number]['role'], accounts: string[] | '*' = ['act_a']): Principal => ({
  actor_id: `u_${role}`,
  tenant_id: 't1',
  kind: 'human',
  display_name: role,
  grants: [{ role, ad_account_ids: accounts, approval_limit_minor: 1000, approval_limit_currency: 'USD' }],
});

describe('RBAC', () => {
  it('only approver role approves; operator and owner do not implicitly approve', () => {
    expect(can(human('approver'), 'proposal.approve', 'act_a')).toBe(true);
    expect(can(human('operator', '*'), 'proposal.approve', 'act_a')).toBe(false);
    expect(can(human('owner', '*'), 'proposal.approve', 'act_a')).toBe(false);
    expect(can(human('analyst'), 'proposal.approve', 'act_a')).toBe(false);
    expect(can(human('viewer'), 'proposal.approve', 'act_a')).toBe(false);
  });
  it('scopes grants to ad accounts', () => {
    expect(can(human('approver', ['act_a']), 'proposal.approve', 'act_b')).toBe(false);
    expect(can(human('approver', '*'), 'proposal.approve', 'act_b')).toBe(true);
  });
  it('viewer reads but cannot create', () => {
    expect(can(human('viewer'), 'report.read', 'act_a')).toBe(true);
    expect(can(human('viewer'), 'proposal.create', 'act_a')).toBe(false);
    expect(can(human('viewer'), 'audit.read', 'act_a')).toBe(false);
  });
  it('LLM principal can never approve, confirm config or unfreeze, even with forged grants', () => {
    const llm: Principal = { ...claudeRuntimePrincipal('t1', ['act_a']), grants: [{ role: 'approver', ad_account_ids: '*' }, { role: 'owner', ad_account_ids: '*' }] };
    expect(can(llm, 'proposal.approve', 'act_a')).toBe(false);
    expect(can(llm, 'config.confirm', 'act_a')).toBe(false);
    expect(can(llm, 'ops.unfreeze')).toBe(false);
    expect(can(llm, 'connections.manage')).toBe(false);
    expect(can(llm, 'proposal.cancel', 'act_a')).toBe(false);
  });
  it('LLM may draft, request execution of approved work, and freeze (fail-closed)', () => {
    const llm = claudeRuntimePrincipal('t1', ['act_a']);
    expect(can(llm, 'proposal.create', 'act_a')).toBe(true);
    expect(can(llm, 'proposal.create', 'act_b')).toBe(false);
    expect(can(llm, 'execution.request', 'act_a')).toBe(true);
    expect(can(llm, 'ops.freeze')).toBe(true);
  });
  it('service principals cannot approve', () => {
    const svc: Principal = { ...human('approver'), kind: 'service' };
    expect(can(svc, 'proposal.approve', 'act_a')).toBe(false);
  });
  it('assert helpers throw standard codes', () => {
    expect(() => assertCan(human('viewer'), 'proposal.create', 'act_a')).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() => assertTenant(human('viewer'), 't2')).toThrow(expect.objectContaining({ code: 'TENANT_MISMATCH' }));
    expect(() => assertTenant(human('viewer'), 't1')).not.toThrow();
  });
});
