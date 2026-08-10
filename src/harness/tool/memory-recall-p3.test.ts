import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildToolRegistry } from "../../mcp/tools";
import { toMcpTools } from "../../mcp/metaproject-tools";
import { METAPROJECT_OPERATIONS } from "./metaproject-operations";
import { createMetaprojectAdapter } from "./metaproject-adapter";

const FIXTURE = path.join(import.meta.dir, "..", "..", "..", "fixtures", "memory-reliability-p0");
const MAX_AUTOMATIC_HITS = 10;
const MAX_EXCERPT_BYTES = 400;

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-p3-"));
  await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
  return root;
}

function acceptedEntry(title: string, summary: string): string {
  return `# ${title}

Version: 1.0.0
Type: decision
Status: accepted
Confidence: high
Valid-From: 2026-01-01

## Summary

${summary}

## Details

${"secret detail ".repeat(1_000)}

## Tags

- authority-boundary
`;
}

test("P3: adapter and both MCP memory projections are accepted/current, portable, and bounded", async () => {
  const root = await fixtureRoot();
  try {
    const decisions = path.join(root, ".metaproject", "memory", "decisions");
    await writeFile(path.join(decisions, "large.md"), acceptedEntry("Large authority decision", "🧠".repeat(1_000)), "utf8");
    await writeFile(
      path.join(decisions, "future.md"),
      acceptedEntry("Future authority decision", "authority boundary").replace("Valid-From: 2026-01-01", "Valid-From: 2099-01-01"),
      "utf8",
    );
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(decisions, `extra-${index}.md`), acceptedEntry(`Extra ${index}`, "authority boundary"), "utf8");
    }

    const adapter = createMetaprojectAdapter(root);
    const adapterResult = await adapter.memorySearch({ query: "authority boundary", limit: 999 });
    const unified = toMcpTools(METAPROJECT_OPERATIONS).find((tool) => tool.name === "memory_search");
    const unifiedResult = (await unified?.invoke(root, { query: "authority boundary" })) as typeof adapterResult;
    const legacy = buildToolRegistry().find((tool) => tool.name === "memory.search");
    const legacyResult = (await legacy?.invoke(root, { query: "authority boundary" })) as typeof adapterResult;

    for (const result of [adapterResult, unifiedResult, legacyResult]) {
      expect(result.hits.length).toBeLessThanOrEqual(MAX_AUTOMATIC_HITS);
      expect(result.hits.every((hit) => hit.status === "accepted")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("secret detail");
      expect(result.hits.every((hit) => !hit.path.startsWith("/") && !hit.path.includes(".."))).toBe(true);
      expect(result.hits.every((hit) => Buffer.byteLength(hit.excerpt ?? "", "utf8") <= MAX_EXCERPT_BYTES)).toBe(true);
      expect(result).not.toHaveProperty("results");
    }
    expect(JSON.stringify(adapterResult)).not.toContain("Draft authority decision");
    expect(JSON.stringify(adapterResult)).not.toContain("Conflicting authority decision");
    expect(JSON.stringify(adapterResult)).not.toContain("Deprecated authority decision");
    expect(JSON.stringify(adapterResult)).not.toContain("Expired authority decision");
    expect(JSON.stringify(adapterResult)).not.toContain("Superseded authority decision");
    expect(JSON.stringify(adapterResult)).not.toContain("Future authority decision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
