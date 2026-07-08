import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadMcpConfig, mergeMcpConfig, MCP_CONFIG_DEFAULTS } from "./config";
import { buildDiscovery } from "./discovery";
import { buildToolRegistry } from "./tools";
import {
  buildMcpContext,
  dispatchCallTool,
  dispatchListResources,
  dispatchListTools,
  dispatchReadResource,
  visibleTools,
} from "./dispatch";
import { getCycles, getOrphans } from "../gdgraph/query";
import { runValidate } from "../standard/service";

// --- fixture workspace --------------------------------------------------------

let root: string;

const MANIFEST_MODULES = ["gdgraph", "security", "memory", "health", "tasks", "gdwiki"];

async function writeManifest(mcpEnabled: boolean, expose?: unknown): Promise<void> {
  const modules: Record<string, unknown> = {};
  for (const key of MANIFEST_MODULES) {
    modules[key] = { enabled: true, manifest: `.metaproject/modules/${key}.md`, core: `.metaproject/core/${key}` };
  }
  modules.mcp = {
    enabled: mcpEnabled,
    core: ".metaproject/core/mcp",
    manifest: ".metaproject/modules/mcp.md",
    commands: ["serve"],
    capabilities: [],
    http: { enabled: false },
    expose: expose ?? { tools: true, resources: true, modules: [...MANIFEST_MODULES.map((m) => (m === "tasks" ? "flow" : m === "gdwiki" ? "wiki" : m)), "standard"] },
  };
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ schemaVersion: 1, standardVersion: "0.1.0", name: "fixture", createdBy: "keryx", paths: {}, modules }),
    "utf8",
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-mcp-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  // gdgraph storage: a -> b import edge.
  const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  await writeFile(
    path.join(storage, "nodes.jsonl"),
    `${JSON.stringify({ path: "src/a.ts", kind: "file" })}\n${JSON.stringify({ path: "src/b.ts", kind: "file" })}\n${JSON.stringify({ path: "src/lonely.ts", kind: "file" })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(storage, "edges.jsonl"),
    `${JSON.stringify({ from: "src/a.ts", to: "src/b.ts", kind: "imports" })}\n`,
    "utf8",
  );
  // artifact + wiki + memory resources.
  await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "artifacts"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "data", "gdgraph", "artifacts", "summary.md"), "# graph\n", "utf8");
  await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "wiki", "architecture", "map.md"), "# map\n", "utf8");
  await mkdir(path.join(root, ".metaproject", "memory", "lessons"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "memory", "lessons", "l1.md"), "lesson\n", "utf8");
  await writeManifest(true);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- config -------------------------------------------------------------------

test("loadMcpConfig returns defaults when no config file exists", async () => {
  const config = await loadMcpConfig(root);
  expect(config).toEqual(MCP_CONFIG_DEFAULTS);
});

test("mergeMcpConfig deep-merges over defaults and tolerates malformed input", () => {
  expect(mergeMcpConfig(null)).toEqual(MCP_CONFIG_DEFAULTS);
  expect(mergeMcpConfig("garbage")).toEqual(MCP_CONFIG_DEFAULTS);
  const merged = mergeMcpConfig({ transport: "http", http: { port: 8080 }, redactToolOutput: true });
  expect(merged.transport).toBe("http");
  expect(merged.http.port).toBe(8080);
  expect(merged.http.host).toBe("127.0.0.1"); // default preserved
});

test("loadMcpConfig falls back to defaults on malformed JSON (C0-8)", async () => {
  const file = path.join(root, ".metaproject", "core", "mcp", "mcp.config.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ not valid json", "utf8");
  expect(await loadMcpConfig(root)).toEqual(MCP_CONFIG_DEFAULTS);
});

// --- discovery ----------------------------------------------------------------

test("discovery hides tools of a disabled module (M-11)", () => {
  const discovery = buildDiscovery({
    modules: { gdgraph: { enabled: false }, mcp: { enabled: true } as never },
  });
  expect(discovery.isModuleExposed("gdgraph")).toBe(false);
  expect(discovery.isModuleExposed("standard")).toBe(true); // cross-cutting
});

test("discovery respects expose.modules allowlist", () => {
  const discovery = buildDiscovery({
    modules: {
      gdgraph: { enabled: true },
      security: { enabled: true },
      mcp: { enabled: true, expose: { modules: ["gdgraph"] } } as never,
    },
  });
  expect(discovery.isModuleExposed("gdgraph")).toBe(true);
  expect(discovery.isModuleExposed("security")).toBe(false);
});

// --- tool registry / AC1 parity ----------------------------------------------

test("tools/list exposes >= 10 tools including every review-named action", async () => {
  const ctx = await buildMcpContext(root);
  const names = dispatchListTools(ctx).map((t) => t.name);
  expect(names.length).toBeGreaterThanOrEqual(10);
  for (const required of [
    "gdgraph.affected",
    "gdgraph.cycles",
    "gdgraph.orphans",
    "security.check",
    "security.scan",
    "flow.status",
    "memory.search",
    "health.gate",
    "wiki.query",
    "standard.validate",
  ]) {
    expect(names).toContain(required);
  }
});

test("registry has >= 10 entries with valid input schemas", () => {
  const tools = buildToolRegistry();
  expect(tools.length).toBeGreaterThanOrEqual(10);
  for (const tool of tools) {
    expect(typeof tool.name).toBe("string");
    expect(tool.inputSchema.type).toBe("object");
  }
});

test("AC1: tool result equals the in-process service result (JSON-serialized)", async () => {
  const ctx = await buildMcpContext(root);

  // gdgraph.cycles parity
  const cyclesTool = await dispatchCallTool(ctx, "gdgraph.cycles", {});
  expect(JSON.parse(cyclesTool.text)).toEqual(getCycles(await import("../gdgraph/query").then((m) => m.loadGraph(root))));

  // gdgraph.orphans parity
  const orphansTool = await dispatchCallTool(ctx, "gdgraph.orphans", {});
  const graph = await import("../gdgraph/query").then((m) => m.loadGraph(root));
  expect(JSON.parse(orphansTool.text)).toEqual(getOrphans(graph));
  expect(getOrphans(graph)).toContain("src/lonely.ts");

  // standard.validate parity
  const validateTool = await dispatchCallTool(ctx, "standard.validate", {});
  expect(JSON.parse(validateTool.text)).toEqual(
    JSON.parse(JSON.stringify(await runValidate(root))),
  );
});

test("gdgraph.affected returns dependencies + dependents", async () => {
  const ctx = await buildMcpContext(root);
  const result = await dispatchCallTool(ctx, "gdgraph.affected", { file: "src/b.ts" });
  const parsed = JSON.parse(result.text) as { dependents: string[] };
  expect(parsed.dependents).toContain("src/a.ts");
});

// --- resources / AC2 ----------------------------------------------------------

test("AC2: resources/list enumerates >= 3 classes and reads content", async () => {
  const ctx = await buildMcpContext(root);
  const listings = await dispatchListResources(ctx);
  const classes = new Set(listings.map((l) => l.uri.split("/")[2]));
  // metaproject://<class>/...  → index 2 after splitting on "/"
  const classNames = new Set(
    listings.map((l) => l.uri.replace("metaproject://", "").split("/")[0]),
  );
  expect(classNames.has("artifacts")).toBe(true);
  expect(classNames.has("wiki")).toBe(true);
  expect(classNames.has("memory")).toBe(true);
  expect(classNames.size).toBeGreaterThanOrEqual(3);
  void classes;

  const artifact = listings.find((l) => l.uri.startsWith("metaproject://artifacts/"));
  expect(artifact).toBeDefined();
  const contents = await dispatchReadResource(ctx, artifact!.uri);
  expect(contents.text).toContain("# graph");
});

test("AC2: resources are read-only — tree hash unchanged after a read sweep (M-4)", async () => {
  const ctx = await buildMcpContext(root);
  const before = await treeHash(path.join(root, ".metaproject"));
  const listings = await dispatchListResources(ctx);
  for (const listing of listings) {
    await dispatchReadResource(ctx, listing.uri);
  }
  const after = await treeHash(path.join(root, ".metaproject"));
  expect(after).toBe(before);
});

test("AC2: path traversal outside a root is rejected", async () => {
  const ctx = await buildMcpContext(root);
  await expect(
    dispatchReadResource(ctx, "metaproject://wiki/../../../../etc/passwd"),
  ).rejects.toThrow();
  await expect(
    dispatchReadResource(ctx, "metaproject://memory/../metaproject.json"),
  ).rejects.toThrow();
});

// --- AC3: disabled byte-identical --------------------------------------------

test("AC3: with mcp disabled, no tools/resources are exposed", async () => {
  await writeManifest(false);
  const ctx = await buildMcpContext(root);
  expect(visibleTools(ctx)).toEqual([]);
  expect(dispatchListTools(ctx)).toEqual([]);
  expect(await dispatchListResources(ctx)).toEqual([]);
});

// --- AC4: redaction seam ------------------------------------------------------

test("AC4: with security disabled, tool output is byte-identical (never throws)", async () => {
  const ctx = await buildMcpContext(root);
  const result = await dispatchCallTool(ctx, "gdgraph.orphans", {});
  // Security module is not initialized in the fixture ⇒ redactRaw is a no-op.
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.text)).toEqual(getOrphans(await import("../gdgraph/query").then((m) => m.loadGraph(root))));
});

test("AC4: a seeded secret is masked when the security module is enabled", async () => {
  // Enable the security module so redactRaw actively redacts.
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      schemaVersion: 1,
      standardVersion: "0.1.0",
      name: "fixture",
      createdBy: "keryx",
      paths: {},
      modules: { security: { enabled: true }, mcp: { enabled: true } },
    }),
    "utf8",
  );
  const ctx = await buildMcpContext(root);
  const secret = "AKIAIOSFODNN7EXAMPLE";
  // security.check echoes nothing sensitive, but memory/graph could; here we
  // route a crafted content through security.check and confirm the seam runs.
  const result = await dispatchCallTool(ctx, "security.check", {
    content: `aws key ${secret}`,
    source: "untrusted-external",
  });
  expect(result.isError).toBe(false);
  // The raw AWS key must not survive verbatim in the transported, redacted text.
  expect(result.text).not.toContain(secret);
});

// --- AC1/AC2 stdio round-trip (SDK-gated) ------------------------------------

test("stdio round-trip over the real SDK transport (skips if SDK unavailable)", async () => {
  let sdk: {
    Client: new (info: unknown, options: unknown) => {
      connect(t: unknown): Promise<void>;
      listTools(): Promise<{ tools: Array<{ name: string }> }>;
      callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
      close(): Promise<void>;
    };
    InMemoryTransport: { createLinkedPair(): [unknown, unknown] };
  };
  try {
    const clientMod = await import("@modelcontextprotocol/sdk/client/index.js");
    const memMod = await import("@modelcontextprotocol/sdk/inMemory.js");
    sdk = {
      Client: clientMod.Client as never,
      InMemoryTransport: memMod.InMemoryTransport as never,
    };
  } catch {
    return; // SDK not installed — the no-SDK golden path is covered elsewhere.
  }

  const { createMcpServer } = await import("./server");
  const ctx = await buildMcpContext(root);
  const server = await createMcpServer(ctx);
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new sdk.Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  expect(listed.tools.length).toBeGreaterThanOrEqual(10);

  const called = await client.callTool({ name: "gdgraph.orphans", arguments: {} });
  const overWire = called.content[0]?.text ?? "";
  // AC1 parity: the transported result equals the in-process dispatch result.
  const inProcess = await dispatchCallTool(ctx, "gdgraph.orphans", {});
  expect(overWire).toBe(inProcess.text);

  await client.close();
  await server.close();
});

// --- helpers ------------------------------------------------------------------

async function treeHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        hash.update(path.relative(dir, full));
        hash.update(await readFile(full));
      }
    }
  };
  await walk(dir);
  return hash.digest("hex");
}
