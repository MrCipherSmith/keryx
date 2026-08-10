import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { assertP0Purity, snapshotProject } from "../memory/p0-test-utils";
import { buildApprovalContext } from "./agent-approval-context";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");
const SNAPSHOT_OPTIONS = {
  paths: [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"],
  includeRuntimePaths: [
    ".metaproject/data/memory/artifacts/latest.md",
    ".metaproject/data/memory/artifacts/latest.json",
  ],
};

test("P0-7: approval-context advisory lookup is best-effort and purity-characterized", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-approval-p0-"));
  try {
    await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
    const port: MetaprojectPort = {
      searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
      graphAffected: async ({ target }) => ({ target, affected: [] }),
      graphQuery: async ({ query }) => ({ query, cycles: [] }),
      memorySearch: async ({ query }) => {
        const result = await import("../harness/tool/metaproject-adapter").then(({ createMetaprojectAdapter }) =>
          createMetaprojectAdapter(root).memorySearch({ query, limit: 1 }),
        );
        return result;
      },
      readWiki: async ({ path: filePath }) => ({ path: filePath, content: "", isError: false }),
      describeContext: async () => ({ root, graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
    };
    const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
    const context = await buildApprovalContext(port, "bun test src/memory/service.ts authority boundary");
    const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
    expect(context).toContain("memory:");
    assertP0Purity(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
