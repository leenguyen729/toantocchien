import { DomainError, type ProposalStatus } from '@pod/contracts';

/** Exactly the transitions in the spec (§8 State machine). Anything else is a bug. */
export const TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  APPROVED: ['QUEUED', 'EXPIRED', 'INVALIDATED', 'CANCELLED'],
  QUEUED: ['EXECUTING', 'EXPIRED', 'INVALIDATED', 'CANCELLED'],
  EXECUTING: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['RECONCILING'],
  RECONCILING: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'NEEDS_REVIEW'],
  SUCCEEDED: [],
  PARTIAL: [],
  FAILED: [],
  NEEDS_REVIEW: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  INVALIDATED: [],
};

export const TERMINAL: ReadonlySet<ProposalStatus> = new Set(
  (Object.keys(TRANSITIONS) as ProposalStatus[]).filter((s) => TRANSITIONS[s].length === 0),
);

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!canTransition(from, to)) throw new DomainError('INPUT_INVALID', `Chuyển trạng thái ${from} → ${to} không hợp lệ`);
}
