/**
 * zod -> JSON Schema for structured outputs (output_config.format / Agent SDK outputFormat).
 *
 * The API's structured-output dialect is stricter than JSON Schema: every object must set
 * `additionalProperties: false` and list every property in `required`; nullable values are written as
 * `anyOf: [{type: X}, {type: 'null'}]`; numeric, string-length, array-size, pattern and format
 * constraints are rejected or ignored; no `$ref` (and no recursion). This module post-processes zod's
 * own draft-07 output into that dialect.
 */
import { z } from 'zod';

type Json = Record<string, unknown>;

/** Keywords removed everywhere (unsupported by structured outputs or useless to the model). */
const DROP = new Set([
  '$schema',
  '$id',
  'id',
  'definitions',
  '$defs',
  'default',
  'examples',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'pattern',
  'patternProperties',
  'propertyNames',
  'format',
  'contentEncoding',
  'contentMediaType',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function normalize(node: unknown, descriptions: Record<string, string>, path: string): Json {
  if (!isObj(node)) return {};
  if ('$ref' in node) throw new Error(`structured-output schema may not use $ref (at ${path || '/'})`);
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    out[k] = v;
  }

  // type: ['string', 'null'] -> anyOf
  if (Array.isArray(out.type)) {
    const types = (out.type as unknown[]).filter((t): t is string => typeof t === 'string');
    delete out.type;
    const rest = { ...out };
    for (const k of Object.keys(out)) delete out[k];
    const variants = types.map((t) => (t === 'null' ? { type: 'null' } : normalize({ ...rest, type: t }, {}, path)));
    out.anyOf = variants;
  }

  if (Array.isArray(out.anyOf)) out.anyOf = (out.anyOf as unknown[]).map((v, i) => normalize(v, descriptions, `${path}/anyOf/${i}`));
  if (Array.isArray(out.oneOf)) {
    out.anyOf = (out.oneOf as unknown[]).map((v, i) => normalize(v, descriptions, `${path}/anyOf/${i}`));
    delete out.oneOf;
  }
  if (Array.isArray(out.allOf)) out.allOf = (out.allOf as unknown[]).map((v, i) => normalize(v, descriptions, `${path}/allOf/${i}`));

  if (Array.isArray(out.enum)) {
    const vals = out.enum as unknown[];
    if (!vals.every((v) => typeof v === 'string')) throw new Error(`structured-output enums must be strings (at ${path || '/'})`);
    out.type = 'string';
  }
  if ('const' in out && typeof out.const !== 'string') throw new Error(`structured-output const must be a string (at ${path || '/'})`);

  if (out.type === 'object' || isObj(out.properties)) {
    out.type = 'object';
    const props = isObj(out.properties) ? (out.properties as Json) : {};
    const np: Json = {};
    for (const key of Object.keys(props)) np[key] = normalize(props[key], descriptions, `${path}/${key}`);
    out.properties = np;
    out.required = Object.keys(np);
    out.additionalProperties = false;
  }
  if (out.type === 'array') {
    out.items = Array.isArray(out.items) ? normalize(out.items[0], descriptions, `${path}/[]`) : normalize(out.items, descriptions, `${path}/[]`);
    delete out.prefixItems;
    delete out.additionalItems;
  }
  const d = descriptions[path];
  if (d) out.description = d;
  return out;
}

/**
 * Strict structured-output JSON Schema for a zod schema. `descriptions` maps a property path
 * ("/text", "/items/[]/action") to a description the model sees.
 */
export function toStrictJsonSchema(schema: z.ZodType, descriptions: Record<string, string> = {}): Json {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'output', unrepresentable: 'throw', cycles: 'throw', reused: 'inline' }) as Json;
  return normalize(raw, descriptions, '');
}
