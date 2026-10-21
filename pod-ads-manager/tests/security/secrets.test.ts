import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeSystem, setDailyBudget, proposeAndApprove } from '../helpers';

const SECRET_PATTERNS = [
  /EAA[A-Za-z0-9]{20,}/, // Meta access token shape
  /shpat_[a-f0-9]{32}/, // Shopify admin token
  /shpss_[a-f0-9]{32}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic key
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];

describe('secrets hygiene', () => {
  it('no secret-shaped strings in tracked files', () => {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.startsWith('node_modules') && !f.endsWith('pnpm-lock.yaml') && !f.includes('tests/security/secrets.test.ts'));
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const p of SECRET_PATTERNS) expect(p.test(text), `${f} matches ${p}`).toBe(false);
    }
  });
  it('.env.example has placeholders only and safe defaults', () => {
    const env = readFileSync('.env.example', 'utf8');
    expect(env).toMatch(/^EXECUTION_MODE=mock$/m);
    expect(env).toMatch(/^LIVE_WRITES_ENABLED=false$/m);
    for (const line of env.split('\n').filter((l) => /(TOKEN|SECRET|KEY)=/.test(l) && !l.startsWith('#'))) {
      expect(line, line).toMatch(/=(<[^>]+>)?$/);
    }
  });
  it('audit stores hashes and summaries, not raw payloads', async () => {
    const ctx = await makeSystem();
    await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    const events = await ctx.store.listAudit('tenant_demo');
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(['actor_id', 'actor_kind', 'correlation_id', 'event_hash', 'event_type', 'occurred_at', 'payload_hash', 'prev_hash', 'sequence', 'summary', 'tenant_id']);
      expect(e.summary.length).toBeLessThanOrEqual(500);
    }
  });
  it('audit chain detects tampering', async () => {
    const { verifyAuditChain } = await import('@pod/domain');
    const ctx = await makeSystem();
    const events = await ctx.store.listAudit('tenant_demo');
    expect(verifyAuditChain(events).ok).toBe(true);
    const tampered = events.map((e, i) => (i === 1 ? { ...e, summary: 'sửa lén' } : e));
    expect(verifyAuditChain(tampered)).toEqual({ ok: false, broken_at: 2 });
    expect(verifyAuditChain(events.slice(1)).ok).toBe(false);
  });
});

describe('redaction of free text stored by ops', () => {
  it('masks credential-shaped substrings in incident evidence and freeze reasons', async () => {
    const { redactSecrets } = await import('@pod/domain');
    // Built at runtime so the repo secret scan never sees a token-shaped literal.
    const fakeToken = ['EA', 'ABwzLixnjYBO', '123456789abcdefXYZ'].join('');
    const leaked = `lỗi access_token=${fakeToken} và postgres://pod:pw123@db:5432/x Bearer abc.def-ghi sk-ant-abcdefghijklmnopqrstu shpat_0123456789abcdef0123`;
    const out = redactSecrets(leaked);
    for (const bad of ['EAABwz', 'pw123', 'abc.def-ghi', 'sk-ant-abc', 'shpat_0123']) expect(out).not.toContain(bad);
    const ctx = await makeSystem();
    const r = await ctx.sys.ops.createIncident(ctx.people.u_operator!, 'permission_lost', leaked, ['act_demo'], true);
    expect(JSON.stringify(r)).not.toContain('EAABwz');
    const audit = await ctx.store.listAudit('tenant_demo');
    expect(JSON.stringify(audit)).not.toContain('EAABwz');
  });
});
