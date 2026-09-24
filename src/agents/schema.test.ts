// AC1: the hand-written validator and the real JSON Schema must agree —
// required fields, enums, the `name` pattern, and `additionalProperties` —
// proven by parsing the schema file itself rather than trusting that the two
// were authored to match.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AGENT_ISOLATION_VALUES,
  AGENT_NAME_PATTERN,
  AGENT_ORIGIN_FIELDS,
  AGENT_ORIGIN_KIND_VALUES,
  AGENT_ORIGIN_REQUIRED_FIELDS,
  AGENT_OUTPUT_CONTRACT_VALUES,
  AGENT_REQUIRED_FIELDS,
  AGENT_TOP_LEVEL_FIELDS,
  buildAgentDefinition,
  validateAgentDefinition,
  validateAgentFrontmatter,
} from "./schema";
import { MODEL_TIERS } from "../gdskills/model-tier";

const SCHEMA_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-agent-platform-expansion",
  "schemas",
  "agent-definition.schema.json",
);

interface JsonSchemaLike {
  readonly required: string[];
  readonly additionalProperties: boolean;
  readonly properties: Record<
    string,
    { readonly type?: string; readonly enum?: string[]; readonly pattern?: string; readonly required?: string[]; readonly properties?: Record<string, unknown>; readonly additionalProperties?: boolean }
  >;
}

function loadRealSchema(): JsonSchemaLike {
  const text = readFileSync(SCHEMA_PATH, "utf8");
  return JSON.parse(text) as JsonSchemaLike;
}

