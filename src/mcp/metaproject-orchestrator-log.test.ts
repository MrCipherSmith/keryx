// Flow 454 AC4: with a review package active, the keryx MCP memory tools (search, handoff, propose) each append one
// entry (source "mcp", the tool name, the query argument) to its orchestrator log, and the tool result is unchanged.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryCalls } from "../review/layers-usage";
import { createManagedReviewPackage } from "../review/managed";
import { ENV_REVIEW_CALLER, ENV_REVIEW_RECORDED, orchestratorLogPath, startOrchestratorLog } from "../review/orchestrator-log";
import { buildMcpContext, dispatchCallTool } from "./dispatch";

const SCHEMA = path.resolve(import.meta.dir, "..", "..", "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json");

const DECISION = `# Roll out canary deploys

Version: 1.0.0
Type: decision
Status: accepted
Confidence: high
Source-Harness: claude

## Summary

Adopt canary deploys for the release pipeline.
`;

const CALLS: ReadonlyArray<{ wire: string; tool: string; args: Record<string, unknown> }> = [
  { wire: "memory_search", tool: "memory_search", args: { query: "canary deploys" } },
  { wire: "memory.search", tool: "memory_search", args: { query: "canary deploys" } },
  { wire: "memory.handoff", tool: "memory_handoff", args: { from: "claude" } },
  { wire: "memory.propose", tool: "memory_propose", args: { title: "A proposed lesson", type: "lesson", summary: "Something learned." } },
];

let roots: string[] = [];
const saved: Record<string, string | undefined> = {};

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-mcp-orch-log-"));
  roots.push(root);
  mkdirSync(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
  writeFileSync(path.join(root, ".metaproject", "memory", "decisions", "canary.md"), DECISION, "utf8");
  const modules = Object.fromEntries(["mcp", "gdgraph", "security", "tasks", "memory", "health", "gdwiki"].map((name) => [name, { enabled: true }]));
  writeFileSync(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules }));
  const schemas = path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas");
  mkdirSync(schemas, { recursive: true });
  writeFileSync(path.join(schemas, "managed-review-package.schema.json"), readFileSync(SCHEMA, "utf8"));
  return root;
}

async function withPackage(root: string): Promise<string> {
  const created = await createManagedReviewPackage({
    cwd: root,
    mode: "review-flow",
    reviewId: "r-mcp",
    target: { kind: "branch", ref: "feat/x" },
    coverage: [{ reviewer: "review-style", status: "skipped", reason: "not selected for the fixture" }],
  });
  await startOrchestratorLog(root, "r-mcp", created.path);
  return path.resolve(root, created.path);
}

beforeEach(() => {
  for (const key of [ENV_REVIEW_CALLER, ENV_REVIEW_RECORDED]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

// A proposal's file name ends in a time-derived suffix, which differs between any two runs.
const unstamped = (text: string): string => text.replace(/-[a-z0-9]{10,}\.md/g, "-<stamp>.md");

async function run(root: string, wire: string, args: Record<string, unknown>) {
  const ctx = await buildMcpContext(root, "in-process", { harnessIdentity: "claude" });
  return dispatchCallTool(ctx, wire, args);
}

describe("AC4: the MCP memory tools record into the active package", () => {
  for (const { wire, tool, args } of CALLS) {
    test(`${wire} appends one ${tool} entry and returns what it returns without a package`, async () => {
      const plain = project();
      const recorded = project();
      const dir = await withPackage(recorded);

      const without = await run(plain, wire, args);
      const withLog = await run(recorded, wire, args);
      expect(withLog.isError).toBe(without.isError);
      expect(unstamped(withLog.text)).toBe(unstamped(without.text));

      const lines = readFileSync(orchestratorLogPath(dir), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const entries = lines.filter((line) => line.source !== undefined);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe("mcp");
      expect(entries[0]?.tool).toBe(tool);
      expect(entries[0]?.caller).toBe("unattributed");
      expect(entries[0]?.input).toMatchObject(args);
      expect(existsSync(path.join(plain, ".metaproject", "reviews"))).toBe(false);
    });
  }

  test("a search entry parses back to its query", async () => {
    const root = project();
    const dir = await withPackage(root);
    await run(root, "memory_search", { query: "canary deploys" });
    const calls = memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.search).toBe(true);
    expect(calls[0]?.query).toBe("canary deploys");
  });

  test("a tool that is not a memory tool records nothing", async () => {
    const root = project();
    const dir = await withPackage(root);
    await run(root, "flow.status", {});
    expect(memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8"))).toHaveLength(0);
  });

  test("a call a keryx layer already recorded is not recorded again", async () => {
    const root = project();
    const dir = await withPackage(root);
    process.env[ENV_REVIEW_RECORDED] = "1";
    await run(root, "memory_search", { query: "canary deploys" });
    expect(memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8"))).toHaveLength(0);
  });

  test("a call from a review child's command names that child", async () => {
    const root = project();
    const dir = await withPackage(root);
    process.env[ENV_REVIEW_CALLER] = "review-logic";
    await run(root, "memory_search", { query: "canary deploys" });
    expect(memoryCalls(readFileSync(orchestratorLogPath(dir), "utf8")).map((call) => call.caller)).toEqual(["review-logic"]);
  });
});
