import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EDIT_GUARD_MAX_CALLS,
  DEFAULT_EDIT_GUARD_THRESHOLD,
  DEFAULT_EDIT_GUARD_TIMEOUT_MS,
  filePathFromToolInput,
  findingClauseLabel,
  isEditGuardToolName,
  MAX_EDIT_GUARD_FEEDBACK_FINDINGS,
  renderEditGuardFeedback,
  renderEditGuardFindingLine,
} from "./jev-edit-guard";

describe("jev-edit-guard defaults", () => {
  test("threshold defaults to 0.5 — precision over recall, per the measured numbers", () => {
    expect(DEFAULT_EDIT_GUARD_THRESHOLD).toBe(0.5);
  });
  test("has a small per-run call budget and a short hard timeout", () => {
    expect(DEFAULT_EDIT_GUARD_MAX_CALLS).toBeGreaterThan(0);
    expect(DEFAULT_EDIT_GUARD_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("isEditGuardToolName", () => {
  test("accepts Edit/Write/MultiEdit", () => {
    expect(isEditGuardToolName("Edit")).toBe(true);
    expect(isEditGuardToolName("Write")).toBe(true);
    expect(isEditGuardToolName("MultiEdit")).toBe(true);
  });
  test("rejects any other tool", () => {
    expect(isEditGuardToolName("Bash")).toBe(false);
    expect(isEditGuardToolName("Read")).toBe(false);
    expect(isEditGuardToolName("")).toBe(false);
  });
});

describe("filePathFromToolInput", () => {
  test("reads a string file_path", () => {
    expect(filePathFromToolInput({ file_path: "src/a.ts" })).toBe("src/a.ts");
  });
  test("undefined for a missing/non-string file_path, or a non-object input", () => {
    expect(filePathFromToolInput({})).toBeUndefined();
    expect(filePathFromToolInput({ file_path: 42 })).toBeUndefined();
    expect(filePathFromToolInput(null)).toBeUndefined();
    expect(filePathFromToolInput("not an object")).toBeUndefined();
  });
});

describe("findingClauseLabel", () => {
  test("splits ruleId::clauseId::file into ruleId#clauseId", () => {
    expect(findingClauseLabel("rules/core/foo.mdc::heading-1::src/a.ts")).toBe("rules/core/foo.mdc#heading-1");
  });
  test("falls back to the raw key when it does not split", () => {
    expect(findingClauseLabel("not-a-dedupe-key")).toBe("not-a-dedupe-key");
  });
});

describe("renderEditGuardFindingLine / renderEditGuardFeedback", () => {
  const finding = { dedupe_key: "rules/core/foo.mdc::heading-1::src/a.ts", file: "src/a.ts", line: 12, severity: "minor" };

  test("matches the documented example verbatim", () => {
    expect(renderEditGuardFindingLine(finding)).toBe(
      "Rule check flagged: rules/core/foo.mdc#heading-1 at src/a.ts:12 — fix it if it is a real violation.",
    );
  });

  test("undefined (silent) when there are no findings", () => {
    expect(renderEditGuardFeedback([])).toBeUndefined();
  });

  test("one line per finding, up to the cap, plus an omitted-count line beyond it", () => {
    const many = Array.from({ length: MAX_EDIT_GUARD_FEEDBACK_FINDINGS + 3 }, (_, i) => ({
      ...finding,
      dedupe_key: `rules/core/foo.mdc::heading-${i}::src/a.ts`,
      line: i + 1,
    }));
    const text = renderEditGuardFeedback(many);
    expect(text).toBeDefined();
    const lines = text!.split("\n");
    expect(lines).toHaveLength(MAX_EDIT_GUARD_FEEDBACK_FINDINGS + 1);
    expect(lines.at(-1)).toContain("3 more finding(s)");
  });

  test("no omitted-count line when everything fits", () => {
    const text = renderEditGuardFeedback([finding]);
    expect(text).toBe(renderEditGuardFindingLine(finding));
  });
});
