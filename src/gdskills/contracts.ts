import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ContractName =
  | "agent-event"
  | "job-orchestrator-state"
  | "orchestrator-state"
  | "review-finding"
  | "subagent-dispatch"
  | "subagent-result";

export type ContractInfo = {
  name: ContractName;
  /** Name this contract is written under in `.metaproject/core/gdskills/contracts/`. */
  fileName: string;
  description: string;
  /**
   * Repo-relative location of the AUTHORITATIVE file, when it does not live in
   * `src/gdskills/contracts/`.
   *
   * `job-orchestrator-state` is the case this exists for. Its schema has always
   * shipped inside the skill that owns it, and copying it into the contracts
   * directory would create a second copy to keep in step — which is how a schema
   * ends up describing a shape nothing writes. The registry points at the one
   * file instead.
   */
  sourcePath?: string;
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
  const?: unknown;
  minimum?: number;
  minLength?: number;
  pattern?: string;
  // Conditional application. Added for the `class_scope` rule on
  // `review-finding`, where a requirement depends on `severity`.
  //
  // This validator is hand-rolled because keryx carries zero runtime
  // dependencies, and it silently IGNORES any keyword it does not implement. A
  // schema written with `if`/`then` before this existed would have looked
  // enforced and enforced nothing — see `review-finding-class-scope.test.ts`,
  // which pins the keyword itself so the finding rule cannot pass for the wrong
  // reason.
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  allOf?: JsonSchema[];
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
    name: "job-orchestrator-state",
    fileName: "job-orchestrator-state.schema.json",
    description:
      "Persisted job package state (.metaproject/jobs/<name>/state.json), written by `keryx job`.",
    sourcePath: "src/gdskills/bundled/skills/orchestration/job-orchestrator/state.schema.json",
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

/**
 * Validate an in-memory value against an in-memory schema.
 *
 * `validateContractFile` reads both from disk, which makes the conditional
 * keywords above untestable in isolation: a test could only observe them
 * through a real contract, and would then pass or fail for two reasons at once.
 * This is the seam that lets the keyword be pinned on its own.
 */
export async function validateJson(value: unknown, schema: JsonSchema): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  await validateValue(value, schema, "$", errors, schema, new Map());
  return errors;
}

export async function loadSchema(name: ContractName): Promise<JsonSchema> {
  const contract = CONTRACTS.find((entry) => entry.name === name);
  if (!contract) {
    throw new Error(`Unknown contract schema: ${name}`);
  }

  const raw = await readFile(contractPath(contract), "utf8");
  return JSON.parse(raw) as JsonSchema;
}

/**
 * Absolute path of a contract's authoritative schema file.
 *
 * A contract that declares `sourcePath` is resolved there first, from whichever
 * root this module happens to be running under (checked out source, or the
 * packaged build where `src/` sits one level up). Everything else keeps the
 * original `contracts/<fileName>` lookup.
 */
export function contractPath(contract: ContractInfo): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (contract.sourcePath) {
    for (const root of [path.join(here, "..", ".."), path.join(here, ".."), here]) {
      const candidate = path.resolve(root, contract.sourcePath);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const directPath = fileURLToPath(new URL(`./contracts/${contract.fileName}`, import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(here, "..", "src", "gdskills", "contracts", contract.fileName);
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
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

  if ("const" in schema && schema.const !== value) {
    errors.push({
      path: valuePath,
      message: `Expected ${describeValue(schema.const)}`,
    });
  }

  for (const branch of schema.allOf ?? []) {
    await validateValue(value, branch, valuePath, errors, rootSchema, schemaCache);
  }

  if (schema.if) {
    // The `if` subschema is a TEST, not an assertion: its errors decide which
    // branch applies and are then discarded. Collecting them into `errors`
    // would report every non-matching branch as a violation.
    const probe: ValidationError[] = [];
    await validateValue(value, schema.if, valuePath, probe, rootSchema, schemaCache);
    const branch = probe.length === 0 ? schema.then : schema.else;
    if (branch) {
      await validateValue(value, branch, valuePath, errors, rootSchema, schemaCache);
    }
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

  // Any other sibling schema, resolved by filename from the directories that
  // hold one. `reviewer-input.schema.json` has always carried
  // `$ref: review-context.schema.json`, and before this the validator threw on
  // it — so that contract could not be validated at all, and the `$ref` read as
  // enforcement while enforcing nothing.
  //
  // Filename lookup rather than a relative path because a schema is validated
  // from memory as often as from disk (`validateJson`), so there is not always a
  // containing directory to be relative to. The names are unique across these
  // roots; `resolves every sibling ref` in `review-input-fix-round.test.ts`
  // fails if that stops being true.
  if (ref.endsWith(".schema.json") && !ref.includes("..") && !ref.includes("/")) {
    const cached = schemaCache.get(ref);
    if (cached) {
      return cached;
    }

    for (const dir of SCHEMA_ROOTS) {
      const candidate = path.join(dir, ref);
      if (existsSync(candidate)) {
        const schema = JSON.parse(await readFile(candidate, "utf8")) as JsonSchema;
        schemaCache.set(ref, schema);
        return schema;
      }
    }
  }

  throw new Error(`Unsupported schema ref: ${ref}`);
}

/** Directories that hold a resolvable `$ref` target, in precedence order. */
const SCHEMA_ROOTS: string[] = [
  fileURLToPath(new URL("./contracts/", import.meta.url)),
  fileURLToPath(new URL("./bundled/skills/review/review-orchestrator/", import.meta.url)),
];

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

/** Repo-relative path of a contract's authoritative schema file, for listings. */
export function relativeContractPath(contract: ContractInfo): string {
  return contract.sourcePath ?? path.join("src", "gdskills", "contracts", contract.fileName);
}
