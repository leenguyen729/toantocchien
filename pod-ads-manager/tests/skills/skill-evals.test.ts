import { describe, expect, it } from 'vitest';
import { COMMON_CATEGORIES, loadEvalFiles, runCase, type EvalCase } from '../../scripts/lib/skill-evals';

const files = loadEvalFiles();

describe('skill evals (deterministic, through the tool layer)', () => {
  for (const f of files) {
    it(`${f.skill} covers all 6 common categories`, () => {
      for (const k of COMMON_CATEGORIES) expect(f.cases.some((c) => c.category === k), k).toBe(true);
    });
    for (const c of f.cases) {
      it(`${f.skill} / ${c.id}`, async () => {
        const r = await runCase(c);
        expect(r.failures).toEqual([]);
      });
    }
  }
});

describe('the eval runner can actually fail', () => {
  const s17 = files.find((f) => f.skill === 'pod-approval-execution')!;
  const success = s17.cases.find((c) => c.id === 's17-success-draft-approve-execute')!;

  it('dropping the human approval step makes the success case fail (no write happens)', async () => {
    const mutated: EvalCase = { ...success, steps: success.steps.filter((s) => !('do' in s && s.do === 'approve')) };
    const r = await runCase(mutated);
    expect(r.passed).toBe(false);
    expect(r.failures.join(' ')).toMatch(/committed writes|approved|status/);
  });

  it('a wrong expectation is reported', async () => {
    const mutated: EvalCase = { ...success, final: { ...success.final, committed_writes: 2 } };
    expect((await runCase(mutated)).passed).toBe(false);
  });
});
