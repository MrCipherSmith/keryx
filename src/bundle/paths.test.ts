// Flow 313 (W4 portability), T6 — paths.ts unit tests: normalization,
// per-kind/scope shape rules, and symlink/containment refusals.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { normalizeBundlePath, scopeRoot, targetFor, validateKindPath } from "./paths";

let root: string;
let projectRoot: string;
let homeDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-paths-"));
  projectRoot = path.join(root, "project");
  homeDir = path.join(root, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("normalizeBundlePath", () => {
  test("accepts a clean relative path", () => {
    const result = normalizeBundlePath("skills/foo/SKILL.md");
    expect(result.ok).toBe(true);
  });

  test.each([
    ["/abs/path", "absolute"],
    ["a\\b", "backslash"],
    ["a/../b", ".."],
    ["a/./b", "."],
    ["", "empty"],
    ["a//b", "empty segment"],
    ["a/", "trailing slash"],
    ["a\0b", "NUL byte"],
  ])("refuses %s (%s)", (input) => {
    const result = normalizeBundlePath(input);
    expect(result.ok).toBe(false);
  });
});

describe("validateKindPath", () => {
  test("skill: skills/<name>/** valid at every scope", () => {
    expect(validateKindPath("skill", "project", "skills/foo/SKILL.md").ok).toBe(true);
    expect(validateKindPath("skill", "user", "skills/foo/SKILL.md").ok).toBe(true);
  });

  test("skill: project-skills/** valid only at project scope", () => {
    expect(validateKindPath("skill", "project", "project-skills/foo/SKILL.md").ok).toBe(true);
    expect(validateKindPath("skill", "team", "project-skills/foo/SKILL.md").ok).toBe(false);
  });

  test("skill: user scope may never target skills/external-imports.json", () => {
    const result = validateKindPath("skill", "user", "skills/external-imports.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-not-valid-for-scope");
  });

  test("rule: refused at user scope", () => {
    const result = validateKindPath("rule", "user", "rules/foo.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("user-scope-rule-refused");
  });

  test("rule: valid .md/.mdc under rules/ at project/team", () => {
    expect(validateKindPath("rule", "project", "rules/foo.md").ok).toBe(true);
    expect(validateKindPath("rule", "team", "rules/nested/foo.mdc").ok).toBe(true);
  });

  test("agent: single-level agents/<name>.md only", () => {
    expect(validateKindPath("agent", "project", "agents/foo.md").ok).toBe(true);
    expect(validateKindPath("agent", "project", "agents/sub/foo.md").ok).toBe(false);
  });

  test("memory-entry: folder must be a known MEMORY_TYPES folder", () => {
    expect(validateKindPath("memory-entry", "user", "memory/lessons/a.md").ok).toBe(true);
    expect(validateKindPath("memory-entry", "user", "memory/not-a-folder/a.md").ok).toBe(false);
  });

  test("hook-config: exactly hooks.json", () => {
    expect(validateKindPath("hook-config", "user", "hooks.json").ok).toBe(true);
    expect(validateKindPath("hook-config", "user", "hooks/other.json").ok).toBe(false);
  });

  test("learned-pattern: project targets data/learning/candidates, user targets learning/patterns", () => {
    expect(validateKindPath("learned-pattern", "project", "data/learning/candidates/a.json").ok).toBe(true);
    expect(validateKindPath("learned-pattern", "user", "learning/patterns/a.json").ok).toBe(true);
    expect(validateKindPath("learned-pattern", "user", "data/learning/candidates/a.json").ok).toBe(false);
  });

  test("globally forbidden paths are refused regardless of kind", () => {
    expect(validateKindPath("learned-pattern", "user", "learning/index.json").ok).toBe(false);
    expect(validateKindPath("learned-pattern", "user", "learning/observations/a.json").ok).toBe(false);
  });
});

describe("scopeRoot", () => {
  test("project and team share the .metaproject tree", () => {
    const ctx = { projectRoot, env: {}, homeDir };
    expect(scopeRoot("project", ctx)).toBe(path.join(projectRoot, ".metaproject"));
    expect(scopeRoot("team", ctx)).toBe(path.join(projectRoot, ".metaproject"));
  });

  test("user resolves under the given homeDir", () => {
    const ctx = { projectRoot, env: {}, homeDir };
    expect(scopeRoot("user", ctx)).toBe(path.join(homeDir, ".keryx"));
  });
});

describe("targetFor", () => {
  test("resolves a valid entry to an absolute path inside the scope root", async () => {
    const ctx = { projectRoot, env: {}, homeDir };
    const result = await targetFor({ path: "agents/foo.md", kind: "agent", scope: "project" }, "project", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolutePath).toBe(path.join(projectRoot, ".metaproject", "agents", "foo.md"));
    }
  });

  test("refuses a target whose parent chain is a symlink", async () => {
    const ctx = { projectRoot, env: {}, homeDir };
    const metaproject = path.join(projectRoot, ".metaproject");
    mkdirSync(path.join(root, "elsewhere"), { recursive: true });
    mkdirSync(metaproject, { recursive: true });
    symlinkSync(path.join(root, "elsewhere"), path.join(metaproject, "agents"));

    const result = await targetFor({ path: "agents/foo.md", kind: "agent", scope: "project" }, "project", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("symlink-refused");
  });

  test("refuses when the target file itself is a symlink", async () => {
    const ctx = { projectRoot, env: {}, homeDir };
    const metaproject = path.join(projectRoot, ".metaproject", "agents");
    mkdirSync(metaproject, { recursive: true });
    writeFileSync(path.join(root, "secret.md"), "x");
    symlinkSync(path.join(root, "secret.md"), path.join(metaproject, "foo.md"));

    const result = await targetFor({ path: "agents/foo.md", kind: "agent", scope: "project" }, "project", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("symlink-refused");
  });
});
