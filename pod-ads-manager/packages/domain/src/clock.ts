export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests, demos and evals. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: string | Date = '2026-10-21T03:00:00Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(at: string | Date): void {
    this.t = new Date(at).getTime();
  }
}
