// Import-policy check, driven against real fixture trees (flow 239, AC-20 /
// AFC-20: "Import-policy проверка ловит запрещённый fixture и проходит
// разрешённый"). Every fixture lives in the repo under `fixtures/import-policy/`
// — see that directory's README for the layout — so this file demonstrates the
// check actually FIRES, not merely that its code exists.
//
// WHAT THIS FILE ADDS OVER THE PREVIOUS VERSION
//
// The old fixture set had a hole that made its "allowed" cases meaningless: the
// core facade in `allowed-client-imports-core-facade/` was a LEAF, so a
// reachability-based check passed it for a reason no real facade could ever
// reproduce. That fixture now has a dependency behind the facade, and the
// tree-shaking group below holds the three shapes that made a plainly written
// forbidden import report `violations=0`.

import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { checkImportPolicy, listSourceFiles, reachableModules, resolutionGaps } from "./import-policy";

const FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures/import-policy/", import.meta.url));

function fixture(...parts: string[]): string {
  return path.join(FIXTURES_ROOT, ...parts);
}

/** Every fixture tree this file drives, with the entry each one is built around. */
const FIXTURES = [
  { dir: "forbidden-owner-imports-client", entry: ["gdgraph", "entry.ts"] },
  { dir: "allowed-owner-imports-shared", entry: ["gdgraph", "entry.ts"] },
  { dir: "forbidden-client-imports-core-internal", entry: ["harness", "entry.ts"] },
  { dir: "allowed-client-imports-core-facade", entry: ["harness", "entry.ts"] },
  { dir: "tree-shaken-unused-binding", entry: ["gdgraph", "entry.ts"] },
  { dir: "tree-shaken-dead-branch", entry: ["gdgraph", "entry.ts"] },
  { dir: "tree-shaken-through-barrel", entry: ["gdgraph", "entry.ts"] },
  { dir: "erased-type-only-import", entry: ["gdgraph", "entry.ts"] },
] as const;

/** Finding kinds only, sorted — the shape most assertions below compare on. */
async function kindsOf(dir: string): Promise<string[]> {
  const report = await checkImportPolicy({ root: fixture(dir) });
  return report.findings.map((f) => f.kind).sort();
}

// Every fixture entry named above must actually exist — otherwise a deleted
// fixture and a passing test would look identical, the exact class-1 defect
// (a capability nothing calls / nothing proves) this phase's inventory found in
// this file's neighbour, `production-graph.test.ts`.
test("every fixture entry this file drives actually exists on disk", async () => {
  for (const { dir, entry } of FIXTURES) {
    const file = fixture(dir, ...entry);
    expect({ file, exists: await Bun.file(file).exists() }).toEqual({ file, exists: true });
  }
});

// The fixture directory must contain exactly the trees this file drives — a
// fixture silently added or renamed without a matching test is the same
// unproven-capability shape this whole check exists to close.
test("fixtures/import-policy/ contains exactly the trees this file drives", async () => {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  expect(dirs).toEqual(FIXTURES.map((f) => f.dir).slice().sort());
});

// ── The two policy directions ────────────────────────────────────────────────

test("catches a forbidden fixture: a core owner importing a client module", async () => {
  const root = fixture("forbidden-owner-imports-client");
  const report = await checkImportPolicy({ root });

  expect(report.scanned).toBeGreaterThan(1);
  expect(report.findings.map((f) => f.kind)).toEqual(["owner-imports-client"]);
  const [finding] = report.findings;
  expect(finding?.from.endsWith(path.join("gdgraph", "entry.ts"))).toBe(true);
  expect(finding?.to?.endsWith(path.join("harness", "leaf.ts"))).toBe(true);
  expect({ fromZone: finding?.fromZone, toZone: finding?.toZone }).toEqual({ fromZone: "core", toZone: "client" });
});

test("passes an allowed fixture: a core owner importing only a shared primitive", async () => {
  const root = fixture("allowed-owner-imports-shared");
  const report = await checkImportPolicy({ root });

  // Real edges were resolved. Without this, a scan that resolved nothing would
  // pass for exactly the same reason a clean tree does.
  expect(report.edges.length).toBeGreaterThan(0);
  expect(report.findings).toEqual([]);
});