describe("agent-definition.schema.json parses and the validator agrees with it (AC1)", () => {
  test("the schema file itself parses as JSON", () => {
    expect(() => loadRealSchema()).not.toThrow();
  });

  test("required fields agree", () => {
    const schema = loadRealSchema();
    const ours: string[] = [...AGENT_REQUIRED_FIELDS];
    expect(ours.sort()).toEqual([...schema.required].sort());
  });

  test("top-level properties agree (additionalProperties: false surface)", () => {
    const schema = loadRealSchema();
    const ours: string[] = [...AGENT_TOP_LEVEL_FIELDS];
    expect(ours.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  test("name pattern agrees", () => {
    const schema = loadRealSchema();
    expect(schema.properties.name?.pattern).toBe(AGENT_NAME_PATTERN.source);
  });

  test("model_tier enum agrees with model-tier.ts's MODEL_TIERS", () => {
    const schema = loadRealSchema();
    expect([...(schema.properties.model_tier?.enum ?? [])].sort()).toEqual([...MODEL_TIERS].sort());
  });

  test("output_contract enum agrees", () => {
    const schema = loadRealSchema();
    expect([...(schema.properties.output_contract?.enum ?? [])].sort()).toEqual(
      [...AGENT_OUTPUT_CONTRACT_VALUES].sort(),
    );
  });

  test("isolation enum agrees", () => {
    const schema = loadRealSchema();
    expect([...(schema.properties.isolation?.enum ?? [])].sort()).toEqual([...AGENT_ISOLATION_VALUES].sort());
  });

  test("origin required/properties/additionalProperties and origin.kind enum agree", () => {
    const schema = loadRealSchema();
    const origin = schema.properties.origin as unknown as {
      readonly required: string[];
      readonly additionalProperties: boolean;
      readonly properties: Record<string, { readonly enum?: string[] }>;
    };
    const ourOriginRequired: string[] = [...AGENT_ORIGIN_REQUIRED_FIELDS];
    expect(ourOriginRequired.sort()).toEqual([...origin.required].sort());
    const ourOriginFields: string[] = [...AGENT_ORIGIN_FIELDS];
    expect(ourOriginFields.sort()).toEqual(Object.keys(origin.properties).sort());
    expect(origin.additionalProperties).toBe(false);
    expect([...(origin.properties.kind?.enum ?? [])].sort()).toEqual([...AGENT_ORIGIN_KIND_VALUES].sort());
  });
});

const VALID_FRONTMATTER = {
  name: "code-explorer",
  description: "Read-only location and cross-reference search. Use for finding where something lives.",
  role: "You locate code and cross-references; you never write.",
  tools: ["read_file", "search_code"],
  model_tier: "light",
  policy_profile: "read-only",
  output_contract: "subagent-result",
};

describe("validateAgentFrontmatter", () => {
  test("accepts a minimal valid definition", () => {
    const result = validateAgentFrontmatter(VALID_FRONTMATTER);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("never throws on non-object input", () => {
    expect(validateAgentFrontmatter(null).ok).toBe(false);
    expect(validateAgentFrontmatter("not an object").ok).toBe(false);
    expect(validateAgentFrontmatter(42).ok).toBe(false);
    expect(validateAgentFrontmatter([1, 2, 3]).ok).toBe(false);
    expect(validateAgentFrontmatter(undefined).ok).toBe(false);
  });

  test("reports every missing required field", () => {
    const result = validateAgentFrontmatter({});
    expect(result.ok).toBe(false);
    const fields = result.errors.filter((e) => e.reason === "missing-required-field").map((e) => e.field).sort();
    expect(fields).toEqual([...AGENT_REQUIRED_FIELDS].sort());
  });

  test("rejects an unknown top-level field (additionalProperties: false)", () => {
    const result = validateAgentFrontmatter({ ...VALID_FRONTMATTER, made_up_field: "x" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason === "unknown-field" && e.field === "made_up_field")).toBe(true);
  });

  test("rejects a name that violates the pattern", () => {
    const result = validateAgentFrontmatter({ ...VALID_FRONTMATTER, name: "Not-Valid" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason === "invalid-name-pattern")).toBe(true);
  });

  test("rejects a model_tier that is a model name, not a tier", () => {
    const result = validateAgentFrontmatter({ ...VALID_FRONTMATTER, model_tier: "claude-opus-5" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "model_tier" && e.reason === "invalid-enum")).toBe(true);
  });

  test("rejects duplicate tools entries", () => {
    const result = validateAgentFrontmatter({ ...VALID_FRONTMATTER, tools: ["read_file", "read_file"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "tools" && e.reason === "duplicate-item")).toBe(true);
  });

  test("rejects an invalid origin.kind", () => {
    const result = validateAgentFrontmatter({ ...VALID_FRONTMATTER, origin: { kind: "borrowed" } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "origin.kind" && e.reason === "origin-invalid-enum")).toBe(true);
  });

  test("rejects an unknown origin field", () => {
    const result = validateAgentFrontmatter({ ...VALID_FRONTMATTER, origin: { kind: "authored", bogus: 1 } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "origin.bogus" && e.reason === "origin-unknown-field")).toBe(true);
  });

  test("accepts a fully-populated definition, defaults included", () => {
    const result = validateAgentFrontmatter({
      ...VALID_FRONTMATTER,
      schema_version: 1,
      skills: ["find-docs"],
      stacks: ["typescript"],
      isolation: "worktree",
      origin: { kind: "generated", sourceRef: "typescript", generatedAt: "2026-09-24T00:00:00.000Z" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("buildAgentDefinition", () => {
  test("applies schema defaults for skills/stacks/isolation", () => {
    const definition = buildAgentDefinition(VALID_FRONTMATTER, "Body text.");
    expect(definition.skills).toEqual([]);
    expect(definition.stacks).toEqual([]);
    expect(definition.isolation).toBe("none");
    expect(definition.body).toBe("Body text.");
    expect(definition.name).toBe("code-explorer");
  });
});

describe("validateAgentDefinition", () => {
  test("validates a built AgentDefinition (body stripped before checking additionalProperties)", () => {
    const definition = buildAgentDefinition(VALID_FRONTMATTER, "Body text.");
    const result = validateAgentDefinition(definition);
    expect(result.ok).toBe(true);
  });
});
