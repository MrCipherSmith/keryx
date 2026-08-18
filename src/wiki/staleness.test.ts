import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../gdgraph/types";
import {
  checkPageStalenessGate,
  computePageNodeHash,
  isPageUnchangedSinceLastEnrich,
} from "./staleness";

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "gd-wiki-staleness-"));
}

function fixtureGraph(): GraphData {
  return {
    nodes: [
      { id: "src/a.ts", kind: "file", path: "src/a.ts", language: "typescript" },
      { id: "src/b.ts", kind: "file", path: "src/b.ts", language: "typescript" },
    ],
    edges: [],
  };
}

test("T5/computePageNodeHash — deterministic: same inputs produce the same hash", async () => {
  const cwd = await tempRepo();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(cwd, "src/b.ts"), "export const b = 2;\n", "utf8");

    const graph = fixtureGraph();
    const first = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);
    const second = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);
    expect(first).toBe(second);

    // Order of `keyFiles` must not matter — only content/membership.
    const reordered = await computePageNodeHash(cwd, ["src/b.ts", "src/a.ts"], graph);
    expect(reordered).toBe(first);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/computePageNodeHash — changes when a key file's content changes", async () => {
  const cwd = await tempRepo();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(cwd, "src/b.ts"), "export const b = 2;\n", "utf8");

    const graph = fixtureGraph();
    const before = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);

    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 999;\n", "utf8");
    const after = await computePageNodeHash(cwd, ["src/a.ts", "src/b.ts"], graph);

    expect(after).not.toBe(before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/computePageNodeHash — a key file that is not a graph node hashes as a stable sentinel, not a crash", async () => {
  const cwd = await tempRepo();
  try {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n", "utf8");

    const graph = fixtureGraph(); // knows src/a.ts and src/b.ts, not src/missing.ts
    const withUnknown = await computePageNodeHash(cwd, ["src/a.ts", "src/missing.ts"], graph);
    const withoutUnknown = await computePageNodeHash(cwd, ["src/a.ts"], graph);
    expect(withUnknown).not.toBe(withoutUnknown);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/isPageUnchangedSinceLastEnrich — true only when a hash is recorded and equal", () => {
  const recorded = { "components/alpha.md": "abc123" };
  expect(isPageUnchangedSinceLastEnrich("components/alpha.md", "abc123", recorded)).toBe(true);
  expect(isPageUnchangedSinceLastEnrich("components/alpha.md", "different", recorded)).toBe(false);
  expect(isPageUnchangedSinceLastEnrich("components/beta.md", "abc123", recorded)).toBe(false);
  expect(isPageUnchangedSinceLastEnrich("components/alpha.md", "abc123", undefined)).toBe(false);
});

test("T5/checkPageStalenessGate — repoMaybeStale false when the graph build postdates .git/HEAD", async () => {
  const cwd = await tempRepo();
  try {
    const gitDir = path.join(cwd, ".git");
    const storageDir = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(gitDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(storageDir, "nodes.jsonl"), "", "utf8");

    const old = new Date(Date.now() - 60_000);
    const recent = new Date();
    // HEAD older than the graph build ⇒ repo has not moved since ⇒ not stale.
    await utimes(path.join(gitDir, "HEAD"), old, old);
    await utimes(path.join(storageDir, "nodes.jsonl"), recent, recent);

    const gate = await checkPageStalenessGate(cwd);
    expect(gate.repoMaybeStale).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("T5/checkPageStalenessGate — repoMaybeStale true when .git/HEAD postdates the graph build", async () => {
  const cwd = await tempRepo();
  try {
    const gitDir = path.join(cwd, ".git");
    const storageDir = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(gitDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(storageDir, "nodes.jsonl"), "", "utf8");

    const old = new Date(Date.now() - 60_000);
    const recent = new Date();
    // Graph build older than HEAD ⇒ repo moved since the last build ⇒ maybe stale.
    await utimes(path.join(storageDir, "nodes.jsonl"), old, old);
    await utimes(path.join(gitDir, "HEAD"), recent, recent);

    const gate = await checkPageStalenessGate(cwd);
    expect(gate.repoMaybeStale).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
