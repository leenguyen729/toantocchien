import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '@pod/domain';

describe('runtime config', () => {
  it('defaults to mock with live writes off and an ephemeral key', () => {
    const r = loadRuntimeConfig({});
    expect(r.mode).toBe('mock');
    expect(r.liveWritesEnabled).toBe(false);
    expect(r.signingKey.ephemeral).toBe(true);
  });
  it('CI refuses anything but mock/off', () => {
    expect(() => loadRuntimeConfig({ CI: 'true', EXECUTION_MODE: 'read_only', APPROVAL_SIGNING_KEY: 'a'.repeat(64) })).toThrow(/CI/);
    expect(() => loadRuntimeConfig({ CI: 'true', EXECUTION_MODE: 'approval', LIVE_WRITES_ENABLED: 'true', META_ACCOUNT_ALLOWLIST: 'act_1', APPROVAL_SIGNING_KEY: 'a'.repeat(64) })).toThrow(/CI/);
    expect(loadRuntimeConfig({ CI: 'true' }).mode).toBe('mock');
  });
  it('rejects ambiguous flags', () => {
    expect(() => loadRuntimeConfig({ LIVE_WRITES_ENABLED: 'yes' })).toThrow();
    expect(() => loadRuntimeConfig({ EXECUTION_MODE: 'live' })).toThrow();
    expect(() => loadRuntimeConfig({ LIVE_WRITES_ENABLED: 'true' })).toThrow(/approval/);
  });
  it('approval+live requires an operator allowlist and a vault key', () => {
    expect(() => loadRuntimeConfig({ EXECUTION_MODE: 'approval', LIVE_WRITES_ENABLED: 'true', APPROVAL_SIGNING_KEY: 'a'.repeat(64) })).toThrow(/ALLOWLIST/);
    expect(() => loadRuntimeConfig({ EXECUTION_MODE: 'approval' })).toThrow(/SIGNING_KEY/);
    expect(() => loadRuntimeConfig({ EXECUTION_MODE: 'read_only', APPROVAL_SIGNING_KEY: 'short' })).toThrow(/hex/);
    const ok = loadRuntimeConfig({ EXECUTION_MODE: 'approval', LIVE_WRITES_ENABLED: 'true', META_ACCOUNT_ALLOWLIST: 'act_1, act_2', APPROVAL_SIGNING_KEY: 'b'.repeat(64), APPROVAL_SIGNING_KEY_ID: 'k9' });
    expect(ok.accountAllowlist).toEqual(['act_1', 'act_2']);
    expect(ok.signingKey).toMatchObject({ key_id: 'k9', ephemeral: false });
  });
});
