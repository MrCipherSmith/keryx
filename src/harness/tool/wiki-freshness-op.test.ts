// Flow 229: the freshness signal reachable by an agent. AC1-AC5.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_DESCRIPTORS } from "../../standard/command-registry";
import type { CommandDescriptor } from "../../standard/command-registry";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "./metaproject-operations";

const OP = METAPROJECT_OPERATIONS.find((op) => op.name === "wiki_freshness");

async function project(report?: unknown): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-op-"));
  if (report !== undefined) {
    const dir = path.join(cwd, ".metaproject", "data", "wiki", "freshness");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "latest.json"), JSON.stringify(report));
  }
  return cwd;
}

async function tree(cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(cwd, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(cwd);
  return out.sort();
}

const REPORT = {
  generatedAt: new Date().toISOString(),
  totals: { pagesTotal: 50, pagesFresh: 34, pagesUndecidable: 6 },
  pages: [
    { path: "components/a.md", category: "stale-reference", confidence: "must-refresh", commitsBehind: 3, verifiedAt: null },
    { path: "components/b.md", category: "stale-prose", confidence: "fyi", commitsBehind: 0, verifiedAt: null },
  ],
  limitations: [{ code: "graph-stale", detail: "the graph has not been built" }],
};

describe("the commands are discoverable (AC1, AC2)", () => {
  const byName = (name: string): CommandDescriptor | undefined =>
    COMMAND_DESCRIPTORS.find((c) => c.command === name);

  test.each(["wiki freshness", "wiki refresh", "wiki verify", "wiki migrate-markers"])(
    "%s is registered",
    (name) => {
      expect(byName(name)).toBeDefined();
    },
  );

  test("every registered wiki command declares what it writes, and none claims read-only while writing", () => {
    // `wiki freshness` changes no wiki page, but it does write its own report,
    // and `read` feeds isAutoAllowable — so `read: true` would let an agent
    // run it unapproved. The genuinely read-only path is the MCP surface.
    for (const name of ["wiki freshness", "wiki refresh", "wiki verify", "wiki migrate-markers"]) {
      const entry = byName(name);
      expect(entry?.read).toBe(false);
      // A registered write with no declared side effect is a claim the agent
      // would act on. Every one of these names what it touches.
      expect((entry?.sideEffects ?? []).length).toBeGreaterThan(0);
    }
  });

  test("every registered wiki command that advertises json really supports it", () => {
    for (const name of ["wiki freshness", "wiki refresh", "wiki verify", "wiki migrate-markers"]) {
      const entry = byName(name);
      expect(entry?.json).toBe(true);
      expect((entry?.args ?? []).some((a: { name: string }) => a.name === "json")).toBe(true);
    }
  });
});

describe("the MCP operation (AC3, AC4)", () => {
  test("limitations lead the output, before any finding list", async () => {
    const cwd = await project(REPORT);
    const result = (await OP!.invoke(createMetaprojectAdapter(cwd), {})) as { output: string };

    const incompleteAt = result.output.indexOf("INCOMPLETE");
    const findingsAt = result.output.indexOf("Pages in doubt");
    expect(incompleteAt).toBeGreaterThanOrEqual(0);
    // An agent that skims reads the top. The one thing it must not miss is
    // that a short list may mean the check could not run.
    expect(incompleteAt).toBeLessThan(findingsAt);
    expect(result.output).toContain("does not mean the wiki is fresh");
  });

  test("with no report it says so instead of returning a clean-looking empty result", async () => {
    const cwd = await project();
    const result = (await OP!.invoke(createMetaprojectAdapter(cwd), {})) as { output: string };

    expect(result.output).toContain("NO-REPORT");
    expect(result.output).toContain("not evidence that the wiki is fresh");
    expect(result.output).not.toContain("Pages in doubt");
  });

  test("a page filter narrows the list without hiding the limitations", async () => {
    const cwd = await project(REPORT);
    const result = (await OP!.invoke(createMetaprojectAdapter(cwd), {
      page: "components/a.md",
    })) as { output: string };

    expect(result.output).toContain("components/a.md");
    expect(result.output).not.toContain("components/b.md");
    expect(result.output).toContain("INCOMPLETE");
  });
});

describe("the MCP path writes nothing (AC5)", () => {
  test("the project tree is byte-for-byte identical before and after a call", async () => {
    const cwd = await project(REPORT);
    const before = await tree(cwd);
    const beforeBody = await Bun.file(
      path.join(cwd, ".metaproject", "data", "wiki", "freshness", "latest.json"),
    ).text();

    await OP!.invoke(createMetaprojectAdapter(cwd), {});

    expect(await tree(cwd)).toEqual(before);
    expect(
      await Bun.file(path.join(cwd, ".metaproject", "data", "wiki", "freshness", "latest.json")).text(),
    ).toBe(beforeBody);
  });

  test("the operation is declared read-risk", () => {
    expect(OP?.risk).toBe("read");
  });
});
