// Unit-level guards for the import-policy machinery (flow 239, AC-20 / AFC-20).
//
// Three things are pinned here, each because it silently broke once:
//
//   1. WHAT THE PARSER ACTUALLY SEES. The module header lists the import shapes
//      `Bun.Transpiler.scanImports` reports and the ones it erases. That list is
//      a factual claim about someone else's parser, and a comment cannot keep it
//      true across a Bun upgrade. It is measured below instead.
//
//   2. THAT THE ZONE TABLE COVERS THE TREE. The table's only previous
//      self-check was `ZONE_TABLE.length > 10` — an assertion that restates the
//      table to itself and therefore cannot notice a directory the table does
//      not name. Three directories (`src/eval`, `src/retention`, `src/sync`)
//      were uncovered when that assertion was passing, one of them added by the
//      very commit that wrote the table. The assertion here is derived from the
//      filesystem.
//
//   3. THAT AN UNCLASSIFIED ZONE IS NOT A PASS. The previous check wrapped its
//      entire violation loop in `if (entryZone !== undefined)`, so an
//      unrecognised entry returned `violations: []` — byte-identical to a real
//      pass. Reproduced before this rewrite: `src/core.ts` reported
//      `zone=undefined scanned=169 violations=0`, a clean bill of health over
//      169 modules from a check that did not know what it was looking at.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkImportPolicy, listSourceFiles, resolveSpecifier } from "./import-policy";
import {
  ZONE_TABLE,
  listZoneSegments,
  staleSegments,
  topSegmentOf,
  unclassifiedSegments,
  zoneOf,
} from "./import-zones";

const SRC = path.resolve(import.meta.dir, "..");

// ── 1. What the parser actually sees ─────────────────────────────────────────

/**
 * Every import shape the module header makes a claim about, driven through the
 * real parser. `seen: true` means the header lists it under SEEN; `seen: false`
 * means it is one of the two documented blind spots.
 *
 * A Bun upgrade that changes any of these fails HERE, next to the claim, rather
 * than turning the header into quiet fiction.
 */
const IMPORT_SHAPES: readonly { readonly name: string; readonly code: string; readonly seen: boolean }[] = [
  { name: "import statement", code: `import { A } from "../harness/leaf"; export const x = A;`, seen: true },
  { name: "unused binding", code: `import { A } from "../harness/leaf"; export const x = 1;`, seen: true },
  {
    name: "binding used only under if(false)",
    code: `import { A } from "../harness/leaf"; const F = false as boolean; export const x = F ? A : 1;`,
    seen: true,
  },
  { name: "re-export barrel hop", code: `import { A } from "../harness/index"; export const x = 1;`, seen: true },
  { name: "export-from", code: `export { A } from "../harness/leaf";`, seen: true },
  { name: "export-star", code: `export * from "../harness/leaf";`, seen: true },
  { name: "side-effect only", code: `import "../harness/leaf";`, seen: true },
  {
    name: "inline type modifier with a value import",
    code: `import { type A, B } from "../harness/leaf"; export const x: A = B as never;`,
    seen: true,
  },
  {
    name: "dynamic import with a literal specifier",
    code: `export const f = async () => (await import("../harness/leaf")).A;`,
    seen: true,
  },
  { name: "require with a literal specifier", code: `const m = require("../harness/leaf"); export const x = m.A;`, seen: true },

  // The two documented blind spots.
  {
    name: "type-only import (erased before the parser reports it)",
    code: `import type { A } from "../harness/leaf"; export const x: A = 1 as never;`,
    seen: false,
  },
  {
    name: "concatenated specifier (outside static analysis)",
    code: `const p = "../harness" + "/leaf"; export const f = async () => import(p);`,
    seen: false,
  },
  {
    name: "template-literal specifier with a substitution (outside static analysis)",
    code: `const d = "harness"; export const f = async () => import(\`../\${d}/leaf\`);`,
    seen: false,
  },
];

test("the import shapes the header claims are SEEN are the ones the parser reports", () => {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const measured = IMPORT_SHAPES.map(({ name, code }) => ({
    name,
    seen: transpiler.scanImports(code).some((i) => i.path === "../harness/leaf" || i.path === "../harness/index"),
  }));
  expect(measured).toEqual(IMPORT_SHAPES.map(({ name, seen }) => ({ name, seen })));
});

