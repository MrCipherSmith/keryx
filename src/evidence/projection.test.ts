import { expect, test } from "bun:test";
import path from "node:path";
import { validateAgainstSchema } from "../contracts/validator";
import { chunkFileEvidence } from "./file-chunks";
import { projectEvidenceSearch } from "./projection";
const schemaDir = path.resolve(import.meta.dir, "../../docs/requirements/keryx-evidence-retrieval/schemas");
const chunk = chunkFileEvidence({ sourceId: "s", sourcePath: "docs/a", versionHash: "a".repeat(64),
  text: "evidence", fileProjection: { redaction: "not-needed", originalByteLength: 8, originalLineCount: 1 } })[0]!;
const ranked = { ...chunk, score: 0.5 };
const validate = (value: unknown) => validateAgainstSchema("search-result.schema.json", value, { schemaDir }).valid;
test("public projection is closed and contains original citations and lexical score", () => {
  const result = projectEvidenceSearch({ code: "ok", generation: "g", items: [ranked] });
  expect(validate(result)).toBe(true);
  expect(result.items[0]?.score).toBe(0.5);
  expect(result.items[0]?.locator).toEqual(chunk.locator);
  expect("startByte" in result.items[0]!).toBe(false);
  expect("reason" in result).toBe(false);
});
test("no-match, packing refusal and internal corruption have distinct public codes", () => {
  const empty = projectEvidenceSearch({ code: "ok", generation: "g", items: [] });
  expect(empty.code).toBe("no-match"); expect(validate(empty)).toBe(true);
  const packed = projectEvidenceSearch({ code: "ok", generation: "g", items: [ranked] }, 1);
  expect(packed.code).toBe("budget-exceeded"); expect(packed.items).toEqual([]); expect(validate(packed)).toBe(true);
  const corrupt = projectEvidenceSearch({ code: "index-corrupt", items: [] });
  expect(corrupt.diagnostics).toEqual(["index-corrupt"]); expect(validate(corrupt)).toBe(true);
});
test("packing omissions preserve full source coverage but cannot become ordinary no-match", () => {
  const partial = projectEvidenceSearch({ code: "ok", generation: "g", items: [ranked], packingOmitted: true });
  expect(partial.coverage).toBe("full"); expect(partial.diagnostics).toEqual(["packing-budget"]); expect(validate(partial)).toBe(true);
  const empty = projectEvidenceSearch({ code: "ok", generation: "g", items: [], packingOmitted: true });
  expect(empty.code).toBe("budget-exceeded"); expect(validate(empty)).toBe(true);
});
test("missing verified citation or invalid score fails closed", () => {
  for (const item of [{ ...ranked, score: Infinity }, { ...ranked, locator: undefined }]) {
    const result = projectEvidenceSearch({ code: "ok", generation: "g", items: [item as typeof ranked] });
    expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]); expect(validate(result)).toBe(true);
  }
});
test("post-load refusals retain the pinned generation and unknown coverage", () => {
  for (const result of [
    projectEvidenceSearch({ code: "source-unavailable", generation: "g", reason: "stale-source", items: [] }),
    projectEvidenceSearch({ code: "ok", generation: "g", items: [ranked] }, 1),
  ]) {
    expect(result.generation).toBe("g"); expect(result.coverage).toBe("unknown");
    expect(result.items).toEqual([]); expect(validate(result)).toBe(true);
  }
});

test("query refusal reports query-budget before generation load", () => {
  const result = projectEvidenceSearch({ code: "budget-exceeded", items: [] });
  expect(result.generation).toBeNull(); expect(result.diagnostics).toEqual(["query-budget"]);
  expect(validate(result)).toBe(true);
});
