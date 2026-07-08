import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import {
  METAPROJECT_SCHEMA,
  MODULE_SCHEMA,
  SCHEMA_REGISTRY,
  type JsonSchema,
} from "./schemas";
import { evaluateProfiles } from "./profiles";
import type {
  Issue,
  MetaprojectManifest,
  ModuleManifestEntry,
  ValidationResult,
} from "./types";

// ---------------------------------------------------------------------------
// Generic JSON-Schema (draft 2020-12 subset) validator.
//
// Adapted from src/gdskills/contracts.ts `validateValue`, extended with the two
// features the standard schemas need that the contracts validator lacks:
//   - `anyOf` (module.schema.json requires one of data/core/skills/...);
//   - `format: date-time` (metaproject.schema.json `updatedAt`).
// Runs synchronously against the bundled schemas (no file/network I/O) and
// resolves named external refs (`module.schema.json`) through SCHEMA_REGISTRY.
// ---------------------------------------------------------------------------

type SchemaError = { path: string; message: string };

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
    // Switch the root so nested `#/$defs` refs resolve within the target schema.
    return { schema: external, root: external };
  }

  throw new Error(`Unsupported schema ref: ${ref}`);
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  rootSchema: JsonSchema,
): SchemaError[] {
  const errors: SchemaError[] = [];
  walk(value, schema, "$", rootSchema, errors);
  return errors;
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
    const expected = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
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

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: valuePath, message: `Expected number >= ${schema.minimum}` });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: valuePath, message: `Expected string length >= ${schema.minLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: valuePath, message: `Expected string to match pattern ${schema.pattern}` });
    }
    if (schema.format === "date-time" && !DATE_TIME_PATTERN.test(value)) {
      errors.push({ path: valuePath, message: "Expected an ISO 8601 date-time string" });
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, index) => {
        walk(item, schema.items as JsonSchema, `${valuePath}[${index}]`, rootSchema, errors);
      });
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push({ path: valuePath, message: "Expected array items to be unique" });
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push({ path: `${valuePath}.${key}`, message: "Missing required property" });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, nested] of Object.entries(value)) {
      const nestedSchema = properties[key];
      if (nestedSchema) {
        walk(nested, nestedSchema, `${valuePath}.${key}`, rootSchema, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${valuePath}.${key}`, message: "Additional property is not allowed" });
      } else if (isPlainObject(schema.additionalProperties)) {
        walk(nested, schema.additionalProperties, `${valuePath}.${key}`, rootSchema, errors);
      }
    }
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    const passes = schema.anyOf.some(
      (branch) => validateBranch(value, branch, rootSchema).length === 0,
    );
    if (!passes) {
      errors.push({
        path: valuePath,
        message: "Value does not match any of the required property combinations",
      });
    }
  }
}

