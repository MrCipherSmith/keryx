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
  const code = withoutComments(source);
  if (needle.startsWith("Bun.")) {
    // Not an import — a global call.
    return code.includes(needle);
  }
  // Anchored on the SPECIFIER, not on a line that starts with `import`. An
  // earlier version required `^\s*(?:import|export)` on the same line, which
  // any formatter defeats the moment the named-import list wraps:
  //
  //   import {
  //     spawnSync,
  //   } from "node:child_process";
  //
  // — the `from` line starts with `}`, so the guard read the module as pure.
  // `import()` and `require()` were missed for the same reason. Matching
  // `from`/`import(`/`require(` immediately before the quoted specifier catches
  // every form and still cannot fire on prose, because comments are stripped.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:from|import|require)\\s*\\(?\\s*["']${escaped}["']`).test(code);
}

/** Strip `//` line comments and block comments. Good enough for this check. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test module in this package. */
function packageModules(): string[] {
  return readdirSync(HERE).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
}

/** Modules that spawn directly — they name a spawn API themselves. */
function directSpawningModules(): string[] {
  return packageModules().filter((file) => SPAWN_IMPORTS.some((needle) => importsSpawn(sourceOf(file), needle)));
}

/**
 * Every module from which a process is reachable: the direct spawners, plus
 * anything that imports one, to a fixed point.
 *
 * The fixed point is the point. A single hop would miss the route the barrel
 * actually opened — `index.ts` re-exports `probeContainment`, so a module
 * importing `./index` reaches a spawn through a file that does not itself
 * spawn, and a one-hop check calls that pure.
 */
function spawningModules(): string[] {
  const modules = packageModules();
  const sources = new Map(modules.map((file) => [file, withoutComments(sourceOf(file))]));
  const reaching = new Set(directSpawningModules());

  for (let changed = true; changed; ) {
    changed = false;
    for (const file of modules) {
      if (reaching.has(file)) continue;
      const source = sources.get(file) ?? "";
      const importsAReacher = [...reaching].some((spawner) =>
        new RegExp(`from\\s+["']\\./${spawner.replace(/\.ts$/, "")}["']`).test(source),
      );
      if (importsAReacher) {
        reaching.add(file);
        changed = true;
      }
    }
  }
  return [...reaching];
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

  test("the set of DIRECT spawners is exactly the two that are meant to spawn", () => {
    // Pinned so that a third one cannot appear unremarked. `probe.ts` runs the
    // trial containment; `tls-ca.ts` shells out to openssl for the restricted-
    // network CA and predates this flow. Both are deliberate; anything else
    // showing up here is a purity regression and should fail loudly rather than
    // widen the transitive check by accident.
    expect(directSpawningModules().sort()).toEqual(["probe.ts", "tls-ca.ts"]);
  });

  test("the transitive closure is a superset, and includes the barrel", () => {
    // Two things at once. That the closure is genuinely computed (it must be
    // strictly larger than the direct set, because `index.ts` re-exports both
    // spawners), and that `index.ts` is in it — which is what makes the
    // per-module transitive check above able to catch a pure module that
    // reaches a spawn through the barrel rather than directly.
    const direct = directSpawningModules().sort();
    const closure = spawningModules().sort();

    expect(closure).toContain("index.ts");
    for (const file of direct) {
      expect(closure).toContain(file);
    }
    expect(closure.length).toBeGreaterThan(direct.length);
  });

  test("falsifiable: the same check finds the spawn import in the module that has one", () => {
    // Proves the loop above reads the files rather than passing on an empty
    // haystack: run the identical filter against probe.ts and it must NOT be
    // empty.
    const offenders = SPAWN_IMPORTS.filter((needle) => importsSpawn(sourceOf("probe.ts"), needle));
    expect(offenders).toContain("node:child_process");
  });

  test("falsifiable: the matcher sees every import form, and no comment", () => {
    // The instrument's own weak points, pinned — a guard meant to hold for
    // years is only as good as the shapes it recognises, and the first version
    // of this one recognised exactly one.
    const spawnModule = "node:child_process";

    // Prose is not a use.
    expect(importsSpawn(`// this module must never import ${spawnModule}\n`, spawnModule)).toBe(false);
    expect(importsSpawn(`/**\n * See ${spawnModule} for why.\n */\n`, spawnModule)).toBe(false);

    // …and every real form is.
    for (const form of [
      `import { spawnSync } from "${spawnModule}";`,
      // The wrapped form any formatter produces once the list grows. The
      // earlier matcher required the specifier's line to START with `import`,
      // so this one read as pure.
      `import {\n  spawnSync,\n  spawn,\n} from "${spawnModule}";`,
      `import * as cp from "${spawnModule}";`,
      `export { spawnSync } from "${spawnModule}";`,
      `const cp = require("${spawnModule}");`,
      `const cp = await import("${spawnModule}");`,
    ]) {
      expect(importsSpawn(form, spawnModule)).toBe(true);
    }
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
