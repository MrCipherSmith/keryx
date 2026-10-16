import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { validateAgainstSchema } from "../contracts/validator";
import os from "node:os";
import path from "node:path";
import { createEvidenceSearchTool } from "./tool";

test("read-only tool rejects config and invalid budgets before I/O", async () => {
  const tool = createEvidenceSearchTool("/nonexistent/erl-tool-root");
  expect(tool.definition.risk).toBe("read");
  for (const input of [{ query: "x", config: {} }, { query: "x", roots: ["/"] },
    { query: "x", projectRoot: "/" }, { query: "" }, { query: "x", limit: 0 },
    { query: "x", limit: 11 }, { query: "x", limit: 1.5 }, { query: "x", limit: "1" },
    { query: "é".repeat(4097) }]) {
    const result = await tool.invoke(input);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("invalid input");
  }
});
test("disabled and cancelled tool creates no index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-tool-"));
  try {
    const tool = createEvidenceSearchTool(root);
    const result = await tool.invoke({ query: "evidence" });
    expect(result.isError).toBe(false);
    expect(result.untrusted).toBe(true);
    expect(JSON.parse(result.output).code).toBe("disabled");
    const controller = new AbortController(); controller.abort();
    expect((await tool.invoke({ query: "evidence" }, { signal: controller.signal })).isError).toBe(true);
    await expect(access(path.join(root, ".metaproject/evidence"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("tool refuses malformed owner config without disclosing contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-tool-"));
  try {
    await mkdir(path.join(root, ".metaproject"));
    await writeFile(path.join(root, ".metaproject/evidence.json"), "private-secret-broken-json");
    const result = await createEvidenceSearchTool(root).invoke({ query: "evidence" });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("private-secret");
    expect(result.output).not.toContain(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("tool schema exposes no administrative capability", () => {
  const schema = createEvidenceSearchTool(".").definition.inputSchema as { properties: Record<string, unknown> };
  expect(Object.keys(schema.properties).sort()).toEqual(["limit", "query"]);
});


test("production tool delivers verified citations, refuses stale bytes and respects clear", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-tool-index-"));
  const { loadEvidenceRuntime } = await import("./runtime");
  let runtime: Awaited<ReturnType<typeof loadEvidenceRuntime>> | undefined;
  try {
    await mkdir(path.join(root, ".metaproject"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, ".metaproject/metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }));
    await writeFile(path.join(root, ".metaproject/evidence.json"), JSON.stringify({ schemaVersion: 1, enabled: true, roots: ["docs"] }));
    await writeFile(path.join(root, "docs/a.txt"), "Ordinary evidence text.");
    runtime = await loadEvidenceRuntime({ projectRoot: root });
    if (!runtime.ok) throw Error("fixture configuration unavailable");
    expect((await runtime.runtime.build([{ kind: "file", id: "docs/a.txt" }])).code).toBe("ok");
    const tool = createEvidenceSearchTool(root);
    const result = await tool.invoke({ query: "evidence", limit: 1 });
    expect(result.isError).toBe(false);
    expect(result.untrusted).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.code).toBe("ok");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].text).toBe("Ordinary evidence text.");
    expect(payload.items[0].locator.kind).toBe("file");
    expect(payload.items[0].score).toBeGreaterThan(0);
    expect(result.output).not.toContain(root);
    expect(payload.items[0].sourcePath).toBe("docs/a.txt");
    expect(payload.items[0].sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(validateAgainstSchema("search-result.schema.json", payload, {
      schemaDir: path.resolve(import.meta.dir, "../../docs/requirements/keryx-evidence-retrieval/schemas"),
    }).valid).toBe(true);
    await writeFile(path.join(root, "docs/a.txt"), "Changed private text.");
    const stale = await tool.invoke({ query: "evidence" });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.output).items).toEqual([]);
    expect(stale.output).not.toContain("Ordinary evidence");
    expect(stale.output).not.toContain("Changed private");
    expect((await runtime.runtime.clear()).code).toBe("ok");
    expect(JSON.parse((await tool.invoke({ query: "evidence" })).output).code).toBe("index-absent");
  } finally { if (runtime?.ok) runtime.runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test("enabled tool without an index stays read-only even with no scanner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-tool-absent-"));
  try {
    await mkdir(path.join(root, ".metaproject"));
    await writeFile(path.join(root, ".metaproject/evidence.json"), JSON.stringify({ schemaVersion: 1, enabled: true, roots: ["docs"] }));
    const result = await createEvidenceSearchTool(root).invoke({ query: "evidence" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).code).toBe("index-absent");
    await expect(access(path.join(root, ".metaproject/evidence"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
