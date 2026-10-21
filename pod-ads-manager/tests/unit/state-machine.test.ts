import { describe, expect, it } from 'vitest';
import { PROPOSAL_STATUSES } from '@pod/contracts';
import { TERMINAL, TRANSITIONS, assertTransition, canTransition } from '@pod/domain';

// Copied verbatim from spec §8 so any drift in code fails this test.
const SPEC = `
DRAFT -> VALIDATED -> PENDING_APPROVAL -> APPROVED -> QUEUED
QUEUED -> EXECUTING -> SUCCEEDED | PARTIAL | FAILED | UNKNOWN
PENDING_APPROVAL -> REJECTED | EXPIRED | CANCELLED
APPROVED/QUEUED -> EXPIRED | INVALIDATED | CANCELLED
UNKNOWN -> RECONCILING -> SUCCEEDED | PARTIAL | FAILED | NEEDS_REVIEW`;

function specEdges(): Set<string> {
  const edges = new Set<string>();
  for (const line of SPEC.trim().split('\n')) {
    const parts = line.split('->').map((p) => p.trim());
    for (let i = 0; i < parts.length - 1; i++) {
      const froms = parts[i]!.split(/[|/]/).map((x) => x.trim());
      const tos = parts[i + 1]!.split('|').map((x) => x.trim());
      // Only the last element of a chain segment is the source for the next hop.
      const src = i === 0 ? froms : [froms[froms.length - 1]!];
      for (const f of src) for (const t of tos) edges.add(`${f}->${t}`);
    }
  }
  return edges;
}

describe('proposal state machine', () => {
  it('implements exactly the spec transitions', () => {
    const code = new Set<string>();
    for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) code.add(`${from}->${to}`);
    expect([...code].sort()).toEqual([...specEdges()].sort());
  });
  it('covers every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...PROPOSAL_STATUSES].sort());
  });
  it('rejects shortcuts that would skip approval', () => {
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition('PENDING_APPROVAL', 'QUEUED')).toBe(false);
    expect(canTransition('VALIDATED', 'EXECUTING')).toBe(false);
    expect(canTransition('UNKNOWN', 'SUCCEEDED')).toBe(false);
    expect(() => assertTransition('DRAFT', 'EXECUTING')).toThrow(/không hợp lệ/);
    expect(() => assertTransition('DRAFT', 'VALIDATED')).not.toThrow();
  });
  it('terminal states have no exits', () => {
    for (const s of ['SUCCEEDED', 'PARTIAL', 'FAILED', 'NEEDS_REVIEW', 'REJECTED', 'EXPIRED', 'CANCELLED', 'INVALIDATED'] as const) expect(TERMINAL.has(s)).toBe(true);
    expect(TERMINAL.has('UNKNOWN')).toBe(false);
  });
});
