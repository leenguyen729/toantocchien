import { describe, expect, it } from 'vitest';
import { TOOLS, fromApiToolName, llmTools, selfContainedSchema, toApiToolName, toClaudeApiTools } from '@pod/adapter-claude';

describe('tool manifest', () => {
  it('every tool declares the required manifest fields', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      expect(['none', 'internal', 'external']).toContain(t.side_effect);
      expect(t.required_role.length).toBeGreaterThan(0);
      expect(t.timeout_ms).toBeGreaterThan(0);
      expect(['none', 'safe_read', 'idempotent_internal']).toContain(t.retry_class);
      expect(['internal', 'confidential']).toContain(t.data_classification);
      expect(t.adapter_version).toBeTruthy();
      expect(t.input_schema).toBeTypeOf('object');
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });
  it('no LLM-exposed tool can approve, and none has external side effects', () => {
    const exposed = llmTools();
    expect(exposed.map((t) => t.name)).not.toContain('approval.decide');
    expect(exposed.some((t) => t.permission === 'proposal.approve' || t.permission === 'config.confirm' || t.permission === 'ops.unfreeze')).toBe(false);
    expect(exposed.some((t) => t.side_effect === 'external')).toBe(false);
  });
  it('no tool input accepts tenant, role, token, url, sql or shell fields', () => {
    const banned = /^(tenant_id|role|roles|token|access_token|url|sql|query_sql|command|shell|headers)$/;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.properties) for (const k of Object.keys(n.properties as object)) expect(k).not.toMatch(banned);
      Object.values(n).forEach(walk);
    };
    for (const t of TOOLS) walk(t.input_schema);
  });
  it('Claude API export is self-contained and uses API-safe names', () => {
    const api = toClaudeApiTools();
    expect(api.length).toBe(llmTools().length);
    for (const t of api) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(JSON.stringify(t.input_schema)).not.toContain('https://schemas.pod-ads.local');
      expect(JSON.stringify(t.input_schema)).not.toContain('discriminator');
    }
    expect(fromApiToolName(toApiToolName('proposal.create'))).toBe('proposal.create');
    const create = api.find((t) => t.name === 'proposal__create')!;
    expect(Object.keys((create.input_schema as { $defs: object }).$defs)).toEqual(expect.arrayContaining(['Action', 'ActionSetDailyBudget', 'Id']));
    expect(() => selfContainedSchema({ $ref: 'http://evil.example/x.json' })).toThrow();
  });
});
