import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LAYERS_VERSION, layersCurrent, packageGraphDir, resolveCommit, type LayersFile } from "./layers";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-layers-current-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function layers(over: Partial<LayersFile> = {}, nodes = 3): LayersFile {
  return {
    version: LAYERS_VERSION,
    refreshedAt: "2026-10-13T00:00:00.000Z",
    prHead: HEAD,
    base: null,
    graphCommit: HEAD,
    graph: { status: "ok", commit: HEAD, builtAt: null, nodes, edges: 0 },
    wiki: { status: "skipped", commit: null, builtAt: null, pagesRefreshed: 0, pagesStaleProse: null, written: false, divergence: { state: "unknown", workingCopyCommit: null, prHead: HEAD, commitsBetween: null, changedPaths: [] } },
    memory: { status: "skipped", commit: null, builtAt: null, entries: 0, divergence: { state: "unknown", workingCopyCommit: null, prHead: HEAD, commitsBetween: null, changedPaths: [] } },
    ...over,
  };
}

async function writeGraph(commit: string, nodesFile: string | null): Promise<void> {
  const graphDir = packageGraphDir(dir);
  await mkdir(path.join(graphDir, "storage"), { recursive: true });
  await writeFile(path.join(graphDir, "build.json"), JSON.stringify({ commit }), "utf8");
  if (nodesFile !== null) await writeFile(path.join(graphDir, "storage", "nodes.jsonl"), nodesFile, "utf8");
}

describe("layersCurrent decides whether a recorded graph can be reused", () => {
  test("an intact graph at the recorded head is current, for the same head or any head", async () => {
    await writeGraph(HEAD, '{"id":"n1"}\n');
    expect(await layersCurrent(dir, layers())).toBe(true);
    expect(await layersCurrent(dir, layers(), HEAD)).toBe(true);
  });

  test("a different requested head, no record or a failed graph is not current", async () => {
    await writeGraph(HEAD, '{"id":"n1"}\n');
    expect(await layersCurrent(dir, layers(), OTHER)).toBe(false);
    expect(await layersCurrent(dir, null)).toBe(false);
    expect(await layersCurrent(dir, layers({ graph: { status: "failed", commit: null, builtAt: null, nodes: 0, edges: 0 } }))).toBe(false);
  });

  test("a graph built at another commit than the recorded head is not current even when its directory is intact", async () => {
    await writeGraph(OTHER, '{"id":"n1"}\n');
    expect(await layersCurrent(dir, layers({ graphCommit: OTHER }))).toBe(false);
    expect(await layersCurrent(dir, layers({ graphCommit: OTHER }), HEAD)).toBe(false);
  });

  test("a build record naming another commit than the layers record is not current", async () => {
    await writeGraph(OTHER, '{"id":"n1"}\n');
    expect(await layersCurrent(dir, layers())).toBe(false);
  });

  test("a graph with nodes needs a non-empty nodes file", async () => {
    await writeGraph(HEAD, null);
    expect(await layersCurrent(dir, layers())).toBe(false);
    await writeGraph(HEAD, "");
    expect(await layersCurrent(dir, layers())).toBe(false);
  });

  test("an empty graph at the head needs no nodes file", async () => {
    await writeGraph(HEAD, null);
    expect(await layersCurrent(dir, layers({}, 0))).toBe(true);
  });

  test("a recorded graph whose directory is gone is not current", async () => {
    expect(await layersCurrent(dir, layers())).toBe(false);
    expect(await layersCurrent(dir, layers({ graphCommit: null }))).toBe(false);
  });
});

describe("resolveCommit accepts only a full commit id from git", () => {
  const gitSays = (out: string | null) => ({ git: async () => out });

  test("returns a full sha-1 or sha-256 id and nothing else git might print", async () => {
    expect(await resolveCommit(dir, "main", gitSays(HEAD))).toBe(HEAD);
    expect(await resolveCommit(dir, "main", gitSays("c".repeat(64)))).toBe("c".repeat(64));
    expect(await resolveCommit(dir, "main", gitSays("abc123"))).toBeNull();
    expect(await resolveCommit(dir, "main", gitSays("fatal: not a revision"))).toBeNull();
    expect(await resolveCommit(dir, "main", gitSays(""))).toBeNull();
    expect(await resolveCommit(dir, "main", gitSays(null))).toBeNull();
  });

  test("a revision that looks like an option never reaches git", async () => {
    let called = false;
    const deps = { git: async () => { called = true; return HEAD; } };
    expect(await resolveCommit(dir, "--upload-pack=x", deps)).toBeNull();
    expect(called).toBe(false);
  });
});
