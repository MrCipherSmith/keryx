// Bundled JSON Schemas for Metaproject Security.
//
// Faithful inline copies of
// docs/requirements/security/schemas/security-finding.schema.json and
// security-report.schema.json, plus a config schema for `policy validate`.
// Inlined as TypeScript objects so validation never reads from docs/ at runtime
// (that path is not shipped in the published package).
//
// The validator is a self-contained draft-2020-12 subset — the same shape and
// approach used by src/standard/validate.ts (type/enum/minimum/maximum/
// minLength/format:date-time/required/properties/additionalProperties/items/
// $ref), extended with cross-schema `$ref` so a report can reference the finding
// schema. Keep these in sync with the source schema files.

export type JsonSchema = {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
  uniqueItems?: boolean;
};

export const SECURITY_FINDING_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://metaproject.dev/schemas/security-finding.schema.json",
  title: "Metaproject Security Finding",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "policyId",
    "severity",
    "category",
    "source",
    "action",
    "confidence",
    "createdAt",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    policyId: { type: "string", minLength: 1 },
    severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low", "info"],
    },
    category: {
      type: "string",
      enum: [
        "secret",
        "pii",
        "prompt-injection",
        "egress",
        "artifact-safety",
        "raw-retention",
      ],
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: [
            "trusted-project",
            "trusted-user",
            "untrusted-external",
            "tool-output",
            "generated",
          ],
        },
        path: { type: "string" },
        command: { type: "string" },
        url: { type: "string" },
      },
    },
    target: {
      type: "string",
      enum: ["model", "memory", "wiki", "report", "external", "task", "unknown"],
    },
    action: {
      type: "string",
      enum: ["allow", "redact", "block", "require-approval", "warn"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    redactedPreview: { type: "string" },
    hash: { type: "string" },
    location: {
      type: "object",
      additionalProperties: false,
      properties: {
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 0 },
      },
    },
    remediation: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const SECURITY_REPORT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://metaproject.dev/schemas/security-report.schema.json",
  title: "Metaproject Security Report",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "createdAt",
    "mode",
    "gate",
    "rawRetention",
    "summary",
    "findings",
  ],
  properties: {
    schemaVersion: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    mode: {
      type: "string",
      enum: ["advisory", "enforced", "ci", "gateway"],
    },
    gate: {
      type: "string",
      enum: ["pass", "needs-approval", "fail"],
    },
    rawRetention: {
      type: "string",
      enum: ["off", "local", "ci-private", "explicit"],
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["total", "bySeverity", "byAction", "byCategory"],
      properties: {
        total: { type: "integer", minimum: 0 },
        bySeverity: { $ref: "#/$defs/counts" },
        byAction: { $ref: "#/$defs/counts" },
        byCategory: { $ref: "#/$defs/counts" },
      },
    },
    findings: {
      type: "array",
      items: { $ref: "security-finding.schema.json" },
    },
    integrations: {
      type: "object",
      additionalProperties: true,
    },
  },
  $defs: {
    counts: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
  },
};

const POLICY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "action"],
  properties: {
    enabled: { type: "boolean" },
    action: {
      type: "string",
      enum: ["allow", "redact", "block", "require-approval", "warn"],
    },
    minConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

// Egress reuses the policy shape but additionally allows a host allowlist
// (Block E, E3). Kept separate so the other policies stay strict.
const EGRESS_POLICY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "action"],
  properties: {
    enabled: { type: "boolean" },
    action: {
      type: "string",
      enum: ["allow", "redact", "block", "require-approval", "warn"],
    },
    minConfidence: { type: "number", minimum: 0, maximum: 1 },
    allowlist: { type: "array", items: { type: "string" } },
  },
};

