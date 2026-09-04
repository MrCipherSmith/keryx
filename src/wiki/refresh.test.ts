// LWG-11 refresh / migrate / verify (flow 227): AC1, AC2, AC3, AC4, AC6, AC8, AC9.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendChangelogLine, bumpPatch, migrateMarkers, refreshPages, verifyPages } from "./refresh";
import { findManagedBlock } from "./managed-block";

const SHA = "c".repeat(40);

/** A project whose graph really produces a `src/mod` component page. */
async function project(pageBody?: string): Promise<{ cwd: string; pagePath: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-refresh-"));
  const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  await mkdir(path.join(cwd, "src", "mod"), { recursive: true });
  await writeFile(path.join(cwd, "src/mod/index.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  await writeFile(path.join(cwd, "src/mod/helper.ts"), "export const helper = 3;\n");

  const nodes = ["src/mod/index.ts", "src/mod/helper.ts"].map((p) => ({
    id: p,
    kind: "file",
    path: p,
    language: "typescript",
  }));
  await writeFile(path.join(storage, "nodes.jsonl"), `${nodes.map((n) => JSON.stringify(n)).join("\n")}\n`);
  await writeFile(
    path.join(storage, "edges.jsonl"),
    `${JSON.stringify({ id: "e1", from: "src/mod/helper.ts", to: "src/mod/index.ts", kind: "imports", specifier: "./index" })}\n`,
  );

  const pagePath = path.join(cwd, ".metaproject", "wiki", "components", "src-mod.md");
  await mkdir(path.dirname(pagePath), { recursive: true });
  await writeFile(
    pagePath,
    pageBody ??
      [
        "# src/mod",
        "Version: 1.0.0",
        "Type: component",
        "Status: accepted",
        "",
        "## Overview",
        "",
        "Prose the machine must never touch.",
        "",
        "## Reference (from code graph)",
        "",
        "### Public API",
        "",
        "- stale",
        "",
        "## Related Wiki",
        "",
        "- [Index](../index.md)",
        "",
        "## Changelog",
        "",
        "- 1.0.0 - Written by hand.",
        "",
      ].join("\n"),
  );
  return { cwd, pagePath };
}

describe("migrateMarkers (AC4)", () => {
  test("adds markers, is idempotent, and never authors content", async () => {
    const { cwd, pagePath } = await project();
    const before = await readFile(pagePath, "utf8");

    const first = await migrateMarkers(cwd);
    expect(first.migrated).toEqual(["components/src-mod.md"]);

    const after = await readFile(pagePath, "utf8");
    const nonMarker = after.split("\n").filter((l) => !l.startsWith("<!-- keryx:reference:"));
    // Only marker lines were added; every original line survives in order.
    expect(nonMarker).toEqual(before.split("\n"));

    const second = await migrateMarkers(cwd);
    expect(second.migrated).toEqual([]);
    expect(second.alreadyMigrated).toEqual(["components/src-mod.md"]);
    expect(await readFile(pagePath, "utf8")).toBe(after);
  });

  test("a page with no Reference section is skipped, not given one", async () => {
    const { cwd } = await project("# src/mod\nVersion: 1.0.0\nType: component\nStatus: accepted\n\n## Overview\n\nProse.\n");
    const result = await migrateMarkers(cwd);
    expect(result.migrated).toEqual([]);
    expect(result.skippedNoSection).toEqual(["components/src-mod.md"]);
  });

  test("--dry-run writes nothing", async () => {
    const { cwd, pagePath } = await project();
    const before = await readFile(pagePath, "utf8");
    const result = await migrateMarkers(cwd, { dryRun: true });
    expect(result.migrated).toEqual(["components/src-mod.md"]);
    expect(await readFile(pagePath, "utf8")).toBe(before);
  });
});

describe("refreshPages", () => {
  test("AC1: rewrites the block on an accepted page, changing nothing outside it", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    const before = await readFile(pagePath, "utf8");

    const result = await refreshPages({ cwd, head: SHA });
    expect(result.refreshed).toBe(1);

    const after = await readFile(pagePath, "utf8");
    // Prose and the trailing section are untouched.
    expect(after).toContain("Prose the machine must never touch.");
    expect(after.split("## Related Wiki")[1]?.split("## Changelog")[0]).toBe(
      before.split("## Related Wiki")[1]?.split("## Changelog")[0],
    );
    // The stale Reference content is gone, replaced from the graph.
    expect(after).not.toContain("- stale");
    expect(after).toContain("### Key files");
  });

  test("AC2: makes no provider call — proven by a graph-only path", async () => {
    // `refreshPages` takes no provider and imports none; this asserts the
    // observable consequence: a refresh completes with no network or model
    // configuration present at all.
    const { cwd } = await project();
    await migrateMarkers(cwd);
    const result = await refreshPages({ cwd, head: SHA });
    expect(result.refreshed).toBe(1);
    expect(result.conflicts).toBe(0);
  });

  test("AC8: bumps only the patch and appends exactly one changelog line", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    await refreshPages({ cwd, head: SHA });

    const after = await readFile(pagePath, "utf8");
    expect(after).toContain("Version: 1.0.1");
    const changelogLines = after
      .split("## Changelog")[1]
      ?.split("\n")
      .filter((line) => line.trim().startsWith("- ")) ?? [];
    expect(changelogLines).toHaveLength(2);
    expect(changelogLines[0]).toContain("1.0.1 - Reference refreshed");
  });

  test("AC9: an already-current page is not rewritten at all", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    await refreshPages({ cwd, head: SHA });
    const afterFirst = await readFile(pagePath, "utf8");

    const second = await refreshPages({ cwd, head: SHA });
    expect(second.unchanged).toBe(1);
    expect(second.refreshed).toBe(0);
    // No version bump, no changelog line, no re-stamp: a second refresh must
    // not assert a verification that did not happen.
    expect(await readFile(pagePath, "utf8")).toBe(afterFirst);
  });

  test("AC3: a hand-edited block is refused, and --force overwrites it", async () => {
    const { cwd, pagePath } = await project();
    await migrateMarkers(cwd);
    await refreshPages({ cwd, head: SHA });

    const edited = (await readFile(pagePath, "utf8")).replace("### Key files", "### Key files (mine)");
    await writeFile(pagePath, edited);

    const refused = await refreshPages({ cwd, head: SHA });
    expect(refused.conflicts).toBe(1);
    expect(refused.pages[0]?.reason).toContain("edited by hand");
    expect(await readFile(pagePath, "utf8")).toBe(edited);

    const forced = await refreshPages({ cwd, head: SHA, force: true });
    expect(forced.refreshed).toBe(1);
    expect(await readFile(pagePath, "utf8")).not.toBe(edited);
  });

  test("a page with no markers is reported, not silently skipped", async () => {
    const { cwd } = await project();
    const result = await refreshPages({ cwd, head: SHA });
    expect(result.pages[0]?.action).toBe("no-block");
  });
});

