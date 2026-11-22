import { describe, expect, test } from "bun:test";
import { isMetaprojectResponse } from "./metaproject";

const base = { schemaVersion: 1, snapshotId: "snapshot" };
const node = { id: "file:x", kind: "file", title: "x", path: "x" };

describe("Metaproject response validation", () => {
  test("accepts a detail and rejects malformed action-specific data", () => {
    expect(isMetaprojectResponse({ ...base, node }, "detail")).toBe(true);
    expect(isMetaprojectResponse({ ...base, node: { ...node, path: 1 } }, "detail")).toBe(false);
    expect(isMetaprojectResponse({ ...base, hits: [{ node, snippet: 1 }] }, "search")).toBe(false);
    expect(isMetaprojectResponse({ ...base, root: "x", nodes: [node], edges: [{ from: "x", to: "y", kind: "write" }], truncated: false }, "neighbors")).toBe(false);
  });

  test("rejects oversized result arrays and incomplete catalogs", () => {
    expect(isMetaprojectResponse({ ...base, hits: Array(201).fill({ node }) }, "search")).toBe(false);
    expect(isMetaprojectResponse({ ...base, nodes: [], edges: [], truncated: false }, "catalog")).toBe(false);
  });
});
