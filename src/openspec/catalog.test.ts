import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { scanOpenSpec } from "./catalog";
import { baselineMarkdown, createOpenSpecFixture, populateOpenSpecFixture } from "./fixture";

const fixtures: ReturnType<typeof createOpenSpecFixture>[] = [];
function fixture() {
  const result = createOpenSpecFixture();
  fixtures.push(result);
  return result;
}
afterEach(() => { for (const item of fixtures.splice(0)) item.cleanup(); });

describe("OpenSpec catalog", () => {
  test("distinguishes a missing source from an empty source", async () => {
    const project = fixture();
    expect((await scanOpenSpec(project.root)).availability).toBe("missing");
    mkdirSync(path.join(project.root, "openspec"));
    expect((await scanOpenSpec(project.root)).availability).toBe("empty");
  });

  test("discovers stock collections and records byte evidence", async () => {
    const project = fixture();
    populateOpenSpecFixture(project);
    const result = await scanOpenSpec(project.root);
    expect(result.availability).toBe("ready");
    expect(result.entries.map(({ kind, path: entryPath }) => [kind, entryPath])).toEqual(expect.arrayContaining([
      ["spec", "openspec/specs/review/spec.md"],
      ["change", "openspec/changes/update-review"],
      ["change", "openspec/changes/no-delta"],
      ["archive", "openspec/changes/archive/2025-03-01-old"],
      ["archive", "openspec/changes/archive/undated"],
    ]));
    const spec = result.entries.find((entry) => entry.path === "openspec/specs/review/spec.md");
    expect(spec?.artifacts[0]?.digest).toBe(createHash("sha256").update(baselineMarkdown).digest("hex"));
    expect(result.entries.find((entry) => entry.path.endsWith("2025-03-01-old"))?.archiveDate).toBe("2025-03-01");
  });

  test("keeps valid link rows when a sibling is malformed", async () => {
    const project = fixture();
    populateOpenSpecFixture(project);
    project.write(".metaproject/openspec/links.json", JSON.stringify({ version: 1, links: [
      { source: { kind: "spec", path: "openspec/specs/review/spec.md" }, target: { kind: "file", path: "src/review.ts" } },
      { source: { kind: "spec", path: "../outside" }, target: { kind: "file", path: "src/review.ts" } },
    ] }));
    const result = await scanOpenSpec(project.root);
    expect(result.links).toHaveLength(1);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("rejects symlinked source directories outside the checkout", async () => {
    const project = fixture();
    const outside = fixture();
    outside.write("spec.md", "# Outside\n");
    mkdirSync(path.join(project.root, "openspec/specs"), { recursive: true });
    symlinkSync(outside.root, path.join(project.root, "openspec/specs/escape"));
    const result = await scanOpenSpec(project.root);
    expect(result.entries.some((entry) => entry.path.includes("escape"))).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("snapshots are scoped to the selected checkout", async () => {
    const first = fixture();
    const second = fixture();
    populateOpenSpecFixture(first);
    populateOpenSpecFixture(second);
    const [a, b] = await Promise.all([scanOpenSpec(first.root), scanOpenSpec(second.root)]);
    expect(a.snapshotId).not.toBe(b.snapshotId);
  });
});