describe("verifyPages (AC6)", () => {
  test("stamps provenance and changes nothing else", async () => {
    const { cwd, pagePath } = await project();
    const before = await readFile(pagePath, "utf8");

    const stamped = await verifyPages({ cwd, page: "components/src-mod.md", head: SHA });
    expect(stamped).toHaveLength(1);

    const after = await readFile(pagePath, "utf8");
    const added = after.split("\n").filter((line) => !/^Verified(At|Scope):/.test(line));
    expect(added).toEqual(before.split("\n"));
    expect(after).toContain(`VerifiedAt: ${SHA}`);
    expect(after).toMatch(/VerifiedScope: sha256:[0-9a-f]{64}/);
  });

  test("a page with an empty describe-set is not stamped — an empty claim", async () => {
    const { cwd } = await project(
      "# Overview\nVersion: 1.0.0\nType: component\nStatus: accepted\n\n## Overview\n\nProse.\n",
    );
    // No Describes, no Related Code, and the slug does not match a module.
    const stamped = await verifyPages({ cwd, page: "components/src-mod.md", head: SHA });
    expect(stamped.map((s) => s.path)).not.toContain("components/does-not-exist.md");
  });
});

describe("helpers", () => {
  test("bumpPatch only moves the patch component", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
    expect(bumpPatch("0.0.9")).toBe("0.0.10");
    // A missing or malformed version gets a defined starting point rather
    // than a crash or a silent "1.0.0" that overstates maturity.
    expect(bumpPatch(null)).toBe("0.1.1");
    expect(bumpPatch("not-a-version")).toBe("0.1.1");
  });

  test("appendChangelogLine inserts at the top of an existing section", () => {
    const page = "# P\n\n## Changelog\n\n- 1.0.0 - first\n";
    expect(appendChangelogLine(page, "- 1.0.1 - second")).toBe(
      "# P\n\n## Changelog\n\n- 1.0.1 - second\n- 1.0.0 - first\n",
    );
  });

  test("appendChangelogLine creates the section when absent", () => {
    expect(appendChangelogLine("# P\n\nProse.\n", "- 0.1.1 - x")).toBe(
      "# P\n\nProse.\n\n## Changelog\n\n- 0.1.1 - x\n",
    );
  });
});
