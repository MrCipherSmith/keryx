/**
 * `packageRelativePath` regression coverage (flow 347 R2-1).
 *
 * The old implementation derived the package root from THIS MODULE's own
 * depth under it (`path.join(here, "..", "..")`), assuming `here` is always
 * `<pkg>/dist/gdskills`. The real build (`bun build ./src/cli.ts --outdir
 * ./dist`, see package.json `build`) emits one bundled `dist/cli.js`, so at
 * runtime `here` is `<pkg>/dist` — one level shallower — and the depth-based
 * root resolved ABOVE the package. An installed package then reported
 * `keryx/src/gdskills/bundled/skills/review/<name>` instead of
 * `src/gdskills/bundled/skills/review/<name>`.
 *
 * Approach: unit-test the root-derivation function directly against both path
 * shapes `bundledSkillMarkdownPath` can hand it, rather than running a real
 * `bun build` in this test. `packageRelativePath` takes the already-resolved
 * candidate path as its only input and no longer reads `import.meta.url`, so
 * feeding it synthetic paths shaped like each layout exercises the exact same
 * code a real build would — without paying for an actual bundle step (`bun
 * build` of the full CLI takes several seconds, and every property this test
 * cares about is a pure function of the string it receives). Chosen for speed
 * and determinism; see `catalog-single-source.test.ts` and
 * `src/review/reviewers.test.ts` for tests that exercise the real, unbundled
 * source tree end to end.
 */
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { packageRelativePath } from "./catalog";

describe("packageRelativePath", () => {
  test("source layout: here is <pkg>/src/gdskills, candidate already under src/gdskills/bundled", () => {
    const pkgRoot = path.join("/", "opt", "keryx");
    const skillDir = path.join(pkgRoot, "src", "gdskills", "bundled", "skills", "review", "review-orchestrator");

    expect(packageRelativePath(skillDir)).toBe("src/gdskills/bundled/skills/review/review-orchestrator");
  });

  test("bundled single-file layout: here is <pkg>/dist (dist/cli.js), candidate walks dist/../src/gdskills/bundled/...", () => {
    const pkgRoot = path.join("/", "opt", "keryx");
    const here = path.join(pkgRoot, "dist");
    // Mirrors bundledSkillMarkdownPath's second candidate exactly, then dirname
    // like reviewers.ts's packageRelativePath(path.dirname(file)) call.
    const skillMarkdown = path.join(here, "..", "src", "gdskills", "bundled", "skills", "review", "review-orchestrator", "SKILL.md");
    const skillDir = path.dirname(skillMarkdown);

    // Before the fix, path.join(here, "..", "..") from this `here` resolved to
    // `/opt` — one level ABOVE the package — and relativizing against it
    // produced `keryx/src/gdskills/bundled/skills/review/review-orchestrator`.
    expect(packageRelativePath(skillDir)).toBe("src/gdskills/bundled/skills/review/review-orchestrator");
  });

  test("both layouts agree for the same skill", () => {
    const sourceRoot = path.join("/", "home", "user", "project", "keryx");
    const sourceDir = path.join(sourceRoot, "src", "gdskills", "bundled", "skills", "core", "metaproject-router");

    const bundledHere = path.join(sourceRoot, "dist");
    const bundledDir = path.dirname(
      path.join(bundledHere, "..", "src", "gdskills", "bundled", "skills", "core", "metaproject-router", "SKILL.md"),
    );

    expect(packageRelativePath(sourceDir)).toBe(packageRelativePath(bundledDir));
  });

  test("throws rather than silently mis-resolving a path outside the bundled tree", () => {
    expect(() => packageRelativePath(path.join("/", "opt", "keryx", "dist", "cli.js"))).toThrow();
  });
});
