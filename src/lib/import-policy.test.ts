// Import-policy check, tested against real fixtures (flow 239, AC-20 /
// AFC-20: "Import-policy проверка ловит запрещённый fixture и проходит
// разрешённый"). Both fixture trees live in the repo, under
// `fixtures/import-policy/` — see that directory's README for the layout —
// so this test demonstrates the check actually FIRES, not merely that its
// code exists.
//
// The two directions asserted mirror `specification.md` §2 exactly: an owner
// (core) never reaches CLI/MCP/Shell (client/adapter), and a client/adapter
// reaches a core owner only through its `service.ts` facade.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { checkImportBoundary } from "./import-policy";
import { ZONE_TABLE, zoneOf } from "./import-zones";

const FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures/import-policy/", import.meta.url));

function fixture(...parts: string[]): string {
  return path.join(FIXTURES_ROOT, ...parts);
}

test("ZONE_TABLE names every zone at least once — a table missing a zone is a table nothing can test", () => {
  const zones = new Set(ZONE_TABLE.map((e) => e.zone));
  expect([...zones].sort()).toEqual(["adapter", "client", "core", "shared"]);
  expect(ZONE_TABLE.length).toBeGreaterThan(10);
});

test("zoneOf classifies a known directory and leaves an unknown one unclassified", () => {
  expect(zoneOf("/repo/src", "/repo/src/gdgraph/query.ts")).toBe("core");
  expect(zoneOf("/repo/src", "/repo/src/harness/run.ts")).toBe("client");
  expect(zoneOf("/repo/src", "/repo/src/commands/agent.ts")).toBe("adapter");
  expect(zoneOf("/repo/src", "/repo/src/lib/fs.ts")).toBe("shared");
  expect(zoneOf("/repo/src", "/repo/src/some-new-dir/x.ts")).toBeUndefined();
});

// Every fixture entry named below must actually exist — otherwise a deleted
// fixture and a passing test would look identical, the exact class-1 defect
// (a capability nothing calls / nothing proves) this phase's inventory found
// in this same file's neighbour, `production-graph.test.ts`.
test("every fixture entry this file drives actually exists on disk", async () => {
  const entries = [
    fixture("forbidden-owner-imports-client", "gdgraph", "entry.ts"),
    fixture("allowed-owner-imports-shared", "gdgraph", "entry.ts"),
    fixture("forbidden-client-imports-core-internal", "harness", "entry.ts"),
    fixture("allowed-client-imports-core-facade", "harness", "entry.ts"),
  ];
  for (const entry of entries) {
    expect({ entry, exists: await Bun.file(entry).exists() }).toEqual({ entry, exists: true });
  }
});

test("catches a forbidden fixture: a core owner reaching into a client zone", async () => {
  const root = fixture("forbidden-owner-imports-client");
  const entry = path.join(root, "gdgraph", "entry.ts");
  const result = await checkImportBoundary({ entry, root });

  expect(result.entryZone).toBe("core");
  // Real resolution happened: the entry PLUS the client leaf it reaches, not
  // just the entry counted alone and not an empty graph from a build that
  // silently did nothing.
  expect(result.scanned).toBeGreaterThan(1);
  expect(result.violations.length).toBeGreaterThan(0);
  expect(result.violations.some((v) => v.source.endsWith(path.join("harness", "leaf.ts")) && v.zone === "client")).toBe(
    true,
  );
});

test("passes an allowed fixture: a core owner reaching only a shared primitive", async () => {
  const root = fixture("allowed-owner-imports-shared");
  const entry = path.join(root, "gdgraph", "entry.ts");
  const result = await checkImportBoundary({ entry, root });

  expect(result.entryZone).toBe("core");
  expect(result.scanned).toBeGreaterThan(1);
  expect(result.violations).toEqual([]);
});

test("catches a forbidden fixture: a client reaching a core owner's private internal", async () => {
  const root = fixture("forbidden-client-imports-core-internal");
  const entry = path.join(root, "harness", "entry.ts");
  const result = await checkImportBoundary({ entry, root });

  expect(result.entryZone).toBe("client");
  expect(result.scanned).toBeGreaterThan(1);
  expect(result.violations.length).toBeGreaterThan(0);
  expect(
    result.violations.some((v) => v.source.endsWith(path.join("gdgraph", "internal.ts")) && v.zone === "core"),
  ).toBe(true);
});

test("passes an allowed fixture: a client reaching a core owner strictly through service.ts", async () => {
  const root = fixture("allowed-client-imports-core-facade");
  const entry = path.join(root, "harness", "entry.ts");
  const result = await checkImportBoundary({ entry, root });

  expect(result.entryZone).toBe("client");
  // The facade module really was reached — otherwise a check that resolved
  // nothing would pass for the same reason a broken scan does.
  expect(result.scanned).toBeGreaterThan(1);
  expect(result.violations).toEqual([]);
});

// The fixture directory itself must contain exactly the pairs this file
// drives — a fixture silently added or renamed under `fixtures/import-policy/`
// without a matching test is the same unproven-capability shape this whole
// check exists to close.
test("fixtures/import-policy/ contains exactly the four directories this file drives", async () => {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  expect(dirs).toEqual([
    "allowed-client-imports-core-facade",
    "allowed-owner-imports-shared",
    "forbidden-client-imports-core-internal",
    "forbidden-owner-imports-client",
  ]);
});
