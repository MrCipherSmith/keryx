import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEGRADATION_NO_EVIDENCE_RULE } from "../review/degradation";
import { REVIEW_DEGRADATION_CLASSES, REVIEW_EVIDENCE_KINDS } from "../review/types";

const ROOT = path.resolve(import.meta.dir, "../..");

/** The finding schemas that carry the degradation fields: the contract and the orchestrator's reviewer schema, each in its two homes. */
const FINDING_SCHEMAS = {
  "src contract": "src/gdskills/contracts/review-finding.schema.json",
  "project contract": ".metaproject/core/gdskills/contracts/review-finding.schema.json",
  "bundled reviewer schema": "src/gdskills/bundled/skills/review/review-orchestrator/reviewer-finding.schema.json",
  "project reviewer schema": ".metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json",
} as const;

type SchemaNode = { [key: string]: unknown };

/** Every `properties.<name>` object anywhere in the schema, so the test does not depend on where a copy nests the finding. */
function propertiesNamed(node: unknown, name: string, found: SchemaNode[] = []): SchemaNode[] {
  if (Array.isArray(node)) {
    for (const entry of node) propertiesNamed(entry, name, found);
  } else if (node !== null && typeof node === "object") {
    const record = node as SchemaNode;
    const properties = record.properties;
    if (properties !== null && typeof properties === "object" && name in (properties as SchemaNode)) {
      found.push((properties as SchemaNode)[name] as SchemaNode);
    }
    for (const value of Object.values(record)) propertiesNamed(value, name, found);
  }
  return found;
}

function load(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
}

describe("flow 479: the degradation enums are one list in every schema copy", () => {
  for (const [label, relative] of Object.entries(FINDING_SCHEMAS)) {
    describe(label, () => {
      const schema = load(relative);

      test("degradation_class is exactly REVIEW_DEGRADATION_CLASSES", () => {
        const nodes = propertiesNamed(schema, "degradation_class");
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) expect(node.enum).toEqual([...REVIEW_DEGRADATION_CLASSES]);
      });

      test("evidence_kind is exactly REVIEW_EVIDENCE_KINDS", () => {
        const nodes = propertiesNamed(schema, "evidence_kind");
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) expect(node.enum).toEqual([...REVIEW_EVIDENCE_KINDS]);
      });
    });
  }

  for (const label of ["src contract", "project contract"] as const) {
    test(`${label}: evidence_screen names the one rule and the two severities the screen lowers`, () => {
      const nodes = propertiesNamed(load(FINDING_SCHEMAS[label]), "evidence_screen");
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        const inner = node.properties as { rule: SchemaNode; original_severity: SchemaNode };
        expect(inner.rule.const).toBe(DEGRADATION_NO_EVIDENCE_RULE);
        expect(inner.original_severity.enum).toEqual(["blocker", "major"]);
      }
    });
  }

  test("the two copies of each schema are byte-identical", () => {
    const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
    expect(read(FINDING_SCHEMAS["project contract"])).toBe(read(FINDING_SCHEMAS["src contract"]));
    expect(read(FINDING_SCHEMAS["project reviewer schema"])).toBe(read(FINDING_SCHEMAS["bundled reviewer schema"]));
  });
});
