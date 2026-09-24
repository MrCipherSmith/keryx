// Flow 313 (W4 portability), T6 — paths.ts unit tests: normalization,
// per-kind/scope shape rules, and symlink/containment refusals.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { normalizeBundlePath, scopeRoot, targetFor, validateKindPath, readTargetFile } from "./paths";

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

  // R1-F7: control characters and marker-forging sequences must be refused —
  // pre-fix, none of these were checked at all, so a rule path could forge a
  // `<!-- keryx:rules -->` marker and wedge the renderer / truncate human
  // content on a later `ensureMetaprojectReference` run.
  test.each([
    ["a\rb", "CR"],
    ["a\nb", "LF"],
    ["a\tb", "TAB"],
    ["a\u2028b", "U+2028 line separator"],
    ["a\u2029b", "U+2029 paragraph separator"],
    ["a<b", "<"],
    ["a>b", ">"],
    ["a`b", "backtick"],
    ["rules/<!-- /keryx:rules -->.md", "<!-- marker open"],
    ["rules/keryx:rules -->.md", "--> marker close"],
  ])("refuses %s (%s)", (input) => {
    const result = normalizeBundlePath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-escape");
  });

  // R2-F1/R2-F21 (class "path identity"): the actual fix for round 2's
  // recurring Unicode/case-folding class is that a bundle path segment must
  // be portable ASCII, full stop — so every non-ASCII alias of a reserved
  // name is refused HERE, at normalization, rather than needing a
  // case-fold helper to separately learn every filesystem's alias table.
  // Each of these previously reached `validateKindPath` unchanged; `ſ`
  // (U+017F LATIN SMALL LETTER LONG S) in particular is the round-2 finding
  // (R2-F1): APFS treats it as an alias of `s`, but plain
  // `String.prototype.toLowerCase()` does not fold it, so the round-1 fix's
  // `caseFold` (`normalize("NFC").toLowerCase()`) missed it too. This test
  // fails on the pre-round-2-fix code (which had no portability check at
  // all — only the round-1 `caseFold`, which does not catch any of these).
  test.each([
    ["skills/x/ſKILL.md", "U+017F LATIN SMALL LETTER LONG S (APFS alias of s)"],
    ["skills/ｓkill/SKILL.md", "full-width ｓ"],
    ["skills/éxternal/SKILL.md", "NFD combining acute accent"],
    ["skills/straße/SKILL.md", "ß"],
    ["skills/İstanbul/SKILL.md", "İ (dotted capital I)"],
  ])("refuses a non-ASCII path segment: %s (%s)", (input) => {
    const result = normalizeBundlePath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-escape");
  });

  test("accepts every portable-ASCII segment character: letters, digits, '.', '_', '-'", () => {
    expect(normalizeBundlePath("skills/a-B_9.c/SKILL.md").ok).toBe(true);
  });

  test("refuses a leading '.' in a segment even though the rest is portable ASCII", () => {
    const result = normalizeBundlePath("skills/.hidden/SKILL.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-escape");
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

  // R1-F2: pre-fix, `isGloballyForbidden`/the skill-kind guard compared
  // `relPath === "skills/external-imports.json"` case-sensitively, so a
  // case-variant path sailed through `validateKindPath` even though it is
  // the SAME file as the reserved registry on a case-insensitive filesystem
  // (APFS/exFAT/NTFS) — letting a bundle plant a forged, "vetted" registry.
  // R2-F21: the original third case here (`skills/external-imports.json`)
  // was the exact canonical name — every one of the three assertions passed
  // whether or not case-folding worked at all, so the test exercised
  // nothing about case-insensitivity. Replaced with THREE actually-distinct
  // ASCII case variants (validateKindPath, unlike normalizeBundlePath's
  // portable-ASCII gate above, is exercised directly here — case-folding
  // still matters for pure-ASCII variants that pass that gate).
  test("skill: an ASCII case variant of external-imports.json is refused too", () => {
    for (const variant of ["skills/External-Imports.json", "skills/EXTERNAL-IMPORTS.JSON", "skills/eXternal-imports.JSON"]) {
      const result = validateKindPath("skill", "user", variant);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.reason).toBe("path-not-valid-for-scope");
    }
    // sanity: an ordinary skill path one character different is still fine.
    expect(validateKindPath("skill", "user", "skills/external-imports-2.json").ok).toBe(true);
  });

  // R2-F1: a non-ASCII alias (e.g. U+017F `ſ`, APFS's alias of `s`) is
  // refused end-to-end through the pipeline every real caller uses
  // (normalize, THEN validate) — normalizeBundlePath is the primary
  // enforcement point.
  test("skill: a non-ASCII alias of external-imports.json is refused by normalizeBundlePath before validateKindPath ever sees it", () => {
    const normalized = normalizeBundlePath("skills/external-importſ.json");
    expect(normalized.ok).toBe(false);
    if (!normalized.ok) expect(normalized.refusal.reason).toBe("path-escape");
  });

  // R2-F1 defense-in-depth: validateKindPath ALSO refuses a non-ASCII alias
  // when called directly (bypassing normalizeBundlePath), so a shape/
  // reserved-path check is never "correct only because every caller
  // normalizes first". Fails on the round-2 code (and on a version that
  // removed the round-1 `caseFold` without replacing it), which returned
  // `{ok: true}` for every one of these when validateKindPath was called
  // directly — the exact shape of the vk.ts probe evidence in the round-2
  // report (R2-F1).
  test("validateKindPath itself refuses non-ASCII aliases even when called directly, unnormalized", () => {
    for (const variant of ["skills/x/ſKILL.md", "skills/external-importſ.json", "skills/external-imports.jſon"]) {
      const result = validateKindPath("skill", "user", variant);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.reason).toBe("path-escape");
    }
  });

  test("reserved-path guard is case-folded for every reserved prefix, not only external-imports.json", () => {
    expect(validateKindPath("learned-pattern", "user", "Learning/Index.json").ok).toBe(false);
    expect(validateKindPath("learned-pattern", "user", "LEARNING/OBSERVATIONS/a.json").ok).toBe(false);
    expect(validateKindPath("hook-config", "project", "Data/Bundles/x").ok).toBe(false);
  });

  // Class "path identity": `state/**` (where L2 now keeps the
  // external-imports integrity key, `userStorePaths().state /
  // .externalImportsKey` in src/lib/keryx-home.ts) and the OLD key location
  // `skills/.external-imports.key` are both reserved for EVERY kind and
  // scope, so no bundle — of any content kind, at project or user scope —
  // can ever plant either. Every reserved-path comparison folds through the
  // same portable-ASCII canonical form as the rest of this class, so a
  // case/Unicode variant of either reserved path is refused too, not only
  // the exact spelling.
  test("state/** and the legacy external-imports key path are reserved for every kind and scope, case/Unicode variants included", () => {
    for (const kind of ["skill", "rule", "agent", "learned-pattern", "memory-entry", "hook-config"] as const) {
      for (const scope of ["project", "user"] as const) {
        if (kind === "rule" && scope === "user") continue; // rule has no user-scope shape at all; not the case under test here.
        expect(validateKindPath(kind, scope, "state/anything.json").ok).toBe(false);
        expect(validateKindPath(kind, scope, "state/deep/nested/file.json").ok).toBe(false);
        // Case-variant and mixed-case forms of the reserved prefix, still
        // portable ASCII (so they reach validateKindPath's own fold, not
        // normalizeBundlePath's portability gate).
        expect(validateKindPath(kind, scope, "STATE/anything.json").ok).toBe(false);
        expect(validateKindPath(kind, scope, "State/Deep/Nested.json").ok).toBe(false);
      }
    }
    // skills/.external-imports.key is refused by validateKindPath's own
    // portability check (a leading-dot segment is never portable) before
    // reaching the globally-forbidden comparison — belt AND suspenders, not
    // reachable in production anyway since normalizeBundlePath would already
    // have refused a leading-dot segment first.
    for (const variant of ["skills/.external-imports.key", "skills/.External-Imports.KEY"]) {
      const result = validateKindPath("skill", "user", variant);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.reason).toBe("path-escape");
    }
    // A non-ASCII alias of the legacy key path is refused earlier still, by
    // normalizeBundlePath's portable-ASCII gate (the real pipeline order).
    const nonAscii = normalizeBundlePath("skills/.external-importſ.key");
    expect(nonAscii.ok).toBe(false);
    if (!nonAscii.ok) expect(nonAscii.refusal.reason).toBe("path-escape");
  });

  // R1-F8: pre-fix, a `skills/evil/skill.md` (lowercase) entry passed
  // `validateKindPath` unchanged, so the SKILL.md-only audit checks
  // (auto-run directive, prompt-injection-in-instructions, keyed on the
  // exact basename) never ran on it — even though on a case-insensitive
  // filesystem it IS the skill's SKILL.md.
  test("skill: a non-canonical casing of SKILL.md is refused (kind-path-mismatch)", () => {
    for (const variant of ["skills/evil/skill.md", "skills/evil/Skill.MD", "skills/evil/SKILL.MD", "skills/evil/Skill.md"]) {
      const result = validateKindPath("skill", "user", variant);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.reason).toBe("kind-path-mismatch");
    }
    // canonical casing, and any OTHER filename under a skill dir, still work.
    expect(validateKindPath("skill", "user", "skills/evil/SKILL.md").ok).toBe(true);
    expect(validateKindPath("skill", "user", "skills/evil/reference.md").ok).toBe(true);
  });
});

