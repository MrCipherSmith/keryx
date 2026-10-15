// Flow 454 AC1: the recorder writes lines the existing reader parses back, concurrent appends stay intact,
// and a directory that cannot be written yields one warning and no exception.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryCalls, readToolLog } from "./layers-usage";
import { orchestratorLogPath, recordOrchestratorCall } from "./orchestrator-log";

let pkg: string;

beforeEach(() => {
  pkg = mkdtempSync(path.join(tmpdir(), "keryx-orch-log-"));
});

afterEach(() => {
  try {
    chmodSync(pkg, 0o755);
  } catch {
    // Already gone.
  }
  rmSync(pkg, { recursive: true, force: true });
});

const lines = (): string[] => readFileSync(orchestratorLogPath(pkg), "utf8").split("\n").filter((line) => line !== "");

describe("AC1: recordOrchestratorCall", () => {
  test("a recorded MCP call parses back to the same search, accepted, query and time", async () => {
    const at = new Date("2026-10-15T10:05:00.000Z");
    await recordOrchestratorCall(
      pkg,
      { source: "mcp", caller: "orchestrator", tool: "memory_search", input: { query: "billing retries", status: "accepted" } },
      { now: at },
    );
    const calls = memoryCalls((await readToolLog(pkg, "orchestrator")) ?? "");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.search).toBe(true);
    expect(calls[0]?.accepted).toBe(true);
    expect(calls[0]?.query).toBe("billing retries");
    expect(calls[0]?.time).toBe(at.toISOString());
    expect(calls[0]?.caller).toBe("orchestrator");
  });

  test("a recorded CLI command parses back to the same search, accepted, query and time", async () => {
    const at = new Date("2026-10-15T10:06:00.000Z");
    await recordOrchestratorCall(
      pkg,
      { source: "cli", caller: "unattributed", command: 'keryx memory search "billing retries" --status accepted' },
      { now: at },
    );
    const calls = memoryCalls((await readToolLog(pkg, "orchestrator")) ?? "");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.search).toBe(true);
    expect(calls[0]?.accepted).toBe(true);
    expect(calls[0]?.query).toBe("billing retries");
    expect(calls[0]?.time).toBe(at.toISOString());
  });

  test("50 appends started at once leave 50 intact lines", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        recordOrchestratorCall(pkg, {
          source: "mcp",
          caller: "orchestrator",
          tool: "memory_search",
          input: { query: `query number ${index} ${"x".repeat(300)}` },
        }),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
    const written = lines();
    expect(written).toHaveLength(50);
    const queries = written.map((line) => (JSON.parse(line) as { input: { query: string } }).input.query);
    expect(new Set(queries).size).toBe(50);
  });

  test("a directory that cannot be written yields one warning, no exception, and a false result", async () => {
    mkdirSync(path.join(pkg, "tool-calls"), { recursive: true });
    chmodSync(path.join(pkg, "tool-calls"), 0o500);
    const warnings: string[] = [];
    const entry = { source: "mcp", caller: "orchestrator", tool: "memory_search", input: { query: "q" } } as const;
    const first = await recordOrchestratorCall(pkg, entry, { warn: (line) => warnings.push(line) });
    const second = await recordOrchestratorCall(pkg, entry, { warn: (line) => warnings.push(line) });
    chmodSync(path.join(pkg, "tool-calls"), 0o755);
    if (process.getuid?.() === 0) return;
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("orchestrator log not written");
  });
});
