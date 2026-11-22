import { describe, expect, test } from "bun:test";
import { METAPROJECT_CAPABILITIES, MetaprojectRequestError, parseExplorerRequestV1 } from "../../../../src/integrations/metaproject-explorer-contract";
import { isMetaprojectResponse, isMetaprojectV2Response, negotiateMetaproject, requestMetaprojectV2 } from "./metaproject";

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

async function readError(read: Promise<unknown>): Promise<unknown> {
  try {
    await read;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the read to fail.");
}

const v1Catalog = {
  ...base, graph: "missing", hasWikiLayer: false, hasSymbolLayer: false,
  nodes: [], edges: [], truncated: false, counts: { files: 0, wiki: 0, modules: 0 },
};
const probe = { version: 2, action: "capabilities" };
const capabilities = { schemaVersion: 2, actions: METAPROJECT_CAPABILITIES };

describe("Metaproject capability negotiation", () => {
  test("uses the actual unversioned parser and requires a valid legacy catalog", async () => {
    const calls: unknown[] = [];
    const fakeLegacyReader = async (request: unknown): Promise<unknown> => {
      calls.push(request);
      const parsed = parseExplorerRequestV1(JSON.parse(JSON.stringify(request)));
      if (parsed.action !== "catalog") throw new Error("Expected catalog handshake");
      return v1Catalog;
    };
    expect(await negotiateMetaproject("/checkout", fakeLegacyReader)).toBe(1);
    expect(calls).toEqual([probe, { action: "catalog" }]);
    const error = await readError(negotiateMetaproject("/checkout", async (request) => {
      parseExplorerRequestV1(request);
      return { ...v1Catalog, counts: undefined };
    }));
    expect(String(error)).toContain("incompatible legacy");
  });

  test("accepts the typed unsupported version only after the handshake", async () => {
    expect(await negotiateMetaproject("/checkout", async (request) => {
      if (request.action === "capabilities") throw new Error("unsupported-version: Try an earlier protocol.");
      return v1Catalog;
    })).toBe(1);
    expect(await negotiateMetaproject("/checkout", async () => capabilities)).toBe(2);
  });

  test("does not downgrade transport errors, invalid responses or a later data error", async () => {
    for (const error of ["Could not run the selected CLI", "Timed out"]) {
      const calls: unknown[] = [];
      const failure = await readError(negotiateMetaproject("/checkout", async (request) => {
        calls.push(request);
        throw new Error(error);
      }));
      expect(String(failure)).toContain(error);
      expect(calls).toEqual([probe]);
    }
    const invalid = await readError(negotiateMetaproject("/checkout", async () => ({ ...capabilities, actions: [] })));
    expect(String(invalid)).toContain("invalid Metaproject capabilities");
    const calls: unknown[] = [];
    const reader = async (request: { action: string }) => {
      calls.push(request);
      if (request.action === "capabilities") return capabilities;
      throw new Error("unsupported-version: Try an earlier protocol.");
    };
    await negotiateMetaproject("/checkout", reader);
    const error = await readError(requestMetaprojectV2("/checkout", { action: "catalog", version: 2 }, reader));
    expect(error instanceof MetaprojectRequestError && error.code).toBe("unsupported-version");
    expect(calls).toEqual([probe, { action: "catalog", version: 2 }]);
  });

  test("validates v2 source evidence and rejects an unrelated detail", async () => {
    const digest = "a".repeat(64);
    const file = "openspec/specs/review/spec.md";
    const node = { id: "spec-id", kind: "spec", title: "Review", path: file };
    const hit = { node, scope: "spec", source: { path: file, digest, startLine: 2, endLine: 3 }, matchType: "heading" };
    const search = { schemaVersion: 2, snapshotId: digest, hits: [hit], partial: false };
    expect(isMetaprojectV2Response(search, "search")).toBe(true);
    expect(isMetaprojectV2Response({ ...search, hits: [{ ...hit, source: { ...hit.source, path: "../escape" } }] }, "search")).toBe(false);
    expect(isMetaprojectV2Response({ ...search, hits: Array(101).fill(hit) }, "search")).toBe(false);
    const unrelated = await readError(requestMetaprojectV2("/checkout", { action: "detail", version: 2, id: "other" },
      async () => ({ schemaVersion: 2, snapshotId: digest, node })));
    expect(String(unrelated)).toContain("Incompatible Metaproject v2 response");
  });
});
