// A-8 (flow 356, audit remediation 3): `bunfig.toml` `preload` entries are
// real callers `keryx gdgraph query orphans` cannot see (they run by config,
// never by `import`) — `src/lib/test-preload.ts` reported as dead code on
// this repository's own tree is the motivating false positive.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { bunfigPreloadRoots, getOrphans } from "./query";
import type { GraphData } from "./types";

// An isolated node: zero inbound, zero outbound edges — exactly the shape a
// preload-only file has (nothing imports it, and it imports nothing of the
// project's own tree).
const ISOLATED: GraphData = {
  nodes: [
    { id: "src/lib/test-preload.ts", kind: "file", path: "src/lib/test-preload.ts", language: "typescript" },
    { id: "src/orphan.ts", kind: "file", path: "src/orphan.ts", language: "typescript" },
  ],
  edges: [],
};

describe("getOrphans: roots (A-8)", () => {
  test("with no roots, every isolated node is an orphan — the pre-existing behaviour", () => {
    expect(getOrphans(ISOLATED)).toEqual(["src/lib/test-preload.ts", "src/orphan.ts"]);
  });

  test("a root is excluded from the orphan set; a non-root isolated node still reports", () => {
    const orphans = getOrphans(ISOLATED, new Set(["src/lib/test-preload.ts"]));
    expect(orphans).toEqual(["src/orphan.ts"]);
  });
});

describe("bunfigPreloadRoots: reads bunfig.toml preload entries as graph-relative paths", () => {
  let root: string;

  async function withBunfig(contents: string): Promise<void> {
    await writeFile(path.join(root, "bunfig.toml"), contents, "utf8");
  }

  test("a [test]-scoped preload array (this repository's own shape) resolves to a graph-relative path", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-bunfig-"));
    try {
      await withBunfig('[test]\npreload = ["./src/lib/test-preload.ts"]\n');
      const roots = await bunfigPreloadRoots(root);
      expect(roots).toEqual(new Set(["src/lib/test-preload.ts"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a top-level preload array (the bun run/bunx shape) is read too", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-bunfig-"));
    try {
      await withBunfig('preload = ["./scripts/boot.ts"]\n');
      const roots = await bunfigPreloadRoots(root);
      expect(roots).toEqual(new Set(["scripts/boot.ts"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("multiple entries across both shapes are all collected", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-bunfig-"));
    try {
      await withBunfig(
        'preload = ["./scripts/boot.ts"]\n\n[test]\npreload = ["./src/lib/test-preload.ts", "./src/lib/other-preload.ts"]\n',
      );
      const roots = await bunfigPreloadRoots(root);
      expect(roots).toEqual(
        new Set(["scripts/boot.ts", "src/lib/test-preload.ts", "src/lib/other-preload.ts"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no bunfig.toml at all yields no roots, not an error", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-bunfig-"));
    try {
      const roots = await bunfigPreloadRoots(root);
      expect(roots).toEqual(new Set());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a bunfig.toml with no preload key at all yields no roots", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-bunfig-"));
    try {
      await withBunfig('[install]\nregistry = "https://registry.npmjs.org"\n');
      const roots = await bunfigPreloadRoots(root);
      expect(roots).toEqual(new Set());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("end to end on a fixture project: the preloaded file is excluded from query orphans, a real orphan still reports", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-bunfig-"));
    try {
      await withBunfig('[test]\npreload = ["./src/lib/test-preload.ts"]\n');
      const roots = await bunfigPreloadRoots(root);
      expect(getOrphans(ISOLATED, roots)).toEqual(["src/orphan.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
