import { describe, expect, it } from 'vitest';
import { AdapterError, FakeMetaAdapter, UnverifiedLiveMetaAdapter, tagSuffix, type CreateRequest } from '@pod/adapter-meta';

const req = (over: Partial<CreateRequest> = {}): CreateRequest => ({ entity_type: 'campaign', parent_id: null, name: 'C', daily_budget_minor: null, lifetime_budget_minor: null, currency: 'USD', idempotency_tag: 'abcdef0123456789ff', extra: {}, ...over });

describe('fake Meta simulator', () => {
  it('creates PAUSED entities tagged for reconciliation', async () => {
    const m = new FakeMetaAdapter();
    const r = await m.create('act', req());
    const e = await m.getEntity('act', r.remote_id);
    expect(e?.status).toBe('PAUSED');
    expect(e?.name.endsWith(tagSuffix('abcdef0123456789ff'))).toBe(true);
    expect(await m.findByIdempotencyTag('act', 'abcdef0123456789ff')).toHaveLength(1);
    expect(m.outboundWrites).toEqual([expect.objectContaining({ op: 'create', committed: true })]);
  });
  it('timeout before commit leaves nothing; after commit leaves the entity', async () => {
    const m = new FakeMetaAdapter();
    m.inject({ op: 'create', fault: 'timeout_before_commit' });
    await expect(m.create('act', req())).rejects.toMatchObject({ kind: 'timeout' });
    expect(await m.findByIdempotencyTag('act', 'abcdef0123456789ff')).toHaveLength(0);
    m.inject({ op: 'create', fault: 'timeout_after_commit' });
    await expect(m.create('act', req())).rejects.toBeInstanceOf(AdapterError);
    expect(await m.findByIdempotencyTag('act', 'abcdef0123456789ff')).toHaveLength(1);
  });
  it('duplicate commit, quota, auth, validation, not found, read faults', async () => {
    const m = new FakeMetaAdapter({ writeQuota: 2 });
    m.inject({ op: 'create', fault: 'duplicate_commit' });
    await m.create('act', req({ idempotency_tag: 'dup0000000000000' }));
    expect(await m.findByIdempotencyTag('act', 'dup0000000000000')).toHaveLength(2);
    await m.create('act', req());
    await expect(m.create('act', req())).rejects.toMatchObject({ kind: 'rate_limited' });
    m.resetQuotaWindow();
    m.inject({ op: 'update', fault: 'auth_error' });
    await expect(m.update('act', { entity_id: 'x', set: { status: 'ACTIVE' } })).rejects.toMatchObject({ kind: 'auth' });
    await expect(m.update('act', { entity_id: 'nope', set: { status: 'ACTIVE' } })).rejects.toMatchObject({ kind: 'not_found' });
    m.inject({ op: 'create', fault: 'validation_error' });
    await expect(m.create('act', req())).rejects.toMatchObject({ kind: 'validation' });
    await expect(m.create('act', req({ parent_id: 'missing' }))).rejects.toMatchObject({ kind: 'validation' });
    m.inject({ op: 'read', fault: 'rate_limit' });
    await expect(m.listEntities('act')).rejects.toMatchObject({ kind: 'rate_limited' });
    m.inject({ op: 'read', fault: 'not_found', match: (r) => 'entity_id' in r && r.entity_id === 'x' });
    await expect(m.getEntity('act', 'x')).rejects.toMatchObject({ kind: 'not_found' });
    m.inject({ op: 'update', fault: 'timeout_before_commit', times: 2 });
    await expect(m.update('act', { entity_id: 'x', set: {} })).rejects.toMatchObject({ kind: 'timeout' });
    await expect(m.update('act', { entity_id: 'x', set: {} })).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('update after-commit timeout applies the change', async () => {
    const m = new FakeMetaAdapter();
    const { remote_id } = await m.create('act', req({ daily_budget_minor: 100 }));
    m.inject({ op: 'update', fault: 'timeout_after_commit' });
    await expect(m.update('act', { entity_id: remote_id, set: { daily_budget_minor: 200, lifetime_budget_minor: 5, status: 'ACTIVE' } })).rejects.toMatchObject({ kind: 'timeout' });
    expect(await m.getEntity('act', remote_id)).toMatchObject({ daily_budget_minor: 200, lifetime_budget_minor: 5, status: 'ACTIVE' });
    m.externalEdit('act', remote_id, { status: 'PAUSED' });
    expect((await m.getEntity('act', remote_id))?.status).toBe('PAUSED');
    expect(() => m.externalEdit('act', 'nope', {})).toThrow();
  });
  it('capabilities are explicitly mock placeholders', async () => {
    const c = await new FakeMetaAdapter().capabilities();
    expect(c.source).toBe('mock_fixture');
    expect(c.api_version).toMatch(/^UNVERIFIED/);
  });
});

describe('unverified live adapter', () => {
  it('fails closed on every method — never pretends to work', async () => {
    const live = new UnverifiedLiveMetaAdapter();
    for (const fn of [() => live.listEntities(), () => live.getEntity(), () => live.findByIdempotencyTag(), () => live.capabilities(), () => live.create(), () => live.update()]) {
      expect(fn).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }));
    }
  });
});
