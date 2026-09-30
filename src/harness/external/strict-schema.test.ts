import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSchema, validateJson } from "../../gdskills/contracts";
import { dropOptionalNulls, toStrictOutputSchema } from "./strict-schema";

type Schema = Record<string, unknown>;

const ORIGINAL: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Doc",
  type: "object",
  additionalProperties: true,
  required: ["id", "note"],
  properties: {
    id: { type: "string", minLength: 1, pattern: "^a" },
    note: { type: ["string", "null"] },
    kind: { type: "string", enum: ["a", "b"] },
    count: { type: "integer", minimum: 0, default: 0 },
    mode: { const: "x" },
    child: { $ref: "#/$defs/child" },
    tags: { type: "array", items: { type: "object", required: ["k"], properties: { k: { type: "string" }, v: { type: "string" } } } },
  },
  allOf: [{ if: { required: ["kind"] }, then: { required: ["count"] } }],
  $defs: { child: { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "string" }, m: { type: "string" } } } },
};

function everyObject(node: unknown, visit: (n: Schema) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) everyObject(item, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const schema = node as Schema;
  visit(schema);
  for (const value of Object.values(schema)) everyObject(value, visit);
}

describe("toStrictOutputSchema", () => {
  test("lists every property in required and closes every object", () => {
    const strict = toStrictOutputSchema(ORIGINAL);
    let objects = 0;
    everyObject(strict, (n) => {
      if (n.properties === undefined) return;
      objects += 1;
      expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      expect(n.additionalProperties).toBe(false);
    });
    expect(objects).toBe(3);
  });

  test("an optional property becomes nullable, a required one does not", () => {
    const props = toStrictOutputSchema(ORIGINAL).properties as Record<string, Schema>;
    expect(props.id?.type).toBe("string");
    expect(props.note?.type).toEqual(["string", "null"]);
    expect(props.kind?.type).toEqual(["string", "null"]);
    expect(props.kind?.enum).toEqual(["a", "b", null]);
    expect(props.child).toEqual({ anyOf: [{ $ref: "#/$defs/child" }, { type: "null" }] });
    const tag = (props.tags?.items as Schema).properties as Record<string, Schema>;
    expect(tag.v?.type).toEqual(["string", "null"]);
  });

  test("removes the keywords the validator refuses and turns const into enum", () => {
    const text = JSON.stringify(toStrictOutputSchema(ORIGINAL));
    for (const word of ["allOf", '"if"', '"then"', "pattern", "minLength", "minimum", "default", "title", "$schema", "const"]) {
      expect(text).not.toContain(word);
    }
    expect((toStrictOutputSchema(ORIGINAL).properties as Record<string, Schema>).mode?.enum).toEqual(["x", null]);
  });

  test("keeps a local $defs and never mutates its input", () => {
    const before = JSON.stringify(ORIGINAL);
    const strict = toStrictOutputSchema(ORIGINAL);
    expect(JSON.stringify(ORIGINAL)).toBe(before);
    expect(Object.keys(strict.$defs as object)).toEqual(["child"]);
  });
});

describe("dropOptionalNulls", () => {
  test("removes a null on a property the schema never required, at every depth and through $ref", () => {
    const out = dropOptionalNulls(
      { id: "a", note: null, kind: null, child: { n: "x", m: null }, tags: [{ k: "k", v: null }] },
      ORIGINAL,
    );
    expect(out).toEqual({ id: "a", note: null, child: { n: "x" }, tags: [{ k: "k" }] });
  });

  test("keeps a null on a required property so validation still fails on it", async () => {
    const out = dropOptionalNulls({ id: null, note: null }, ORIGINAL) as Record<string, unknown>;
    expect(out).toEqual({ id: null, note: null });
  });

  test("keeps a null on a key the schema does not declare, so the full schema can still reject it", () => {
    expect(dropOptionalNulls({ id: "a", note: null, bogus: null }, ORIGINAL)).toEqual({ id: "a", note: null, bogus: null });
  });

  test("never mutates its input", () => {
    const input = { id: "a", note: null, kind: null };
    dropOptionalNulls(input, ORIGINAL);
    expect(input).toEqual({ id: "a", note: null, kind: null });
  });
});

describe("the real subagent-result schema", () => {
  const dir = fileURLToPath(new URL("../../gdskills/contracts/", import.meta.url));
  const read = (name: string): Schema => JSON.parse(readFileSync(dir + name, "utf8")) as Schema;
  const finding = read("review-finding.schema.json");
  const result = read("subagent-result.schema.json");
  const bundled: Schema = JSON.parse(JSON.stringify(result));
  (bundled.properties as Record<string, Schema>).findings = { type: "array", items: finding };

  test("every object in the strict copy is closed and fully required", () => {
    let objects = 0;
    everyObject(toStrictOutputSchema(bundled), (n) => {
      if (n.properties === undefined) return;
      objects += 1;
      expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      expect(n.additionalProperties).toBe(false);
    });
    expect(objects).toBeGreaterThan(8);
  });

  test("a document shaped by the strict copy validates against the full schema once optional nulls are dropped", async () => {
    const strictDoc = {
      contract_version: "1.0.0",
      run_id: "r",
      dispatch_id: "d",
      status: "DONE",
      summary: "s",
      summary_markdown: null,
      acceptance: [{ criterion: "c", status: "met", evidence: null }],
      artifacts: [{ path: "p", kind: "diff", exists: true, summary: null, hash: null }],
      changed_files: [],
      findings: [],
      questions: [{ id: "q", question: "?", why: "w", options: null, can_be_resolved_by_agent: null }],
      errors: [{ type: "unknown", message: "m", detail: null }],
      metrics: { duration_ms: null, prompt_tokens: null, output_tokens: null, retries: null },
      timestamp_utc: "2026-09-30T00:00:00Z",
    };
    const cleaned = dropOptionalNulls(strictDoc, bundled);
    expect(await validateJson(cleaned, await loadSchema("subagent-result"))).toEqual([]);
    expect(await validateJson({ ...(cleaned as object), run_id: null }, await loadSchema("subagent-result"))).not.toEqual([]);
  });

  test("a populated minor finding with every optional field null validates; an undeclared null key does not", async () => {
    const finding = {
      id: "F-001",
      reviewer: "r",
      severity: "minor",
      problem: "p",
      impact: "i",
      suggested_fix: "f",
      evidence: "e",
      confidence: "high",
      file: "a.ts",
      line: 1,
      quote: "q",
      class_scope: null,
    };
    const doc = {
      contract_version: "1.0.0",
      run_id: "r",
      dispatch_id: "d",
      status: "DONE",
      summary: "s",
      acceptance: [],
      artifacts: [],
      changed_files: [],
      findings: [finding],
      questions: [],
      errors: [],
      metrics: {},
      timestamp_utc: "2026-09-30T00:00:00Z",
    };
    const schema = await loadSchema("subagent-result");
    const cleaned = dropOptionalNulls(doc, bundled);
    expect(await validateJson(cleaned, schema)).toEqual([]);
    expect(await validateJson(dropOptionalNulls({ ...doc, bogus: null }, bundled), schema)).not.toEqual([]);
  });
});
