// Tests for `keryx agents monitor` (flow 092, Phase 4 / AC4).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorCommand } from "./agents";
import type { AgentsSnapshot } from "../harness/monitor/reduce";

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function writeEvents(events: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-agents-"));
  const file = path.join(dir, "events.json");
  writeFileSync(file, JSON.stringify(events), "utf8");
  return file;
}

const EVENTS = [
  {
    contract_version: "1.0.0",
    run_id: "run-9",
    event_id: "e1",
    dispatch_id: "d1",
    type: "dispatch_created",
    data: { provider: "ollama", model: "qwen2.5-coder", source: "inherited", usage: { inputTokens: 10, outputTokens: 4, exact: true } },
    timestamp_utc: "1970-01-01T00:00:00.000Z",
  },
  {
    contract_version: "1.0.0",
    run_id: "run-9",
    event_id: "e2",
    dispatch_id: "d1",
    type: "dispatch_completed",
    timestamp_utc: "1970-01-01T00:00:01.000Z",
  },
];

describe("keryx agents monitor", () => {
  test("--json emits the folded AgentsSnapshot", () => {
    const file = writeEvents(EVENTS);
    const out = captureLog(() => monitorCommand([file, "--json"]));
    const snapshot = JSON.parse(out) as AgentsSnapshot;
    expect(snapshot.runId).toBe("run-9");
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.status).toBe("done");
    expect(snapshot.agents[0]?.model).toBe("ollama/qwen2.5-coder");
    expect(snapshot.agents[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 4, exact: true });
  });

  test("text mode renders a run→dispatch tree with tokens", () => {
    const file = writeEvents(EVENTS);
    const out = captureLog(() => monitorCommand([file]));
    expect(out).toContain("agents monitor");
    expect(out).toContain("run run-9");
    expect(out).toContain("d1");
    expect(out).toContain("done");
    expect(out).toContain("↑10 ↓4");
  });

  test("missing source arg is a read-only error (no throw)", () => {
    const prevExit = process.exitCode;
    const origErr = console.error;
    console.error = () => {};
    try {
      monitorCommand([]);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = origErr;
      process.exitCode = prevExit;
    }
  });
});