/**
 * The same shapes end to end, through the check rather than through the parser
 * alone — a shape the parser reports but the resolver then drops would satisfy
 * the assertion above and still be invisible to the policy.
 */
test("every SEEN shape produces a finding end to end, and every UNSEEN shape produces none", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-shapes-"));
  try {
    await mkdir(path.join(root, "harness"), { recursive: true });
    await mkdir(path.join(root, "gdgraph"), { recursive: true });
    await writeFile(path.join(root, "harness", "leaf.ts"), `export const A = "leaf";\nexport const B = "b";\n`);
    await writeFile(path.join(root, "harness", "index.ts"), `export { A } from "./leaf";\n`);

    const results: { name: string; found: boolean }[] = [];
    for (const { name, code } of IMPORT_SHAPES) {
      await writeFile(path.join(root, "gdgraph", "entry.ts"), code);
      const report = await checkImportPolicy({ root });
      results.push({ name, found: report.findings.some((f) => f.kind === "owner-imports-client") });
    }
    expect(results).toEqual(IMPORT_SHAPES.map(({ name, seen }) => ({ name, found: seen })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 2. The zone table covers the tree ────────────────────────────────────────

test("ZONE_TABLE names every top-level segment that exists under src/", () => {
  // Derived from the filesystem, not restated from the table. `src/eval`,
  // `src/retention` and `src/sync` were all absent while the old
  // `ZONE_TABLE.length > 10` assertion passed.
  expect(unclassifiedSegments(SRC)).toEqual([]);
});

test("ZONE_TABLE names nothing that no longer exists under src/", () => {
  // The other direction: a table entry for a deleted directory is dead policy
  // that quietly stops applying to anything.
  expect(staleSegments(SRC)).toEqual([]);
});

test("the coverage assertion can fail: an unnamed segment is reported", async () => {
  // Reverting the guard is the only proof it is not vacuous. A directory the
  // table does not name must appear in `unclassifiedSegments`.
  const root = await mkdtemp(path.join(tmpdir(), "keryx-segments-"));
  try {
    await mkdir(path.join(root, "gdgraph"), { recursive: true });
    await mkdir(path.join(root, "a-directory-no-table-entry-names"), { recursive: true });
    await writeFile(path.join(root, "top-level-module.ts"), "export const x = 1;\n");
    expect(unclassifiedSegments(root)).toEqual(["a-directory-no-table-entry-names", "top-level-module.ts"]);
    // …and a segment the table DOES name is not reported, so the detector is
    // not simply reporting everything.
    expect(listZoneSegments(root)).toContain("gdgraph");
    expect(unclassifiedSegments(root)).not.toContain("gdgraph");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZONE_TABLE names every zone at least once", () => {
  expect([...new Set(ZONE_TABLE.map((e) => e.zone))].sort()).toEqual(["adapter", "client", "core", "shared"]);
});

test("ZONE_TABLE has no duplicate segment", () => {
  const segments = ZONE_TABLE.map((e) => e.segment);
  expect(segments.length).toBe(new Set(segments).size);
});

test("zoneOf classifies directories, top-level modules, and leaves an unknown segment unclassified", () => {
  expect(zoneOf("/repo/src", "/repo/src/gdgraph/query.ts")).toBe("core");
  expect(zoneOf("/repo/src", "/repo/src/harness/run.ts")).toBe("client");
  expect(zoneOf("/repo/src", "/repo/src/commands/agent.ts")).toBe("adapter");
  expect(zoneOf("/repo/src", "/repo/src/lib/fs.ts")).toBe("shared");
  // The two top-level modules the directory-only table could not answer for.
  expect(zoneOf("/repo/src", "/repo/src/cli.ts")).toBe("adapter");
  expect(zoneOf("/repo/src", "/repo/src/core.ts")).toBe("core");
  // The three directories that were uncovered.
  expect(zoneOf("/repo/src", "/repo/src/eval/gate.ts")).toBe("core");
  expect(zoneOf("/repo/src", "/repo/src/retention/sweep.ts")).toBe("core");
  expect(zoneOf("/repo/src", "/repo/src/sync/provenance.ts")).toBe("core");
  expect(zoneOf("/repo/src", "/repo/src/some-new-dir/x.ts")).toBeUndefined();
});

test("topSegmentOf handles a path outside the root and a root-relative path alike", () => {
  expect(topSegmentOf("/repo/src", "/repo/src/gdgraph/q.ts")).toBe("gdgraph");
  expect(topSegmentOf("/repo/src", "/elsewhere/x/y.ts")).toBe("elsewhere");
  expect(topSegmentOf("/repo/src", "/repo/src")).toBeUndefined();
});

// ── 3. An unclassified zone is not a pass ────────────────────────────────────

let unclassifiedRoot = "";

beforeAll(async () => {
  unclassifiedRoot = await mkdtemp(path.join(tmpdir(), "keryx-unclassified-"));
  await mkdir(path.join(unclassifiedRoot, "not-in-the-table"), { recursive: true });
  await mkdir(path.join(unclassifiedRoot, "lib"), { recursive: true });
  await writeFile(path.join(unclassifiedRoot, "lib", "shared.ts"), `export const S = "shared";\n`);
  await writeFile(
    path.join(unclassifiedRoot, "not-in-the-table", "entry.ts"),
    `import { S } from "../lib/shared";\nexport const x = S;\n`,
  );
});

afterAll(async () => {
  if (unclassifiedRoot !== "") {
    await rm(unclassifiedRoot, { recursive: true, force: true });
  }
});

test("a file in an unclassified zone produces a finding, not silence", async () => {
  const report = await checkImportPolicy({ root: unclassifiedRoot });

  // The old check returned `violations: []` here. The whole point of this
  // assertion is that "I do not know what zone this is" now reaches the caller
  // through the SAME channel a real violation does, so an existing
  // `findings.length === 0` gate catches it without being taught to.
  expect(report.findings.length).toBeGreaterThan(0);
  expect(report.findings.map((f) => f.kind)).toContain("unclassified-zone");
  expect(report.findings.some((f) => f.from.endsWith(path.join("not-in-the-table", "entry.ts")))).toBe(true);
});

test("an unresolvable relative specifier is a finding, not a dropped edge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-unresolved-"));
  try {
    await mkdir(path.join(root, "gdgraph"), { recursive: true });
    await writeFile(path.join(root, "gdgraph", "entry.ts"), `import { X } from "./nowhere";\nexport const x = X;\n`);
    const report = await checkImportPolicy({ root });
    expect(report.findings.map((f) => f.kind)).toContain("unresolved-relative-specifier");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bare specifier is out of scope and produces no finding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-bare-"));
  try {
    await mkdir(path.join(root, "gdgraph"), { recursive: true });
    await writeFile(path.join(root, "gdgraph", "entry.ts"), `import path from "node:path";\nexport const x = path.sep;\n`);
    const report = await checkImportPolicy({ root });
    expect(report.findings).toEqual([]);
    expect(report.edges).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Resolution ───────────────────────────────────────────────────────────────

test("resolveSpecifier follows the conventions this repository uses, and only relative ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-resolve-"));
  try {
    await mkdir(path.join(root, "pkg"), { recursive: true });
    await writeFile(path.join(root, "sibling.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "pkg", "index.ts"), "export const b = 2;\n");
    const from = path.join(root, "entry.ts");

    expect(resolveSpecifier(from, "./sibling")).toBe(path.join(root, "sibling.ts"));
    expect(resolveSpecifier(from, "./sibling.ts")).toBe(path.join(root, "sibling.ts"));
    expect(resolveSpecifier(from, "./pkg")).toBe(path.join(root, "pkg", "index.ts"));
    expect(resolveSpecifier(from, "./missing")).toBeUndefined();
    // Bare specifiers are deliberately out of scope: they leave `src/`.
    expect(resolveSpecifier(from, "node:path")).toBeUndefined();
    expect(resolveSpecifier(from, "bun")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listSourceFiles finds modules and excludes test files", async () => {
  const files = listSourceFiles(SRC);
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((f) => f.endsWith(path.join("src", "cli.ts")))).toBe(true);
  expect(files.some((f) => f.includes(".test."))).toBe(false);
});

test("checkImportPolicy refuses an empty file list instead of reporting a clean result", async () => {
  await expect(checkImportPolicy({ root: SRC, files: [] })).rejects.toThrow(/nothing to scan/);
});