test("catches a forbidden fixture: a client importing a core owner's private internal", async () => {
  const root = fixture("forbidden-client-imports-core-internal");
  const report = await checkImportPolicy({ root });

  expect(report.findings.map((f) => f.kind)).toEqual(["client-imports-core-internal"]);
  const [finding] = report.findings;
  expect(finding?.to?.endsWith(path.join("gdgraph", "internal.ts"))).toBe(true);
  expect({ fromZone: finding?.fromZone, toZone: finding?.toZone }).toEqual({ fromZone: "client", toZone: "core" });
});

test("passes an allowed fixture: a client importing a core owner strictly through service.ts", async () => {
  const root = fixture("allowed-client-imports-core-facade");
  const report = await checkImportPolicy({ root });

  expect(report.edges.length).toBeGreaterThan(0);
  expect(report.findings).toEqual([]);
});

/**
 * The regression that makes the "allowed facade" case worth anything.
 *
 * The facade imports `internal.ts`. A client entry therefore REACHES a core
 * internal even though it IMPORTS only the facade, and the two techniques
 * disagree by construction: direct edges pass, reachability cannot. This test
 * asserts the disagreement rather than describing it, so re-flattening the
 * facade into a leaf (which is what made the old check look correct) fails
 * here instead of quietly restoring the illusion.
 */
test("the allowed facade is not a leaf, and reachability would fail where direct edges pass", async () => {
  const root = fixture("allowed-client-imports-core-facade");
  const entry = fixture("allowed-client-imports-core-facade", "harness", "entry.ts");

  const report = await checkImportPolicy({ root });
  expect(report.findings).toEqual([]);

  const reached = await reachableModules({ entry, root });
  const internal = fixture("allowed-client-imports-core-facade", "gdgraph", "internal.ts");
  expect(reached).toContain(internal);
  // …and the client entry does NOT import it: no edge names it as a target.
  expect(report.edges.some((e) => e.from === entry && e.to === internal)).toBe(false);
});

// ── The tree-shaking shapes ──────────────────────────────────────────────────

test("catches a forbidden import whose binding is never used", async () => {
  expect(await kindsOf("tree-shaken-unused-binding")).toEqual(["owner-imports-client"]);
});

test("catches a forbidden import used only inside a branch that never runs", async () => {
  expect(await kindsOf("tree-shaken-dead-branch")).toEqual(["owner-imports-client"]);
});

test("catches a forbidden import routed through a re-export barrel", async () => {
  const root = fixture("tree-shaken-through-barrel");
  const report = await checkImportPolicy({ root });

  // The barrel itself is the client-zone module the owner imports — the
  // boundary is crossed on the first hop, so the check does not depend on
  // following the barrel through to `leaf.ts`.
  const owner = report.findings.filter((f) => f.kind === "owner-imports-client");
  expect(owner.length).toBe(1);
  expect(owner[0]?.to?.endsWith(path.join("harness", "index.ts"))).toBe(true);
});

/**
 * All three shapes above are invisible to the bundler. This is the proof of the
 * finding rather than a restatement of it: build each entry for real and assert
 * the client module is ABSENT from what the bundler reached, which is exactly
 * why the old check reported `violations=0` on files whose forbidden import is
 * written in plain sight.
 */
test("the bundler genuinely does not see any of the three tree-shaken imports", async () => {
  for (const dir of ["tree-shaken-unused-binding", "tree-shaken-dead-branch", "tree-shaken-through-barrel"]) {
    const root = fixture(dir);
    const reached = await reachableModules({ entry: fixture(dir, "gdgraph", "entry.ts"), root });
    const clientModules = reached.filter((m) => m.includes(`${path.sep}harness${path.sep}`));
    expect({ dir, clientModules }).toEqual({ dir, clientModules: [] });
  }
});

