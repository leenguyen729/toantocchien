export * from './manifest';
export * from './executor';
export * from './mock-analyst';
import { SCHEMA_ID, schemaBundle } from '@pod/contracts';
import { llmTools, toApiToolName } from './manifest';

const DEFS = schemaBundle.$defs as Record<string, unknown>;

/**
 * Make a tool input schema self-contained for the Claude API: external
 * bundle refs become local `#/$defs/X` refs, reachable definitions are copied
 * in, and the ajv-only `discriminator` keyword is dropped.
 */
export function selfContainedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const needed = new Set<string>();
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'discriminator' || k === '$schema') continue;
      if (k === '$ref' && typeof v === 'string') {
        const name = v.startsWith(`${SCHEMA_ID}#/$defs/`) ? v.slice(`${SCHEMA_ID}#/$defs/`.length) : v.startsWith('#/$defs/') ? v.slice('#/$defs/'.length) : null;
        if (!name) throw new Error(`Unsupported $ref ${v}`);
        if (!needed.has(name)) {
          needed.add(name);
          defs[name] = rewrite(DEFS[name]);
        }
        out.$ref = `#/$defs/${name}`;
        continue;
      }
      out[k] = rewrite(v);
    }
    return out;
  };
  const defs: Record<string, unknown> = {};
  const root = rewrite(schema) as Record<string, unknown>;
  return needed.size ? { ...root, $defs: defs } : root;
}

/** Tool list in Claude Messages API shape. Only implemented, LLM-exposed tools are included. */
export function toClaudeApiTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return llmTools().map((t) => ({ name: toApiToolName(t.name), description: t.description, input_schema: selfContainedSchema(t.input_schema) }));
}
