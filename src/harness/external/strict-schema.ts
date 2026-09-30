/**
 * The OpenAI structured-output validator, which `codex exec --output-schema`
 * forwards to, accepts a narrower JSON Schema than the contract is written in.
 * Measured: every object must list ALL its properties in `required` and set
 * `additionalProperties: false`, and a handful of keywords are refused. keryx
 * keeps validating against the full contract; this module only derives the
 * copy codex is handed, and undoes the one thing that copy forces on the
 * output (a null on a property the contract never required).
 */

type Schema = Record<string, unknown>;

const NULL_SCHEMA: Schema = { type: "null" };

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapSchemas(value: unknown): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  if (!isSchema(value)) return out;
  for (const [key, child] of Object.entries(value)) out[key] = toStrictNode(child);
  return out;
}

/** The nullable form of an already-transformed schema. */
function makeNullable(schema: Schema): Schema {
  const type = schema.type;
  if (typeof type === "string") {
    if (type === "null") return schema;
    const out: Schema = { ...schema, type: [type, "null"] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
    return out;
  }
  if (Array.isArray(type)) {
    if (type.includes("null")) {
      const out: Schema = { ...schema };
      if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
      return out;
    }
    const out: Schema = { ...schema, type: [...type, "null"] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
    return out;
  }
  if (Array.isArray(schema.enum) && schema.anyOf === undefined) {
    return schema.enum.includes(null) ? schema : { ...schema, enum: [...schema.enum, null] };
  }
  if (Array.isArray(schema.anyOf)) {
    return { ...schema, anyOf: [...schema.anyOf, NULL_SCHEMA] };
  }
  return { anyOf: [schema, NULL_SCHEMA] };
}

function toStrictNode(node: unknown): Schema {
  if (!isSchema(node)) return {};
  const out: Schema = {};

  if (node.type !== undefined) out.type = node.type;
  if (Array.isArray(node.enum)) out.enum = [...node.enum];
  else if ("const" in node) out.enum = [node.const];
  if (typeof node.$ref === "string") out.$ref = node.$ref;

  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union)) out.anyOf = union.map(toStrictNode);

  if (isSchema(node.items)) out.items = toStrictNode(node.items);
  if (isSchema(node.$defs)) out.$defs = mapSchemas(node.$defs);

  const isObject = node.type === "object" || isSchema(node.properties);
  if (isObject) {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const properties: Record<string, Schema> = {};
    for (const [key, child] of Object.entries(isSchema(node.properties) ? node.properties : {})) {
      const strict = toStrictNode(child);
      properties[key] = required.has(key) ? strict : makeNullable(strict);
    }
    out.type ??= "object";
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * The strict copy of a bundled (sibling refs inlined) schema. Keeps structure,
 * `type`, `enum`, `items`, `anyOf` and local `$ref`/`$defs`; drops every other
 * keyword, among them the ones the validator refuses (`allOf`, `if`/`then`/
 * `else`, `pattern`, `format`, numeric and length bounds, `default`). Never
 * mutates its input.
 */
export function toStrictOutputSchema(bundled: unknown): Schema {
  return toStrictNode(bundled);
}

function resolveRef(node: Schema, root: Schema): Schema {
  let current = node;
  for (let hops = 0; typeof current.$ref === "string" && hops < 16; hops += 1) {
    const ref = current.$ref;
    if (!ref.startsWith("#/")) return current;
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      target = isSchema(target) ? target[decodeURIComponent(part)] : undefined;
    }
    if (!isSchema(target)) return current;
    current = target;
  }
  return current;
}

function dropNulls(value: unknown, node: unknown, root: Schema): unknown {
  if (!isSchema(node)) return value;
  const schema = resolveRef(node, root);

  if (Array.isArray(value)) {
    return isSchema(schema.items) ? value.map((item) => dropNulls(item, schema.items, root)) : value;
  }
  if (!isSchema(value) || !isSchema(schema.properties)) return value;

  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && !required.has(key)) continue;
    out[key] = dropNulls(child, schema.properties[key], root);
  }
  return out;
}

/**
 * Undo the strict copy's side effect: a null on a property the ORIGINAL schema
 * does not require is removed, so the document validates against the full
 * contract. A null on a required property is kept and fails that validation as
 * it should. Returns a new value; never mutates its input.
 */
export function dropOptionalNulls(value: unknown, bundled: unknown): unknown {
  return isSchema(bundled) ? dropNulls(value, bundled, bundled) : value;
}
