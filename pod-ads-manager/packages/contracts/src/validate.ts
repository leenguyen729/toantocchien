import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { SCHEMA_ID, schemaBundle, SCHEMA_NAMES } from './schemas';
import { DomainError } from './errors';

// ajv-formats ships CJS; normalise default export under ESM/tsx.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv2020) => void;

const ajv = new Ajv2020({ allErrors: true, strict: true, discriminator: true });
addFormats(ajv);
ajv.addSchema(schemaBundle);

const cache = new Map<string, ValidateFunction>();

export function getValidator(name: string): ValidateFunction {
  const cached = cache.get(name);
  if (cached) return cached;
  if (!SCHEMA_NAMES.includes(name)) throw new Error(`Unknown schema ${name}`);
  const fn = ajv.getSchema(`${SCHEMA_ID}#/$defs/${name}`);
  if (!fn) throw new Error(`Schema ${name} failed to compile`);
  cache.set(name, fn);
  return fn;
}

export type ValidationIssue = { path: string; message: string };

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).slice(0, 20).map((e) => ({
    path: e.instancePath || '/',
    message: e.keyword === 'additionalProperties' ? `unknown field "${String((e.params as { additionalProperty?: string }).additionalProperty)}"` : (e.message ?? e.keyword),
  }));
}

export function validate(name: string, value: unknown): { ok: true } | { ok: false; issues: ValidationIssue[] } {
  const fn = getValidator(name);
  if (fn(value)) return { ok: true };
  return { ok: false, issues: toIssues(fn.errors) };
}

/** Validate or throw INPUT_INVALID. Messages carry field paths only, never values (no PII/secret echo). */
export function assertValid<T>(name: string, value: unknown): T {
  const r = validate(name, value);
  if (!r.ok) {
    throw new DomainError('INPUT_INVALID', `Dữ liệu không hợp lệ theo schema ${name}: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }
  return value as T;
}

/** Compile a tool-local schema that may $ref bundle definitions via `${SCHEMA_ID}#/$defs/<Name>`. */
export function compileToolSchema(schema: Record<string, unknown>): ValidateFunction {
  return ajv.compile(schema);
}

export function issuesOf(fn: ValidateFunction): ValidationIssue[] {
  return toIssues(fn.errors);
}

export const defRef = (name: string): { $ref: string } => ({ $ref: `${SCHEMA_ID}#/$defs/${name}` });
