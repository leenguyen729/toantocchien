// Small helpers so the schema bundle stays readable. Every object schema is
// closed (additionalProperties:false) and, unless stated, every property is required.
export type Schema = Record<string, unknown>;

export const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
export const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] });
export const arr = (items: Schema, extra: Schema = {}): Schema => ({ type: 'array', items, ...extra });
export const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
export const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
export const num = (extra: Schema = {}): Schema => ({ type: 'number', ...extra });
export const bool = (): Schema => ({ type: 'boolean' });
export const enm = (...values: string[]): Schema => ({ type: 'string', enum: values });
export const konst = (value: string | number): Schema => ({ const: value });

export function obj(properties: Record<string, Schema>, optional: string[] = [], extra: Schema = {}): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    ...extra,
  };
}
