import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785 subset): object keys sorted by UTF-16 code units, no
 * whitespace, `undefined` properties dropped. Contracts only allow integers for
 * money so number serialisation is stable; non-finite numbers are rejected.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Non-finite number cannot be canonicalized');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`Unsupported type ${typeof value} in canonical JSON`);
  }
}

export const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');
export const canonicalHash = (value: unknown): string => sha256Hex(canonicalize(value));
