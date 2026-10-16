// `keryx review ingest --premises` input (flow 459): the bare claims object, or a reply/report holding it in one
// ```json keryx:premises block (what the review-premise skill prints).

import { describe, expect, test } from "bun:test";
import { parseEmbeddedPremises } from "./managed";
import { parsePremiseClaims } from "./premise";

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
