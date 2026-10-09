import { describe, expect, test } from "bun:test";
import { classifyRoundNeed } from "./round-need";

const DOCS_ONLY = ["README.md", "docs/guide/setup.md", "CHANGELOG.md", "bun.lock"];
const CODE = ["src/review/caps.ts", "README.md"];

describe("classifyRoundNeed", () => {
  test("a docs-only diff needs no round and names the reason", () => {
    const need = classifyRoundNeed({ files: DOCS_ONLY });
    expect(need.needed).toBe(false);
    expect(need.reason).toContain("docs");
  });

  test("a diff with code needs a round", () => {
    expect(classifyRoundNeed({ files: CODE })).toEqual({ needed: true, reason: "code or rule-bearing files in the diff" });
  });

  test.each([
    ["src/build/index.ts"],
    ["scripts/build/release.ts"],
    ["requirements.txt"],
    ["constraints.txt"],
    ["CMakeLists.txt"],
    [".claude/agents/reviewer.md"],
    [".claude/commands/ship.md"],
    [".metaproject/skills/x/references/a.md"],
    ["GEMINI.md"],
    [".github/copilot-instructions.md"],
    ["skills/foo/skill.md"],
  ])("%s fails open: it needs a round", (file) => {
    expect(classifyRoundNeed({ files: [file] }).needed).toBe(true);
  });

  test.each([["dist/app.js"], ["coverage/lcov.info"], ["src/__generated__/types.ts"]])(
    "%s is machine-written and needs no round",
    (file) => {
      expect(classifyRoundNeed({ files: [file] }).needed).toBe(false);
    },
  );

  test.each([
    [".github/workflows/ci.yml"],
    ["db/migrations/0042_add_column.sql"],
    ["src/auth/session.ts"],
    ["package.json"],
    ["tsconfig.json"],
  ])("%s is never treated as docs", (file) => {
    expect(classifyRoundNeed({ files: ["README.md", file] }).needed).toBe(true);
  });

  test("--all, an explicit reviewer list or a gating round forces a round on a docs-only diff", () => {
    expect(classifyRoundNeed({ files: DOCS_ONLY, all: true }).needed).toBe(true);
    expect(classifyRoundNeed({ files: DOCS_ONLY, explicitReviewers: ["review-style"] }).needed).toBe(true);
    expect(classifyRoundNeed({ files: DOCS_ONLY, gating: true }).needed).toBe(true);
  });

  test("an empty diff needs no round", () => {
    expect(classifyRoundNeed({ files: [] }).needed).toBe(false);
  });
});
