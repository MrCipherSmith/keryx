import { describe, expect, test } from "bun:test";
import { classifyRoundNeed } from "./round-need";

const DOCS_ONLY = ["README.md", "docs/guide/setup.md", "CHANGELOG.md", ".metaproject/flows/1-x/journal.md"];
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
    ["src/gdskills/bundled/agents/security-auditor.md"],
    ["src/gdskills/bundled/skills/review/review-orchestrator/references/x.md"],
    [".opencode/agent/a.md"],
    [".kiro/steering/a.md"],
    [".github/instructions/a.instructions.md"],
    [".github/prompts/a.prompt.md"],
    [".github/workflows/a.md"],
    [".metaproject/index.md"],
    [".metaproject/modules/tasks.md"],
    [".metaproject/data/testing/context.md"],
    ["rules/core/x.md"],
    ["CLAUDE.md"],
    ["AGENTS.md"],
    ["bun.lock"],
    ["package-lock.json"],
    ["dist/app.js"],
    ["docs/CLAUDE.md"],
    ["docs/AGENTS.md"],
    ["docs/.claude/commands/x.md"],
    ["docs/skills/x/SKILL.md"],
    ["docs/skills/x/references/a.md"],
    ["docs/prompts/review.md"],
    ["CLAUDE.local.md"],
    ["AGENTS.override.md"],
    ["QWEN.md"],
    ["CONVENTIONS.md"],
    ["copilot-instructions.md"],
    ["docs/x.instructions.md"],
    ["docs/x.prompt.md"],
    [".metaproject/wiki/.claude/x.md"],
    [".metaproject/flows/1-x/.claude/x.md"],
    ["docs/.cursor/rules/a.md"],
    [".claude/agents/__generated__/a.md"],
    ["src/auth/__generated__/guard.ts"],
    ["src/__generated__/types.ts"],
    ["migrations/__generated__/001.sql"],
    [".github/workflows/__generated__/x.yml"],
    ["coverage/x.sh"],
    ["coverage/x.js"],
    ["docs\\CLAUDE.md"],
    ["docs\\guide.md"],
    ["docs/../src/auth/session.ts"],
    ["docs/../CLAUDE.md"],
    ["./docs/guide.md"],
    ["/docs/guide.md"],
    ["docs//guide.md"],
    ["docs/./guide.md"],
    ["NOTES.md"],
    ["packages/app/NOTES.md"],
    [""],
  ])("%s fails open: it needs a round", (file) => {
    expect(classifyRoundNeed({ files: [file] }).needed).toBe(true);
  });

  test.each([
    ["coverage/lcov.info"],
    ["coverage/index.html"],
    ["src/__generated__/schema.json"],
    ["src/__generated__/types.js.map"],
    ["README.md"],
    ["readme"],
    ["LICENSE"],
    ["SECURITY.md"],
    ["CONTRIBUTING.md"],
    ["CODE_OF_CONDUCT.md"],
    ["CHANGELOG.md"],
    ["packages/app/README.md"],
    ["packages/app/CHANGELOG.md"],
    ["docs/guide.md"],
    ["docs/guide/setup.mdx"],
    [".metaproject/wiki/architecture/x.md"],
    [".metaproject/reviews/r1/summary.md"],
  ])("%s is prose or machine-written and needs no round", (file) => {
    expect(classifyRoundNeed({ files: [file] }).needed).toBe(false);
  });

  test("one steering file among prose forces a round", () => {
    expect(classifyRoundNeed({ files: ["docs/guide.md", "docs/CLAUDE.md"] }).needed).toBe(true);
  });

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

// Generated, not hand-picked: every steering or agent-loaded file name under every
// root and depth must force a round, whatever the folder says.
const ROOTS = ["", "docs", ".metaproject/wiki", ".metaproject/flows", ".metaproject/reviews", "coverage", "__generated__", "src/__generated__", "src", ".github", ".claude"];
const NESTING = ["", "a", "a/b", "a/b/c"];
const STEERING_NAMES = [
  "SKILL.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "QWEN.md", "CONVENTIONS.md", "CLAUDE.local.md",
  "AGENTS.override.md", "copilot-instructions.md", "a.instructions.md", "a.prompt.md", "a.mdc",
];
const AGENT_LOADED_NAMES = [
  ".cursorrules", ".windsurfrules", ".clinerules", ".aider.conf.yml", ".aiderignore", "mcp.json", ".mcp.json",
  "settings.json", "settings.local.json", "hooks.json", "package.json", "lefthook.yml",
];
const CODE_EXTENSIONS = ["ts", "sql", "yml", "sh", "js", "json"];

const join = (root: string, nesting: string, name: string): string => [root, nesting, name].filter((part) => part !== "").join("/");
const isMachineRoot = (root: string): boolean => root === "coverage" || root.endsWith("__generated__");

const GENERATED_TABLE: [string, boolean][] = [];
for (const root of ROOTS) {
  for (const nesting of NESTING) {
    for (const name of [...STEERING_NAMES, ...AGENT_LOADED_NAMES]) GENERATED_TABLE.push([join(root, nesting, name), true]);
    for (const ext of CODE_EXTENSIONS) {
      const skippable = ext === "json" && isMachineRoot(root);
      GENERATED_TABLE.push([join(root, nesting, `x.${ext}`), !skippable]);
    }
  }
}

describe("classifyRoundNeed over the generated path table", () => {
  test("the table is big enough to mean something", () => {
    expect(GENERATED_TABLE.length).toBeGreaterThan(900);
  });

  test.each(GENERATED_TABLE)("%s needs a round: %p", (file, needed) => {
    expect(classifyRoundNeed({ files: [file] }).needed).toBe(needed);
  });
});
