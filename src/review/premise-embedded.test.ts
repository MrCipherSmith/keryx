// `keryx review ingest --premises` input (flow 459): the bare claims object, or a reply/report holding it in one
// ```json keryx:premises block (what the review-premise skill prints).

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEmbeddedPremises } from "./managed";
import { mergePremises, parsePremiseClaims } from "./premise";
import type { StructuredReviewFinding } from "./types";

describe("the shipped review-premise skill's example (review testing F-006)", () => {
  for (const root of ["src/gdskills/bundled/skills", ".metaproject/skills/gdskills"]) {
    test(`${root}: the documented keryx:premises block parses and merges with no rejection`, async () => {
      const file = path.join(import.meta.dir, "..", "..", root, "review", "review-premise", "SKILL.md");
      const parsed = parsePremiseClaims(parseEmbeddedPremises(await readFile(file, "utf8"), file));
      const finding = (id: string): StructuredReviewFinding => ({ id, reviewer: "review-logic", severity: "major", problem: `problem ${id}`, impact: "i", suggested_fix: "f", evidence: "e", confidence: "high" });
      const merged = mergePremises([finding("LY-003"), finding("LG-002"), finding("LG-004")], parsed);
      expect(merged.rejections).toEqual([]);
      expect(merged.counts).toMatchObject({ claims: 3, applied: 3, challenged: 1, downgraded: 1, upheld: 1 });
    });
  }
});

const claims = { judge: "review-premise", model: "m", premises: [{ finding_id: "LY-003", verdict: "challenged", question: "mirror it?", practice_sources: [{ name: "Material", says: "media controls do not mirror" }] }] };
const FENCE = "```";

describe("parseEmbeddedPremises", () => {
  test("a bare JSON object is read as it is", () => {
    expect(parseEmbeddedPremises(JSON.stringify(claims), "--premises x")).toEqual(claims);
  });

  test("a report carrying one keryx:premises block yields that block", () => {
    const report = `# Premise review\n\nSome prose, with {braces}.\n\n${FENCE}json keryx:premises\n${JSON.stringify(claims, null, 2)}\n${FENCE}\n\nTrailing prose.\n`;
    const parsed = parseEmbeddedPremises(report, "--premises r.md");
    expect(parsed).toEqual(claims);
    expect(parsePremiseClaims(parsed)?.claims).toHaveLength(1);
  });

  test("an indented fence and a tilde fence are found too", () => {
    expect(parseEmbeddedPremises(`  ${FENCE}json keryx:premises\n${JSON.stringify(claims)}\n  ${FENCE}\n`, "x")).toEqual(claims);
    expect(parseEmbeddedPremises(`~~~json keryx:premises\n${JSON.stringify(claims)}\n~~~\n`, "x")).toEqual(claims);
  });

  test("two blocks, a block that is not JSON, and prose with no block are errors that say nothing was merged", () => {
    const block = `${FENCE}json keryx:premises\n${JSON.stringify(claims)}\n${FENCE}\n`;
    expect(() => parseEmbeddedPremises(`${block}\n${block}`, "--premises r.md")).toThrow(/2 keryx:premises blocks.*Nothing was merged/);
    expect(() => parseEmbeddedPremises(`${FENCE}json keryx:premises\n{ nope\n${FENCE}\n`, "--premises r.md")).toThrow(/keryx:premises block that is not valid JSON.*Nothing was merged/);
    expect(() => parseEmbeddedPremises("just a report", "--premises r.md")).toThrow(/neither JSON nor a report with a keryx:premises block/);
  });

  test("a keryx:findings block is not mistaken for premises", () => {
    expect(() => parseEmbeddedPremises(`${FENCE}json keryx:findings\n[]\n${FENCE}\n`, "--premises r.md")).toThrow(/neither JSON/);
  });
});
