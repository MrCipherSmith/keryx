import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Keyword-coverage proof for the deterministic contract validator.
//
// `SUPPORTED_KEYWORDS` is the exact set of JSON Schema (Draft 2020-12) keywords
// the validator in `validator.ts` implements. `usedKeywords` structurally walks
// every frozen `*.schema.json` in a directory and reports which validation
// keywords they actually rely on. The C-03 coverage matrix proves
// `usedKeywords ⊆ SUPPORTED_KEYWORDS`, so no contract can use a keyword the
// validator silently ignores.
// ---------------------------------------------------------------------------

export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  // Core / references.
  "$ref",
  "$defs",
  // Type + value assertions.
  "type",
  "const",
  "enum",
  // Object assertions.
  "required",
  "properties",
  "additionalProperties",
  // String assertions.
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // Number assertions.
  "minimum",
  "maximum",
  // Array assertions.
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  // Applicators / combinators.
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
]);

// Annotation / meta keywords that carry no validation semantics. They are
// recognized no-ops and must NOT be counted as "used" validation keywords.
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
]);

// Keyword whose value is a single subschema.
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "items",
  "additionalProperties",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "propertyNames",
]);

// Keyword whose value is an array of subschemas.
const SUBSCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf"]);

// Keyword whose value is a map of name -> subschema. The map KEYS are names,
// not keywords, so they are never counted (this is what keeps a property
// literally named "format" or "enum" from leaking into the used set).
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "$defs",
  "patternProperties",
  "definitions",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Structurally walk a schema node, recording keyword names and recursing only
// into positions that hold subschemas.
function collectFromSchema(schema: unknown, used: Set<string>): void {
  if (!isPlainObject(schema)) {
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) {
      continue;
    }
    used.add(key);

    if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
      if (isPlainObject(value)) {
        for (const child of Object.values(value)) {
          collectFromSchema(child, used);
        }
      }
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(key)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          collectFromSchema(child, used);
        }
      }
    } else if (SUBSCHEMA_KEYWORDS.has(key)) {
      // `additionalProperties` may be a boolean; only recurse when it is a schema.
      collectFromSchema(value, used);
    }
    // Any other keyword (type, required, enum, const, minLength, pattern, ...)
    // has non-schema values and is intentionally not recursed into.
  }
}

/** Collect the validation keywords used by every frozen `*.schema.json` in `schemaDir`. */
export function usedKeywords(schemaDir: string): Set<string> {
  const used = new Set<string>();
  const files = readdirSync(schemaDir)
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(path.join(schemaDir, file), "utf8");
    const doc = JSON.parse(raw) as unknown;
    collectFromSchema(doc, used);
  }
  return used;
}
