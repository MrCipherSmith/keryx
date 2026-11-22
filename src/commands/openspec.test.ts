import { describe, expect, test } from "bun:test";
import { parseOpenSpecArgs } from "./openspec";

describe("OpenSpec command arguments", () => {
  test("accepts list, show and search with their scoped options", () => {
    expect(parseOpenSpecArgs(["list", "--kind", "archive", "--cursor", "next", "--json"])).toEqual({ action: "list", kind: "archive", cursor: "next", json: true });
    const digest = "a".repeat(64);
    expect(parseOpenSpecArgs(["show", "openspec/specs/a/spec.md", "--artifact", "openspec/specs/a/spec.md", "--section", "s1", "--expected-digest", digest])).toEqual({ action: "show", path: "openspec/specs/a/spec.md", artifactPath: "openspec/specs/a/spec.md", section: "s1", expectedDigest: digest, json: false });
    expect(parseOpenSpecArgs(["search", "review", "--scope", "all"])).toEqual({ action: "search", query: "review", scope: "all", json: false });
  });

  test("rejects unknown, duplicated, missing and misplaced arguments", () => {
    for (const args of [["list", "--kind", "spec", "--unknown"], ["list", "--kind", "spec", "--kind", "change"], ["list", "--kind"], ["search", "query", "--artifact", "x"], ["show", "x", "extra"], ["show", "x", "--section", "s1"], ["show", "x", "--expected-digest", "wrong"], ["list", "--kind", "other"]]) {
      expect(() => parseOpenSpecArgs(args)).toThrow();
    }
  });
});

test("CLI JSON search preserves reader snapshot and section evidence", async () => {
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { createOpenSpecFixture, populateOpenSpecFixture } = await import("../openspec/fixture");
  const { readOpenSpec } = await import("../openspec/service");
  const fixture = createOpenSpecFixture();
  try {
    populateOpenSpecFixture(fixture);
    const reader = await readOpenSpec(fixture.root);
    const expected = reader.search({ query: "Exact Name" });
    const command = spawnSync(process.execPath, [resolve(import.meta.dir, "../cli.ts"), "openspec", "search", "Exact Name", "--json"], { cwd: fixture.root, encoding: "utf8" });
    expect(command.status).toBe(0);
    const output = JSON.parse(command.stdout) as { schemaVersion: number; snapshotId: string; items: typeof expected.items };
    expect(output.schemaVersion).toBe(2);
    expect(output.snapshotId).toBe(expected.snapshotId);
    expect(output.items).toEqual(expected.items);
    const hit = output.items.find((item) => item.section);
    if (!hit?.source || !hit.section) throw new Error("expected a section locator");
    const showArgs = [resolve(import.meta.dir, "../cli.ts"), "openspec", "show", hit.entry.path,
      "--artifact", hit.source.path, "--section", hit.section, "--expected-digest", hit.source.digest, "--json"];
    expect(spawnSync(process.execPath, showArgs, { cwd: fixture.root, encoding: "utf8" }).status).toBe(0);
    fixture.write(hit.source.path, "### Requirement: Exact Name\nInserted heading\n");
    const stale = spawnSync(process.execPath, showArgs, { cwd: fixture.root, encoding: "utf8" });
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ schemaVersion: 2, error: { code: "stale-section" } });
  } finally {
    fixture.cleanup();
  }
});