function validateBranch(value: unknown, schema: JsonSchema, rootSchema: JsonSchema): SchemaError[] {
  const errors: SchemaError[] = [];
  walk(value, schema, "$", rootSchema, errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Workspace validation (specification.md §11).
// ---------------------------------------------------------------------------

const ROOT_ENTRYPOINTS = ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"];
const INDEX_LINK = ".metaproject/index.md";
const MODULE_PATH_FIELDS: Array<keyof ModuleManifestEntry> = [
  "core",
  "data",
  "wiki",
  "memory",
  "skills",
  "projectSkills",
];

function issue(code: string, message: string, fix?: string): Issue {
  return fix === undefined ? { code, message } : { code, message, fix };
}

// A copy of the manifest schema that skips per-module descent; enabled modules
// are validated separately so disabled `{ enabled: false }` stubs (which init
// legitimately writes) are not held to the full module contract.
const MANIFEST_TOP_LEVEL_SCHEMA: JsonSchema = {
  ...METAPROJECT_SCHEMA,
  properties: {
    ...METAPROJECT_SCHEMA.properties,
    modules: { type: "object", additionalProperties: true },
  },
};

export async function validateWorkspace(cwd: string): Promise<ValidationResult> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const metaprojectRoot = path.join(cwd, ".metaproject");

  // 1. Required root files.
  const requiredFiles = ["index.md", "README.md", "metaproject.json"];
  for (const file of requiredFiles) {
    if (!(await pathExists(path.join(metaprojectRoot, file)))) {
      errors.push(
        issue(
          "missing-required-file",
          `Required file .metaproject/${file} is missing`,
          `Run \`keryx init\` to scaffold .metaproject/${file}.`,
        ),
      );
    }
  }

  // 2. Required core directories.
  const requiredDirs = ["modules", "rules", "skills", "data"];
  for (const dir of requiredDirs) {
    if (!(await pathExists(path.join(metaprojectRoot, dir)))) {
      errors.push(
        issue(
          "missing-required-dir",
          `Required directory .metaproject/${dir}/ is missing`,
          `Run \`keryx init\` to create .metaproject/${dir}/.`,
        ),
      );
    }
  }

  // Without a readable manifest the remaining checks cannot run.
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return { ok: errors.length === 0, errors, warnings };
  }

  let manifest: MetaprojectManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(
      issue(
        "invalid-manifest-json",
        `.metaproject/metaproject.json is not valid JSON: ${detail}`,
        "Fix the JSON syntax or regenerate it with `keryx init`.",
      ),
    );
    return { ok: false, errors, warnings };
  }

  // 3. Manifest matches metaproject.schema (top-level fields + types).
  for (const schemaError of validateAgainstSchema(
    manifest,
    MANIFEST_TOP_LEVEL_SCHEMA,
    MANIFEST_TOP_LEVEL_SCHEMA,
  )) {
    errors.push(
      issue(
        "manifest-schema",
        `metaproject.json ${schemaError.path.replace(/^\$\.?/, "") || "(root)"}: ${schemaError.message}`,
        "Regenerate metaproject.json with `keryx init` so required standard fields are present.",
      ),
    );
  }

  // 3b. Each enabled module matches module.schema (enabled, manifest, anyOf).
  const modules = manifest.modules ?? {};
  for (const [key, entry] of Object.entries(modules)) {
    if (entry?.enabled !== true) {
      if (entry && typeof entry.enabled !== "boolean") {
        errors.push(
          issue(
            "module-schema",
            `module "${key}": "enabled" must be a boolean`,
            `Set modules.${key}.enabled to true or false in metaproject.json.`,
          ),
        );
      }
      continue;
    }
    for (const schemaError of validateAgainstSchema(entry, MODULE_SCHEMA, MODULE_SCHEMA)) {
      errors.push(
        issue(
          "module-schema",
          `module "${key}" ${schemaError.path.replace(/^\$\.?/, "") || "(root)"}: ${schemaError.message}`,
          `Fix the modules.${key} entry in metaproject.json.`,
        ),
      );
    }
  }

  // 4. Declared top-level paths exist.
  if (isPlainObject(manifest.paths)) {
    for (const [key, value] of Object.entries(manifest.paths)) {
      if (typeof value !== "string") {
        continue;
      }
      if (!(await pathExists(path.join(cwd, value)))) {
        errors.push(
          issue(
            "missing-declared-path",
            `Declared path paths.${key} -> ${value} does not exist`,
            `Create ${value} or remove paths.${key} from metaproject.json.`,
          ),
        );
      }
    }
  }

  // 5 + 6. Enabled modules: manifest markdown and declared data/path fields exist.
  for (const [key, entry] of Object.entries(modules)) {
    if (entry?.enabled !== true) {
      continue;
    }
    if (typeof entry.manifest === "string") {
      if (!(await pathExists(path.join(cwd, entry.manifest)))) {
        errors.push(
          issue(
            "missing-module-manifest",
            `Enabled module "${key}" manifest ${entry.manifest} is missing`,
            `Create ${entry.manifest} or run \`keryx update\` to regenerate module manifests.`,
          ),
        );
      }
    }
    for (const field of MODULE_PATH_FIELDS) {
      const value = entry[field];
      if (typeof value !== "string") {
        continue;
      }
      if (!(await pathExists(path.join(cwd, value)))) {
        // `data/<module>/` directories are generated lazily on first module run
        // and are frequently gitignored (see artifact-lifecycle.md), so a missing
        // data dir is a warning, not a compliance error. Canonical path fields
        // (core/skills/wiki/memory/projectSkills) remain hard errors.
        const sink = field === "data" ? warnings : errors;
        sink.push(
          issue(
            "missing-module-path",
            `Module "${key}" declares ${String(field)} ${value}, which does not exist`,
            field === "data"
              ? `Run the module (e.g. \`keryx ${key} ...\`) to generate ${value}, or update modules.${key}.data in metaproject.json.`
              : `Create ${value} or update modules.${key}.${String(field)} in metaproject.json.`,
          ),
        );
      }
    }
  }

  // 7. Root agent entrypoints (when present) link .metaproject/index.md.
  for (const name of ROOT_ENTRYPOINTS) {
    const filePath = path.join(cwd, name);
    if (!(await pathExists(filePath))) {
      continue;
    }
    const content = await readFile(filePath, "utf8");
    if (!content.includes(INDEX_LINK)) {
      errors.push(
        issue(
          "entrypoint-missing-index-link",
          `Root entrypoint ${name} does not link ${INDEX_LINK}`,
          `Add a reference to ${INDEX_LINK} in ${name} (\`keryx rules sync\` does this).`,
        ),
      );
    }
  }

  // 8. Profile requirements: declared vs satisfied (advisory).
  const profileEval = await evaluateProfiles(cwd, manifest);
  for (const profile of profileEval.unsatisfiedDeclared) {
    warnings.push(
      issue(
        "profile-not-satisfied",
        `Manifest declares profile "${profile}" but the workspace does not satisfy it`,
        `Meet the "${profile}" profile requirements or remove it from profiles in metaproject.json.`,
      ),
    );
  }
  for (const profile of profileEval.undeclaredSatisfied) {
    warnings.push(
      issue(
        "profile-undeclared",
        `Workspace satisfies profile "${profile}" but it is not declared in the manifest`,
        `Add "${profile}" to profiles in metaproject.json (\`keryx update\` recomputes it).`,
      ),
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
