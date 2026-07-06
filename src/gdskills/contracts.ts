import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ContractName =
  | "agent-event"
  | "orchestrator-state"
  | "review-finding"
  | "subagent-dispatch"
  | "subagent-result";

export type ContractInfo = {
  name: ContractName;
  fileName: string;
  description: string;
};

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  minLength?: number;
  pattern?: string;
};

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  schema: ContractName;
  file: string;
  errors: ValidationError[];
};

export const CONTRACTS: ContractInfo[] = [
  {
    name: "agent-event",
    fileName: "agent-event.schema.json",
    description: "Append-only lifecycle event emitted by orchestrators and subagents.",
  },
  {
    name: "orchestrator-state",
    fileName: "orchestrator-state.schema.json",
    description: "Persisted resumable orchestrator state.",
  },
  {
    name: "review-finding",
    fileName: "review-finding.schema.json",
    description: "Normalized reviewer finding consumed by review-orchestrator and learning flows.",
  },
  {
    name: "subagent-dispatch",
    fileName: "subagent-dispatch.schema.json",
    description: "Orchestrator-to-subagent dispatch payload.",
  },
  {
    name: "subagent-result",
    fileName: "subagent-result.schema.json",
    description: "Subagent-to-orchestrator result payload.",
  },
];

export function normalizeContractName(value: string | undefined): ContractName | undefined {
  return CONTRACTS.find((contract) => contract.name === value)?.name;
}

export async function validateContractFile(
  filePath: string,
  schemaName: ContractName,
): Promise<ValidationResult> {
  const schema = await loadSchema(schemaName);
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as unknown;
  const errors: ValidationError[] = [];
  const schemaCache = new Map<string, JsonSchema>([[schemaName, schema]]);

  await validateValue(data, schema, "$", errors, schema, schemaCache);

  return {
    valid: errors.length === 0,
    schema: schemaName,
    file: filePath,
    errors,
  };
}

export async function loadSchema(name: ContractName): Promise<JsonSchema> {
  const contract = CONTRACTS.find((entry) => entry.name === name);
  if (!contract) {
    throw new Error(`Unknown contract schema: ${name}`);
  }

  const raw = await readFile(contractPath(contract.fileName), "utf8");
  return JSON.parse(raw) as JsonSchema;
}

function contractPath(fileName: string): string {
  return fileURLToPath(new URL(`./contracts/${fileName}`, import.meta.url));
}

async function validateValue(
  value: unknown,
  schema: JsonSchema,
  valuePath: string,
  errors: ValidationError[],
  rootSchema: JsonSchema,
  schemaCache: Map<string, JsonSchema>,
): Promise<void> {
  if (schema.$ref) {
    const resolved = await resolveRef(schema.$ref, rootSchema, schemaCache);
    await validateValue(value, resolved, valuePath, errors, resolved, schemaCache);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({
      path: valuePath,
      message: `Expected type ${formatType(schema.type)}, got ${describeValue(value)}`,
    });
    return;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    errors.push({
      path: valuePath,
      message: `Expected one of ${schema.enum.map(String).join(", ")}`,
    });
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({
      path: valuePath,
      message: `Expected number >= ${schema.minimum}`,
    });
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
  }

  if (isPlainObject(value)) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push({
          path: `${valuePath}.${key}`,
          message: "Missing required property",
        });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedSchema = properties[key];
      if (nestedSchema) {
        await validateValue(
          nestedValue,
          nestedSchema,
          `${valuePath}.${key}`,
          errors,
          rootSchema,
          schemaCache,
        );
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: `${valuePath}.${key}`,
          message: "Additional property is not allowed",
        });
      } else if (isPlainObject(schema.additionalProperties)) {
        await validateValue(
          nestedValue,
          schema.additionalProperties,
          `${valuePath}.${key}`,
          errors,
          rootSchema,
          schemaCache,
        );
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      await validateValue(
        item,
        schema.items,
        `${valuePath}[${index}]`,
        errors,
        rootSchema,
        schemaCache,
      );
    }
  }
}

async function resolveRef(
  ref: string,
  rootSchema: JsonSchema,
  schemaCache: Map<string, JsonSchema>,
): Promise<JsonSchema> {
  if (ref.startsWith("#/$defs/")) {
    const name = ref.replace("#/$defs/", "");
    const schema = rootSchema.$defs?.[name];
    if (!schema) {
      throw new Error(`Cannot resolve schema ref: ${ref}`);
    }

    return schema;
  }

  if (ref === "review-finding.schema.json") {
    const cached = schemaCache.get("review-finding");
    if (cached) {
      return cached;
    }

    const schema = await loadSchema("review-finding");
    schemaCache.set("review-finding", schema);
    return schema;
  }

  throw new Error(`Unsupported schema ref: ${ref}`);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(" | ") : type;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function relativeContractPath(fileName: string): string {
  return path.join("src", "gdskills", "contracts", fileName);
}
