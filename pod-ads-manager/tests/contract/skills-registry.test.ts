import { describe, expect, it } from 'vitest';
import { checkSkills } from '../../scripts/lib/check-skills';

describe('.claude/skills registry and SKILL.md structure', () => {
  it('passes the static skill checks', () => {
    expect(checkSkills()).toEqual([]);
  });
});
