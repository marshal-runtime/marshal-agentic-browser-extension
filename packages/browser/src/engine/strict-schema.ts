/**
 * The want.data schema in the strict form structured-output services require (OpenAI's `response_format` refuses an
 * object without `additionalProperties: false` and a `required` list naming every property: "Invalid schema for
 * response_format ... additionalProperties is required to be supplied and to be false", Marley's relay run of
 * 2026-11-22). A caller (or a model writing a task) gives a loose schema, so the engine tightens it before the extract:
 * every object with `properties` gets `additionalProperties: false` and all its keys required, and a key the caller
 * left optional becomes nullable instead, so the model can still say "not on the page". `loosenAnswer` then removes
 * those nulls, so the caller gets the shape it asked for. A strict schema passes through unchanged.
 */
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `schema` made nullable: `type` gains "null", an `enum` gains null, anything else is wrapped in anyOf. */
function nullable(schema: Json): Json {
  const type: unknown = schema['type'];
  const types: unknown[] | null =
    typeof type === 'string' ? [type] : Array.isArray(type) ? (type as unknown[]) : null;
  if (!types) return { anyOf: [schema, { type: 'null' }] };
  const out: Json = {
    ...schema,
    type: types.includes('null') ? type : [...types, 'null'],
  };
  const choices: unknown = schema['enum'];
  if (Array.isArray(choices) && !(choices as unknown[]).includes(null))
    out['enum'] = [...(choices as unknown[]), null];
  return out;
}

export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!isObject(schema)) return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) continue;
    if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf')
      out[key] = strictSchema(value);
    else if ((key === '$defs' || key === 'definitions') && isObject(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, strictSchema(entry)]),
      );
    else out[key] = value;
  }
  const properties = schema['properties'];
  if (isObject(properties)) {
    const required = new Set(
      Array.isArray(schema['required'])
        ? schema['required'].filter((name): name is string => typeof name === 'string')
        : [],
    );
    const strict: Json = {};
    for (const [name, entry] of Object.entries(properties)) {
      const inner = strictSchema(entry);
      strict[name] = required.has(name) || !isObject(inner) ? inner : nullable(inner);
    }
    out['properties'] = strict;
    out['required'] = Object.keys(properties);
    out['additionalProperties'] = false;
    if (out['type'] === undefined) out['type'] = 'object';
  }
  return out;
}

/** The answer back in the caller's shape: a null the strict form allowed for a key the caller left optional is removed. */
export function loosenAnswer(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value;
  if (Array.isArray(value)) return value.map((entry) => loosenAnswer(entry, schema['items']));
  const properties = schema['properties'];
  if (!isObject(value) || !isObject(properties)) return value;
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : []);
  const out: Json = {};
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null && name in properties && !required.has(name)) continue;
    out[name] = name in properties ? loosenAnswer(entry, properties[name]) : entry;
  }
  return out;
}