/**
 * A PRECISION CORRECTION to the finding as originally reported, measured.
 *
 * The three shapes were labelled "unused", "dead" and "barrel", which reads as
 * three independent ways to defeat the bundler. Only two of them are: a barrel
 * whose binding is genuinely CONSUMED is followed straight through to the
 * module behind it. The barrel fixture is written with an unused binding for
 * that reason, and this test pins the distinction so the fixture's comment
 * cannot drift from what the bundler does.
 */
test("a barrel alone does not defeat the bundler — only the unused binding does", async () => {
  // `realpath` because macOS resolves `/var/folders/…` to `/private/var/…`, and
  // the bundler reports the resolved form while `mkdtemp` returns the symlink.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-barrel-used-")));
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(root, "harness"), { recursive: true });
    await mkdir(path.join(root, "gdgraph"), { recursive: true });
    await writeFile(path.join(root, "harness", "leaf.ts"), `export const CLIENT = "client-leaf";\n`);
    await writeFile(path.join(root, "harness", "index.ts"), `export { CLIENT } from "./leaf";\n`);
    await writeFile(
      path.join(root, "gdgraph", "entry.ts"),
      `import { CLIENT } from "../harness/index";\nexport const used = CLIENT;\n`,
    );

    const reached = await reachableModules({ entry: path.join(root, "gdgraph", "entry.ts"), root });
    expect(reached).toContain(path.join(root, "harness", "leaf.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * THE DOCUMENTED LIMIT, MEASURED.
 *
 * A type-only import is erased before either tool sees it. This asserts the
 * limit is exactly where the module's header says it is — so if the parser ever
 * starts reporting type-only edges, this fails and the stale documentation gets
 * corrected instead of being trusted.
 */
test("a type-only import is invisible — the limit, asserted rather than claimed", async () => {
  const root = fixture("erased-type-only-import");
  const report = await checkImportPolicy({ root });

  expect(report.scanned).toBe(2);
  expect(report.findings).toEqual([]);
  expect(report.edges).toEqual([]);

  const reached = await reachableModules({ entry: fixture("erased-type-only-import", "gdgraph", "entry.ts"), root });
  expect(reached.filter((m) => m.includes(`${path.sep}harness${path.sep}`))).toEqual([]);
});

// ── The bundler as a coverage cross-check ────────────────────────────────────

test("resolutionGaps reports nothing when the direct scan named every module the bundler reached", async () => {
  const root = fixture("allowed-client-imports-core-facade");
  const entry = fixture("allowed-client-imports-core-facade", "harness", "entry.ts");
  const report = await checkImportPolicy({ root });

  expect(await resolutionGaps({ entry, root, edges: report.edges })).toEqual([]);
});

test("resolutionGaps reports a module the bundler reached that the direct scan missed", async () => {
  // Driven by withholding an edge rather than by planting an unresolvable
  // specifier: the assertion is about the cross-check noticing a hole in the
  // direct graph, whatever put it there.
  const root = fixture("allowed-client-imports-core-facade");
  const entry = fixture("allowed-client-imports-core-facade", "harness", "entry.ts");
  const facade = fixture("allowed-client-imports-core-facade", "gdgraph", "service.ts");
  const report = await checkImportPolicy({ root });

  const withoutFacadeEdges = report.edges.filter((e) => e.from !== facade && e.to !== facade);
  const gaps = await resolutionGaps({ entry, root, edges: withoutFacadeEdges });
  expect(gaps).toContain(facade);
});

// ── Anti-vacuous ─────────────────────────────────────────────────────────────

test("the bundler half also refuses an entry that is not there", async () => {
  // `reachableModules` is the other scan in this module, and "the build
  // produced nothing" must not read as "nothing was reached".
  const empty = await mkdtemp(path.join(tmpdir(), "keryx-import-policy-noentry-"));
  try {
    await expect(reachableModules({ entry: path.join(empty, "missing.ts"), root: empty })).rejects.toThrow(/failed/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("a scan of an empty directory fails instead of reporting a clean result", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "keryx-import-policy-empty-"));
  try {
    expect(listSourceFiles(empty)).toEqual([]);
    await expect(checkImportPolicy({ root: empty })).rejects.toThrow(/nothing to scan/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
