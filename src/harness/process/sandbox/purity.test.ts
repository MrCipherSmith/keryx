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
import { readFileSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dir;

/** Modules that must never reach the operating system directly. */
const PURE_MODULES = [
  "wrap.ts",
  "bwrap.ts",
  "seatbelt.ts",
  "profile.ts",
  "capability-matrix.ts",
] as const;

/** Ways a module could spawn a process. */
const SPAWN_IMPORTS = ["node:child_process", "child_process", "Bun.spawn", "Bun.$"];

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
    test(`${file} cannot spawn a process`, () => {
      const source = sourceOf(file);
      const offenders = SPAWN_IMPORTS.filter((needle) => source.includes(needle));
      expect(offenders).toEqual([]);
    });
  }

  test("probe.ts is the module that spawns, and it does so behind an injectable seam", () => {
    const source = sourceOf("probe.ts");
    // It really is impure …
    expect(source).toContain("node:child_process");
    // … and the impurity really is injectable, exactly as detect.ts injects
    // `existsSync`. Without the seam every unit test in this package would need
    // a real launcher.
    expect(source).toContain("spawn?: ProbeSpawn");
  });

  test("falsifiable: the same check finds the spawn import in the module that has one", () => {
    // Proves the loop above reads the files rather than passing on an empty
    // haystack: run the identical filter against probe.ts and it must NOT be
    // empty.
    const offenders = SPAWN_IMPORTS.filter((needle) => sourceOf("probe.ts").includes(needle));
    expect(offenders).toContain("node:child_process");
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