// R2-F20: plan, apply, and uninstall all used to swallow every read error
// the same way as "absent". `readTargetFile` is the one function they now
// share for this, so its own behavior is tested directly here.
describe("readTargetFile", () => {
  test("ENOENT reads as bytes: undefined, ok: true", async () => {
    const result = await readTargetFile(path.join(root, "does-not-exist.md"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toBeUndefined();
  });

  test("an existing file's bytes are returned", async () => {
    const file = path.join(root, "present.md");
    writeFileSync(file, "hello");
    const result = await readTargetFile(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes?.toString("utf8")).toBe("hello");
  });

  // A path that walks THROUGH a file (not a directory) is a real read
  // error (ENOTDIR), not "absent" — the file at that "directory" position
  // very much exists.
  test("a non-ENOENT error refuses target-unreadable, not bytes: undefined", async () => {
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "x");
    const result = await readTargetFile(path.join(blocker, "nested.md"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("target-unreadable");
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

  // R1-I1: the scope root itself must be checked, not only the segments
  // under it — a symlinked `.metaproject` swapped in between plan and apply
  // must not be silently followed.
  test("refuses when the scope root itself is a symlink", async () => {
    const ctx = { projectRoot, env: {}, homeDir };
    mkdirSync(path.join(root, "elsewhere-root"), { recursive: true });
    symlinkSync(path.join(root, "elsewhere-root"), path.join(projectRoot, ".metaproject"));

    const result = await targetFor({ path: "agents/foo.md", kind: "agent", scope: "project" }, "project", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("symlink-refused");
  });
});

// R3-F15: a reserved EXACT path (`skills/external-imports.json`,
// `skills/.external-imports.key`, `learning/index.json`) is also reserved as
// a DIRECTORY PREFIX — a bundle must not be able to plant a directory AT the
// reserved path by shipping a file underneath it.
describe("reserved-path guard is a directory prefix too (R3-F15)", () => {
  test.each([
    "skills/external-imports.json/SKILL.md",
    "skills/external-imports.json/x/SKILL.md",
    "learning/index.json/x.json",
  ])("%s is refused as path-not-valid-for-scope", (bundlePath) => {
    const kind = bundlePath.startsWith("learning/") ? "learned-pattern" : "skill";
    const result = validateKindPath(kind, "user", bundlePath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-not-valid-for-scope");
  });

  test("a case-variant of the reserved directory prefix is refused too", () => {
    const result = validateKindPath("skill", "user", "skills/EXTERNAL-IMPORTS.JSON/SKILL.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-not-valid-for-scope");
  });

  test("the reserved name itself (no nesting) is still refused, unchanged", () => {
    const result = validateKindPath("hook-config", "project", "skills/external-imports.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-not-valid-for-scope");
  });
});

// R3-I1: a trailing-dot segment or a Win32 reserved device basename
// (case-insensitive, with any extension) is refused as non-portable —
// Windows support is best-effort, but a path that can never be written back
// out on a Windows target must not be accepted as portable in the first
// place.
describe("normalizeBundlePath refuses trailing-dot and Win32 device names (R3-I1)", () => {
  test.each(["agents/foo.md.", "rules/CON.md", "rules/con.md", "rules/NUL", "skills/com1.txt/SKILL.md", "rules/LPT9.md"])("%s is refused", (bundlePath) => {
    const result = normalizeBundlePath(bundlePath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("path-escape");
  });

  test("an ordinary name that merely CONTAINS a device-like substring is accepted", () => {
    const result = normalizeBundlePath("rules/console.md");
    expect(result.ok).toBe(true);
  });
});
