import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { assertP0Purity, snapshotProject } from "../memory/p0-test-utils";
import { memoryCommand } from "./memory";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");
const SNAPSHOT_OPTIONS = {
  paths: [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"],
  includeRuntimePaths: [
    ".metaproject/data/memory/artifacts/latest.md",
    ".metaproject/data/memory/artifacts/latest.json",
  ],
};

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-cli-p0-"));
  await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
  return root;
}

function captureOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  };
  return { lines, restore: () => { console.log = original; } };
}

test("P0-4: CLI text search is pure and prints no implicit report", async () => {
  const root = await fixtureRoot();
  const output = captureOutput();
  try {
    await withCwd(root, async () => {
      const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
      await memoryCommand(["search", "authority boundary"]);
      const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
      assertP0Purity(before, after);
    });
    expect(output.lines.join("\n")).toContain("# memory search: authority boundary");
    expect(output.lines.join("\n")).not.toContain("report:");
  } finally {
    output.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("P0-4: CLI --json emits structured text without a report artifact", async () => {
  const root = await fixtureRoot();
  const output = captureOutput();
  try {
    await withCwd(root, async () => {
      const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
      await memoryCommand(["search", "authority boundary", "--json"]);
      const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
      assertP0Purity(before, after);
    });
    const rendered = output.lines.join("\n");
    const parsed = JSON.parse(rendered) as { query: string; results: unknown[] };
    expect(parsed.query).toBe("authority boundary");
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("report:");
  } finally {
    output.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("P3: explicit diagnostic CLI search still permits a requested non-accepted status", async () => {
  const root = await fixtureRoot();
  const output = captureOutput();
  try {
    await withCwd(root, async () => {
      await memoryCommand(["search", "authority boundary", "--status", "draft", "--json"]);
    });
    const parsed = JSON.parse(output.lines.join("\n")) as { results: Array<{ status: string }> };
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.every((result) => result.status === "draft")).toBe(true);
  } finally {
    output.restore();
    await rm(root, { recursive: true, force: true });
  }
});
