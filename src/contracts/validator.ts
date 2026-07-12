import { type JsonSchema, SchemaResolver } from "./resolver";

// ---------------------------------------------------------------------------
// Deterministic JSON Schema (Draft 2020-12 subset) validator for the frozen
// Keryx harness contracts. NO external Draft 2020-12 library: this implements
// exactly the keyword set the 34 frozen schemas use (see keyword-coverage.ts).
//
// Determinism: the validator only reads schema/fixture files via SchemaResolver
// (no Date.now, no network, no randomness). Errors are collected with a
// JSON-path-ish location so callers can see which field failed.
// ---------------------------------------------------------------------------

export interface SchemaError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: SchemaError[];
}

export interface ValidateOptions {
  schemaDir: string;
}

const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => {
    if (entry === "array") return Array.isArray(value);
    if (entry === "null") return value === null;
    if (entry === "integer") return typeof value === "number" && Number.isInteger(value);
    if (entry === "number") return typeof value === "number" && Number.isFinite(value);
    if (entry === "object") return isPlainObject(value);
    return typeof value === entry;
  });
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

interface Context {
  resolver: SchemaResolver;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asType(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  return undefined;
}

// Validate `value` against `schema` (owned by `docRoot`), pushing any failures
// into `errors`. `docRoot` is the document used to resolve local `#/...` refs.
function validateNode(
  value: unknown,
  schema: JsonSchema,
  docRoot: Record<string, unknown>,
  valuePath: string,
  ctx: Context,
  errors: SchemaError[],
): void {
  if (typeof schema === "boolean") {
    if (schema === false) {
      errors.push({ path: valuePath, message: "Schema `false` rejects all values" });
    }
    return;
  }

  // `$ref` — validate against the target, then continue with any sibling
  // keywords (Draft 2020-12 allows `$ref` alongside other assertions).
  const ref = asString(schema.$ref);
  if (ref !== undefined) {
    const resolved = ctx.resolver.resolve(ref, docRoot);
    validateNode(value, resolved.schema, resolved.root, valuePath, ctx, errors);
  }

  // type — on mismatch, further type-specific keywords are meaningless.
  const type = asType(schema.type);
  if (type !== undefined && !matchesType(value, type)) {
    const expected = Array.isArray(type) ? type.join(" | ") : type;
    errors.push({
      path: valuePath,
      message: `Expected type ${expected}, got ${describeValue(value)}`,
    });
    return;
  }

  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push({ path: valuePath, message: `Expected constant ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push({
      path: valuePath,
      message: `Expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    });
  }

  if (typeof value === "string") {
    const minLength = asNumber(schema.minLength);
    if (minLength !== undefined && value.length < minLength) {
      errors.push({ path: valuePath, message: `Expected string length >= ${minLength}` });
    }
    const maxLength = asNumber(schema.maxLength);
    if (maxLength !== undefined && value.length > maxLength) {
      errors.push({ path: valuePath, message: `Expected string length <= ${maxLength}` });
    }
    const pattern = asString(schema.pattern);
    if (pattern !== undefined && !new RegExp(pattern).test(value)) {
      errors.push({ path: valuePath, message: `Expected string to match pattern ${pattern}` });
    }
    if (schema.format === "date-time" && !DATE_TIME_PATTERN.test(value)) {
      errors.push({ path: valuePath, message: "Expected an RFC 3339 date-time string" });
    }
  }

  if (typeof value === "number") {
    const minimum = asNumber(schema.minimum);
    if (minimum !== undefined && value < minimum) {
      errors.push({ path: valuePath, message: `Expected number >= ${minimum}` });
    }
    const maximum = asNumber(schema.maximum);
    if (maximum !== undefined && value > maximum) {
      errors.push({ path: valuePath, message: `Expected number <= ${maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        validateNode(item, schema.items as JsonSchema, docRoot, `${valuePath}[${index}]`, ctx, errors);
      });
    }
    const minItems = asNumber(schema.minItems);
    if (minItems !== undefined && value.length < minItems) {
      errors.push({ path: valuePath, message: `Expected array length >= ${minItems}` });
    }
    const maxItems = asNumber(schema.maxItems);
    if (maxItems !== undefined && value.length > maxItems) {
      errors.push({ path: valuePath, message: `Expected array length <= ${maxItems}` });
    }
    if (schema.uniqueItems === true) {
      const seen: unknown[] = [];
      for (const item of value) {
        if (seen.some((prior) => deepEqual(prior, item))) {
          errors.push({ path: valuePath, message: "Expected array items to be unique" });
          break;
        }
        seen.push(item);
      }
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) {
          errors.push({ path: `${valuePath}.${key}`, message: "Missing required property" });
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const additional = schema.additionalProperties;
    for (const [key, nested] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        validateNode(nested, propertySchema as JsonSchema, docRoot, `${valuePath}.${key}`, ctx, errors);
      } else if (additional === false) {
        errors.push({ path: `${valuePath}.${key}`, message: "Additional property is not allowed" });
      } else if (isPlainObject(additional)) {
        validateNode(nested, additional, docRoot, `${valuePath}.${key}`, ctx, errors);
      }
    }
  }

  // Combinators.
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      validateNode(value, branch as JsonSchema, docRoot, valuePath, ctx, errors);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const passes = schema.anyOf.some(
      (branch) => branchErrors(value, branch as JsonSchema, docRoot, ctx).length === 0,
    );
    if (!passes) {
      errors.push({ path: valuePath, message: "Value does not match any allowed schema (anyOf)" });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (branch) => branchErrors(value, branch as JsonSchema, docRoot, ctx).length === 0,
    ).length;
    if (matches !== 1) {
      errors.push({
        path: valuePath,
        message: `Expected exactly one matching schema (oneOf), matched ${matches}`,
      });
    }
  }

  if ("if" in schema) {
    const conditionFailed = branchErrors(value, schema.if as JsonSchema, docRoot, ctx).length > 0;
    if (!conditionFailed) {
      if ("then" in schema) {
        validateNode(value, schema.then as JsonSchema, docRoot, valuePath, ctx, errors);
      }
    } else if ("else" in schema) {
      validateNode(value, schema.else as JsonSchema, docRoot, valuePath, ctx, errors);
    }
  }
}

function branchErrors(
  value: unknown,
  schema: JsonSchema,
  docRoot: Record<string, unknown>,
  ctx: Context,
): SchemaError[] {
  const errors: SchemaError[] = [];
  validateNode(value, schema, docRoot, "$", ctx, errors);
  return errors;
}

/**
 * Validate `data` against the named frozen schema file. Cross-file `$ref`s are
 * resolved against sibling schemas in `opts.schemaDir`.
 */
export function validateAgainstSchema(
  schemaFile: string,
  data: unknown,
  opts: ValidateOptions,
): ValidationResult {
  const resolver = new SchemaResolver(opts.schemaDir);
  const root = resolver.loadSchema(schemaFile);
  const errors: SchemaError[] = [];
  validateNode(data, root, root, "$", { resolver }, errors);
  return { valid: errors.length === 0, errors };
}
