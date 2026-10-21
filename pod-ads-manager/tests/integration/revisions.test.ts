import { describe, expect, it } from 'vitest';
import { makeSystem, proposeAndApprove, proposeInput, setDailyBudget } from '../helpers';

describe('proposal revisions', () => {
  it('a new revision cancels a pending one and voids an approved one', async () => {
    const ctx = await makeSystem();
    const { sys, people, store } = ctx;
    const r1 = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    const r2 = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1050)], { proposal_id: r1.proposal.proposal_id }));
    expect(r2.proposal.revision).toBe(2);
    expect(r2.proposal.payload_hash).not.toBe(r1.proposal.payload_hash);
    expect((await store.getProposal(r1.proposal.tenant_id, r1.proposal.proposal_id, 1))?.status).toBe('CANCELLED');

    await sys.approvals.decide(people.u_approver!, r2.proposal.proposal_id, 2, r2.proposal.payload_hash, 'approved', null);
    const r3 = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1080)], { proposal_id: r1.proposal.proposal_id }));
    expect((await store.getProposal(r1.proposal.tenant_id, r1.proposal.proposal_id, 2))?.status).toBe('INVALIDATED');
    await expect(sys.execution.request(people.u_analyst!, r1.proposal.proposal_id, 2, r2.proposal.payload_hash)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(r3.proposal.revision).toBe(3);
    // Approval of revision 2 does not carry over.
    expect(await sys.approvals.status(people.u_analyst!, r1.proposal.proposal_id, 3)).toBe('none');
  });

  it('a queued revision is voided and its reservation released; executing cannot be revised', async () => {
    const ctx = await makeSystem();
    const { sys, people, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    expect((await store.sumActiveReservations(p.tenant_id, p.ad_account_id)).daily_minor).toBe(100);
    await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1050)], { proposal_id: p.proposal_id }));
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('INVALIDATED');
    expect((await store.sumActiveReservations(p.tenant_id, p.ad_account_id)).daily_minor).toBe(0);
    await sys.worker!.drain();
    expect(ctx.meta.outboundWrites).toHaveLength(0);
    await store.casProposalStatus(p.tenant_id, p.proposal_id, 2, 'PENDING_APPROVAL', 'APPROVED');
    await store.casProposalStatus(p.tenant_id, p.proposal_id, 2, 'APPROVED', 'QUEUED');
    await store.casProposalStatus(p.tenant_id, p.proposal_id, 2, 'QUEUED', 'EXECUTING');
    await expect(sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1060)], { proposal_id: p.proposal_id }))).rejects.toThrow(/EXECUTING/);
  });

  it('cannot change ad account between revisions or revise a missing proposal', async () => {
    const { sys, people } = await makeSystem();
    const r1 = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    await expect(sys.proposals.propose(people.u_owner!, { ...proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)], { proposal_id: r1.proposal.proposal_id }), ad_account_id: 'act_x' })).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    await expect(sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)], { proposal_id: 'prp_missing' }))).rejects.toThrow(/Không tìm thấy/);
  });

  it('cancel, revalidate, expireDue', async () => {
    const ctx = await makeSystem();
    const { sys, people, clock, store } = ctx;
    const a = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    expect((await sys.proposals.revalidate(people.u_analyst!, a.proposal.proposal_id, 1)).decision).toBe('pass');
    await sys.proposals.cancel(people.u_analyst!, a.proposal.proposal_id, 1);
    await expect(sys.proposals.cancel(people.u_analyst!, a.proposal.proposal_id, 1)).rejects.toThrow(/CANCELLED/);
    await expect(sys.proposals.cancel(people.u_analyst!, 'nope', 1)).rejects.toThrow();
    await expect(sys.proposals.revalidate(people.u_analyst!, 'nope', 1)).rejects.toThrow();
    const b = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo_2', 1600)]));
    clock.advance(31 * 60_000);
    expect(await sys.proposals.expireDue(b.proposal.tenant_id)).toBe(1);
    expect((await store.getProposal(b.proposal.tenant_id, b.proposal.proposal_id, 1))?.status).toBe('EXPIRED');
    expect((await sys.proposals.get(people.u_viewer!, b.proposal.proposal_id))?.proposal.status).toBe('EXPIRED');
    expect(await sys.proposals.get(people.u_viewer!, 'nope')).toBeNull();
    expect((await sys.proposals.list(people.u_viewer!)).length).toBe(2);
  });

  it('rejects malformed actions and empty/oversized batches before any side effect', async () => {
    const { sys, people, store } = await makeSystem();
    await expect(sys.proposals.propose(people.u_analyst!, proposeInput([{ kind: 'DELETE_CAMPAIGN' } as never]))).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(sys.proposals.propose(people.u_analyst!, proposeInput([]))).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    const a = await setDailyBudget(sys, 'adset_demo', 1100);
    await expect(sys.proposals.propose(people.u_analyst!, proposeInput(Array.from({ length: 51 }, (_, i) => ({ ...a, action_id: `a${i}` }))))).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(await store.listProposals(people.u_analyst!.tenant_id)).toHaveLength(0);
  });
});
