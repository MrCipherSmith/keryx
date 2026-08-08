// keryx-linux-containment step 1 — AC14, enforced rather than reviewed.
//
// Requirement N3: "The pure modules stay pure. `wrap.ts`, `profile.ts`,
// `bwrap.ts` and the matrix must remain spawn-free and offline-testable; the
// probe is impure and lives behind an injectable seam, as `detect.ts` already
// does for the filesystem."
//
// That was true when this flow landed and was checked by reading the diff. A
// diff is checked once; a test is checked forever, and this package's whole
// premise is that a claim nobody re-checks is a claim that stops being true.
// AC13 already chose "enforced by a test, not by inspection" for the sysctl
// ban — this applies the same rule to the purity claim, which decays the moment
// someone adds a convenient `spawnSync` to a launcher builder.
//
// Deliberately a source-text check: an import-graph walk would need a bundler,
// and the property being defended is exactly "this file does not name these
// modules".

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dir;

/**
 * Modules that must never reach the operating system directly.
 *
 * `adapter.ts` is here because AC14 names it: it is the fail-closed decoration,
 * and a spawn reaching it would sit directly on the boundary this whole package
 * defends.
 */
const PURE_MODULES = [
  "wrap.ts",
  "bwrap.ts",
  "seatbelt.ts",
  "profile.ts",
  "capability-matrix.ts",
  "adapter.ts",
] as const;

/** Ways a module could spawn a process. */
const SPAWN_IMPORTS = ["node:child_process", "child_process", "Bun.spawn", "Bun.$"];

/**
 * Does `source` IMPORT `needle`, as opposed to merely mentioning it?
 *
 * A raw `includes` reads comments as code in both directions: a doc comment
 * explaining why a module must not import `node:child_process` would fail the
 * check, and — worse — the positive assertion below would stay green on a
 * comment alone if the real import were deleted. The N2 check further down
 * already matched import statements; this makes the spawn check do the same.
 */
function importsSpawn(source: string, needle: string): boolean {
  if (needle.startsWith("Bun.")) {
    // Not an import — a global call. Strip line comments before looking, so
    // prose about `Bun.spawn` does not read as a use of it.
    return withoutComments(source).includes(needle);
  }
  const pattern = new RegExp(`^\\s*(?:import|export)[^;\\n]*["']${needle}["']`, "m");
  return pattern.test(source) || new RegExp(`require\\(\\s*["']${needle}["']`).test(source);
}

/** Strip `//` line comments and block comments. Good enough for this check. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test module in this package that reaches a process, computed from source. */
function spawningModules(): string[] {
  return readdirSync(HERE)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => SPAWN_IMPORTS.some((needle) => importsSpawn(sourceOf(file), needle)));
}

/**
 * `bwrap.ts` reads the filesystem to classify mask targets (`inspectMaskTarget`),
 * which predates this flow and is injectable at its only call site, so this is a
 * spawn check and not a filesystem check.
 */
function sourceOf(file: string): string {
  return readFileSync(path.join(HERE, file), "utf8");
}

describe("sandbox module purity (N3 / AC14)", () => {
  for (const file of PURE_MODULES) {
    test(`${file} cannot spawn a process directly`, () => {
      const source = sourceOf(file);
      const offenders = SPAWN_IMPORTS.filter((needle) => importsSpawn(source, needle));
      expect(offenders).toEqual([]);
    });

    test(`${file} cannot spawn a process transitively either`, () => {
      // The direct check alone would let a pure module import `./probe`, which
      // spawns — the route the barrel opened when `index.ts` began re-exporting
      // it. The spawning set is computed rather than hard-coded, so this stays
      // true when a module is added to it: an early draft asserted `probe.ts`
      // was the only spawner and was wrong (`tls-ca.ts` shells out to openssl),
      // which is precisely the kind of hand-maintained fact that rots.
      const source = withoutComments(sourceOf(file));
      const reached = spawningModules().filter((spawner) =>
        new RegExp(`from\\s+["']\\./${spawner.replace(/\.ts$/, "")}["']`).test(source),
      );
      expect(reached).toEqual([]);
    });
  }

  test("probe.ts is the module that spawns, and it does so behind an injectable seam", () => {
    const source = sourceOf("probe.ts");
    // It really is impure …
    expect(importsSpawn(source, "node:child_process")).toBe(true);
    // … and the impurity really is injectable, exactly as detect.ts injects
    // `existsSync`. Without the seam every unit test in this package would need
    // a real launcher.
    expect(source).toContain("spawn?: ProbeSpawn");
  });

  test("the set of spawning modules is exactly the two that are meant to spawn", () => {
    // Pinned so that a third one cannot appear unremarked. `probe.ts` runs the
    // trial containment; `tls-ca.ts` shells out to openssl for the restricted-
    // network CA and predates this flow. Both are deliberate; anything else
    // showing up here is a purity regression and should fail loudly rather than
    // widen the transitive check by accident.
    expect(spawningModules().sort()).toEqual(["probe.ts", "tls-ca.ts"]);
  });

  test("falsifiable: the same check finds the spawn import in the module that has one", () => {
    // Proves the loop above reads the files rather than passing on an empty
    // haystack: run the identical filter against probe.ts and it must NOT be
    // empty.
    const offenders = SPAWN_IMPORTS.filter((needle) => importsSpawn(sourceOf("probe.ts"), needle));
    expect(offenders).toContain("node:child_process");
  });

  test("falsifiable: a mention in a comment is not read as an import", () => {
    // The instrument's own weak point, pinned. Without this, tightening the
    // matcher could silently regress to substring matching and nothing would
    // notice until a pure module's doc comment failed the suite.
    expect(importsSpawn('// this module must never import node:child_process\n', "node:child_process")).toBe(false);
    expect(importsSpawn('import { spawnSync } from "node:child_process";\n', "node:child_process")).toBe(true);
  });

  test("N2: the sandbox package pulls in no npm dependency", () => {
    // ADR-0005. Every import in these modules is a node: builtin or a relative
    // path; a bare specifier would be a new runtime dependency.
    const bareImport = /^\s*import\s[^;]*?from\s+"(?!node:|\.)/gm;
    for (const file of [...PURE_MODULES, "probe.ts", "detect.ts", "adapter.ts"]) {
      expect(sourceOf(file).match(bareImport) ?? []).toEqual([]);
    }
  });
});
