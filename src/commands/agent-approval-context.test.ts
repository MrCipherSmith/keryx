import { expect, test } from "bun:test";
import { buildApprovalContext, fileTokens } from "./agent-approval-context";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";

// A MetaprojectPort with inert defaults; tests override graphAffected/memorySearch.
function fakePort(overrides: Partial<MetaprojectPort> = {}): MetaprojectPort {
  return {
    searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
    graphAffected: async ({ target }) => ({ target, affected: [] }),
    graphQuery: async ({ query }) => (query === "orphans" ? { query, orphans: [] } : { query, cycles: [] }),
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path }) => ({ path, content: "", isError: false }),
    describeContext: async () => ({ root: "/x", graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
    ...overrides,
  };
}

test("fileTokens extracts path-like and name.ext tokens, deduped", () => {
  expect(fileTokens("rm src/foo.ts src/foo.ts && echo hi")).toEqual(["src/foo.ts"]);
  expect(fileTokens("cat ./README.md")).toEqual(["README.md"]);
  expect(fileTokens("git status")).toEqual([]);
});

test("buildApprovalContext reports blast radius for a file with graph dependents", async () => {
  const port = fakePort({
    graphAffected: async ({ target }) => ({
      target,
      affected: [
        { id: "a", path: "a.ts", hop: 1 },
        { id: "b", path: "b.ts", hop: 2 },
      ],
    }),
  });
  const context = await buildApprovalContext(port, "bun test src/foo.ts");
  expect(context).toContain("src/foo.ts affects 2 file(s)");
});

test("buildApprovalContext includes the top memory note", async () => {
  const port = fakePort({
    memorySearch: async ({ query }) => ({
      query,
      hits: [{ path: "memory/known-mistakes/x.md", title: "Do not rm -rf node_modules", score: 0.9 }],
    }),
  });
  const context = await buildApprovalContext(port, "rm -rf node_modules");
  expect(context).toContain("memory: Do not rm -rf node_modules");
});

test("buildApprovalContext is empty for a plain command with no dependents or memory", async () => {
  const context = await buildApprovalContext(fakePort(), "git status");
  expect(context).toBe("");
});

test("buildApprovalContext never throws when the port errors", async () => {
  const port = fakePort({
    graphAffected: async () => {
      throw new Error("graph exploded");
    },
    memorySearch: async () => {
      throw new Error("memory exploded");
    },
  });
  const context = await buildApprovalContext(port, "bun test src/foo.ts");
  expect(context).toBe("");
});

test("buildApprovalContext tolerates a structured port error result", async () => {
  const port = fakePort({
    graphAffected: async ({ target }) => ({ target, affected: [], error: "no graph" }),
    memorySearch: async ({ query }) => ({ query, hits: [], error: "no index" }),
  });
  expect(await buildApprovalContext(port, "bun test src/foo.ts")).toBe("");
});
