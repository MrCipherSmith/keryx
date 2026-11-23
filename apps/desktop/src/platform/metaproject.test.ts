import { describe, expect, test } from "bun:test";
import { METAPROJECT_CAPABILITIES, MetaprojectRequestError, parseExplorerRequestV1 } from "../../../../src/integrations/metaproject-explorer-contract";
import {
  METAPROJECT_REQUIRED_ACTIONS, isMetaprojectResponse, isMetaprojectV2Response, negotiateMetaproject,
  negotiateMetaprojectExplorer, requestMetaprojectTree, requestMetaprojectV2,
} from "./metaproject";

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

  test("negotiates protocol 2 with a CLI that lists more actions than Desktop uses", async () => {
    const newer = { schemaVersion: 2, actions: ["openspec-diff", ...[...METAPROJECT_CAPABILITIES].reverse()] };
    expect(await negotiateMetaproject("/checkout", async () => newer)).toBe(2);
    for (const actions of [METAPROJECT_CAPABILITIES.slice(1), [...METAPROJECT_CAPABILITIES, 1], "catalog"]) {
      const lacking = await readError(negotiateMetaproject("/checkout", async () => ({ schemaVersion: 2, actions })));
      expect(String(lacking)).toContain("invalid Metaproject capabilities");
    }
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

describe("Metaproject tree capability", () => {
  test("a CLI offering only the six actions Desktop always sends negotiates and reports no tree", async () => {
    expect([...METAPROJECT_REQUIRED_ACTIONS]).toEqual(["catalog", "detail", "search", "neighbors", "openspec-list", "openspec-history"]);
    const older = async () => ({ schemaVersion: 2, actions: [...METAPROJECT_REQUIRED_ACTIONS] });
    expect(await negotiateMetaproject("/checkout", older)).toBe(2);
    expect(await negotiateMetaprojectExplorer("/checkout", older)).toEqual({ protocol: 2, supportsTree: false });
  });

  test("a CLI offering tree reports it supported", async () => {
    const newer = async () => ({ schemaVersion: 2, actions: [...METAPROJECT_CAPABILITIES] });
    expect(await negotiateMetaprojectExplorer("/checkout", newer)).toEqual({ protocol: 2, supportsTree: true });
  });

  test("a legacy handshake reports no tree, and a CLI lacking a required action is still refused", async () => {
    const legacy = async (request: { action: string }) => {
      if (request.action === "capabilities") throw new Error("Invalid request");
      return v1Catalog;
    };
    expect(await negotiateMetaprojectExplorer("/checkout", legacy)).toEqual({ protocol: 1, supportsTree: false });
    const lacking = await readError(negotiateMetaprojectExplorer("/checkout", async () =>
      ({ schemaVersion: 2, actions: ["tree", ...METAPROJECT_REQUIRED_ACTIONS.slice(1)] })));
    expect(String(lacking)).toContain("invalid Metaproject capabilities");
  });
});

describe("Metaproject tree responses", () => {
  const digest = "b".repeat(64);
  const file = { id: "file:src/a.ts", kind: "file", title: "a.ts", path: "src/a.ts" };
  const module = { id: "module:src", kind: "module", title: "src", path: "src" };
  const page = { id: "wiki:guide", kind: "wiki", title: "Guide", path: ".metaproject/wiki/guide.md", pageType: "guide" };
  const graphRoot = {
    schemaVersion: 2, snapshotId: digest, scope: "graph", parent: null, partial: false,
    entries: [{ type: "folder", path: "src", name: "src", files: 2, module }, { type: "node", node: { ...file, path: "a.ts" } }],
  };
  const wikiRoot = {
    schemaVersion: 2, snapshotId: digest, scope: "wiki", parent: null, partial: false,
    entries: [{ type: "group", key: "guide", name: "Guide", pages: 1 }],
  };

  test("accepts well-formed graph and wiki pages", () => {
    expect(isMetaprojectV2Response(graphRoot, "tree")).toBe(true);
    expect(isMetaprojectV2Response({ ...graphRoot, parent: "src", nextCursor: "next", entries: [{ type: "node", node: file }] }, "tree")).toBe(true);
    expect(isMetaprojectV2Response({ ...graphRoot, entries: [], partial: true }, "tree")).toBe(true);
    expect(isMetaprojectV2Response(wikiRoot, "tree")).toBe(true);
    expect(isMetaprojectV2Response({ ...wikiRoot, parent: "guide", entries: [{ type: "node", node: page }] }, "tree")).toBe(true);
  });

  test("rejects malformed tree pages", () => {
    const malformed: unknown[] = [
      { ...graphRoot, scope: "spec" },
      { ...graphRoot, parent: 1 },
      { ...graphRoot, partial: undefined },
      { ...graphRoot, nextCursor: 1 },
      { ...graphRoot, snapshotId: "snapshot" },
      { ...graphRoot, entries: Array(101).fill({ type: "node", node: file }) },
      { ...graphRoot, entries: [{ type: "folder", path: "../escape", name: "escape", files: 1 }] },
      { ...graphRoot, entries: [{ type: "folder", path: "src", name: "src", files: -1 }] },
      { ...graphRoot, entries: [{ type: "folder", path: "src", name: "src", files: 1, module: file }] },
      { ...graphRoot, entries: [{ type: "folder", path: "src", name: "src", files: 1, module: { ...module, path: "lib" } }] },
      { ...graphRoot, entries: [{ type: "group", key: "guide", name: "Guide", pages: 1 }] },
      { ...graphRoot, entries: [{ type: "node", node: page }] },
      { ...graphRoot, entries: [{ type: "symlink", path: "src" }] },
      { ...wikiRoot, entries: [{ type: "folder", path: "src", name: "src", files: 1 }] },
      { ...wikiRoot, entries: [{ type: "group", key: "", name: "Guide", pages: 1 }] },
      { ...wikiRoot, entries: [{ type: "node", node: file }] },
    ];
    for (const value of malformed) expect(isMetaprojectV2Response(value, "tree")).toBe(false);
  });

  test("requests a tree page and refuses an answer for another parent or scope", async () => {
    const calls: unknown[] = [];
    const reader = async (request: unknown) => {
      calls.push(request);
      return { ...graphRoot, parent: "src", entries: [{ type: "node", node: file }] };
    };
    const tree = await requestMetaprojectTree("/checkout", { scope: "graph", parent: "src", expectedSnapshotId: digest }, reader);
    expect(tree.entries).toEqual([{ type: "node", node: file }]);
    expect(calls).toEqual([{ version: 2, action: "tree", scope: "graph", parent: "src", expectedSnapshotId: digest }]);
    expect(String(await readError(requestMetaprojectTree("/checkout", { scope: "graph", parent: "lib" }, reader))))
      .toContain("Incompatible Metaproject v2 response");
    expect(String(await readError(requestMetaprojectTree("/checkout", { scope: "wiki", parent: "src" }, reader))))
      .toContain("Incompatible Metaproject v2 response");
    expect(String(await readError(requestMetaprojectTree("/checkout", { scope: "graph" }, reader))))
      .toContain("Incompatible Metaproject v2 response");
    const malformed = await readError(requestMetaprojectTree("/checkout", { scope: "graph" }, async () => ({ ...graphRoot, entries: "src" })));
    expect(String(malformed)).toContain("Incompatible Metaproject v2 response");
  });

  test("a typed CLI error on a tree read keeps its code", async () => {
    const error = await readError(requestMetaprojectTree("/checkout", { scope: "graph", parent: "gone" }, async () => {
      throw new Error("not-found: Unknown Metaproject tree parent.");
    }));
    expect(error instanceof MetaprojectRequestError && error.code).toBe("not-found");
  });
});