export const SECURITY_CONFIG_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://metaproject.dev/schemas/security-config.schema.json",
  title: "Metaproject Security Config",
  type: "object",
  additionalProperties: true,
  required: ["schemaVersion", "mode", "policies"],
  properties: {
    schemaVersion: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["advisory", "enforced", "ci", "gateway"] },
    rawRetention: {
      type: "string",
      enum: ["off", "local", "ci-private", "explicit"],
    },
    storeHashes: { type: "boolean" },
    storeRedactedSamples: { type: "boolean" },
    policies: {
      type: "object",
      additionalProperties: false,
      required: [
        "secrets",
        "pii",
        "promptInjection",
        "egress",
        "artifactSafety",
      ],
      properties: {
        secrets: POLICY_SCHEMA,
        pii: POLICY_SCHEMA,
        promptInjection: POLICY_SCHEMA,
        egress: EGRESS_POLICY_SCHEMA,
        artifactSafety: POLICY_SCHEMA,
      },
    },
    backends: { type: "object", additionalProperties: true },
    gate: {
      type: "object",
      additionalProperties: false,
      properties: {
        failOn: {
          type: "string",
          enum: ["critical", "high", "medium", "low", "info"],
        },
        minConfidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    configChecksum: { type: "string" },
  },
};

const SCHEMA_REGISTRY: Record<string, JsonSchema> = {
  "security-finding.schema.json": SECURITY_FINDING_SCHEMA,
  "security-report.schema.json": SECURITY_REPORT_SCHEMA,
};

export type SchemaError = { path: string; message: string };

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
    if (entry === "integer") return Number.isInteger(value);
    if (entry === "object") return isPlainObject(value);
    return typeof value === entry;
  });
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function resolveRef(
  ref: string,
  rootSchema: JsonSchema,
): { schema: JsonSchema; root: JsonSchema } {
  if (ref.startsWith("#/$defs/")) {
    const name = ref.replace("#/$defs/", "");
    const schema = rootSchema.$defs?.[name];
    if (!schema) {
      throw new Error(`Cannot resolve schema ref: ${ref}`);
    }
    return { schema, root: rootSchema };
  }

  const external = SCHEMA_REGISTRY[ref];
  if (external) {
    return { schema: external, root: external };
  }

  throw new Error(`Unsupported schema ref: ${ref}`);
}

function walk(
  value: unknown,
  schema: JsonSchema,
  valuePath: string,
  rootSchema: JsonSchema,
  errors: SchemaError[],
): void {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, rootSchema);
    walk(value, resolved.schema, valuePath, resolved.root, errors);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    const expected = Array.isArray(schema.type)
      ? schema.type.join(" | ")
      : schema.type;
    errors.push({
      path: valuePath,
      message: `Expected type ${expected}, got ${describeValue(value)}`,
    });
    return;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    errors.push({
      path: valuePath,
      message: `Expected one of ${schema.enum.map(String).join(", ")}`,
    });
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path: valuePath,
        message: `Expected number >= ${schema.minimum}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path: valuePath,
        message: `Expected number <= ${schema.maximum}`,
      });
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path: valuePath,
        message: `Expected string length >= ${schema.minLength}`,
      });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({
        path: valuePath,
        message: `Expected string to match pattern ${schema.pattern}`,
      });
    }
    if (schema.format === "date-time" && !DATE_TIME_PATTERN.test(value)) {
      errors.push({
        path: valuePath,
        message: "Expected an ISO 8601 date-time string",
      });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      walk(item, schema.items as JsonSchema, `${valuePath}[${index}]`, rootSchema, errors);
    });
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push({
          path: `${valuePath}.${key}`,
          message: "Missing required property",
        });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, nested] of Object.entries(value)) {
      const nestedSchema = properties[key];
      if (nestedSchema) {
        walk(nested, nestedSchema, `${valuePath}.${key}`, rootSchema, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: `${valuePath}.${key}`,
          message: "Additional property is not allowed",
        });
      } else if (isPlainObject(schema.additionalProperties)) {
        walk(
          nested,
          schema.additionalProperties,
          `${valuePath}.${key}`,
          rootSchema,
          errors,
        );
      }
    }
  }
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
): SchemaError[] {
  const errors: SchemaError[] = [];
  walk(value, schema, "$", schema, errors);
  return errors;
}
