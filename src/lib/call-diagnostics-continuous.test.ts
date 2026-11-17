import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallDiagnostics } from "./call-diagnostics";

test("continuous diagnostics persist before a stall without free-form data", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-continuous-"));
  let now = 1_000_000;
  const diag = createCallDiagnostics({ now: () => now });
  const stop = diag.start({ sessionId: "review", configDir: dir, continuous: true, intervalMs: 3_600_000 });
  try {
    const file = diag.journalPath() as string;
    expect(readFileSync(file, "utf8")).toContain('"kind":"session.start"');
    diag.record("secret-prompt");
    diag.probe("unsafe", () => ({ response: "secret-answer", count: 5 }));
    diag.event("approval.rearm", "secret-detail");
    diag.begin("c1", "spawn_subagent");
    diag.stage("c1", "invoke");
    now += 30_000;
    diag.tick();
    diag.observe("work.paint", { items: 15, width: 100, visible: true });
    diag.end("c1", "ok");
    const text = readFileSync(file, "utf8");
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.kind)).toEqual(["session.start", "approval.rearm", "call.begin", "call.stage", "snapshot", "work.paint", "call.end"]);
    expect(rows.find((row) => row.kind === "snapshot").calls[0]).toMatchObject({ stage: "invoke", ageMs: 30_000 });
    expect(rows.find((row) => row.kind === "work.paint")).toMatchObject({ items: 15, width: 100, visible: true });
    expect(text).not.toContain("secret-");
    expect(text).not.toContain("unsafe");
    stop();
    expect(readFileSync(file, "utf8")).toContain('"kind":"session.stop"');
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("continuous diagnostics report failure once without breaking calls", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-error-"));
  const diag = createCallDiagnostics();
  const warnings: string[] = [];
  const stop = diag.start({ sessionId: "bad", configDir: dir, continuous: true,
    maxFileBytes: 1, onJournalError: (code) => warnings.push(code) });
  try {
    expect(() => { diag.begin("c1", "spawn_subagent"); diag.end("c1", "ok"); }).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(diag.journalError()).toBeDefined();
    expect(diag.snapshot("test").metrics.callsSettled).toBe(1);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("continuous diagnostics journal the turn path with correlation ids", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-continuous-"));
  let now = 1_000_000;
  const diag = createCallDiagnostics({ now: () => now });
  const stop = diag.start({ sessionId: "turns", configDir: dir, continuous: true, intervalMs: 3_600_000 });
  try {
    const turn = diag.turnBegin("turn-1");
    diag.turnPhase(turn, "batch.spawn.wait", { batchId: "r3" });
    diag.turnPhase(turn, "call.accepted", { batchId: "r3", callId: "c1" });
    now += 30_000;
    diag.tick();
    diag.turnEnd(turn, "completed");
    const rows = readFileSync(diag.journalPath() as string, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.kind)).toEqual(["session.start", "turn.begin", "turn.phase", "turn.phase", "snapshot", "turn.end"]);
    expect(rows[3]).toMatchObject({ turnId: "turn-1", phase: "call.accepted", batchId: "r3", callId: "c1" });
    expect(rows[4].turns[0]).toMatchObject({ id: "turn-1", phase: "call.accepted", phaseAgeMs: 30_000 });
    expect(rows[5]).toMatchObject({ turnId: "turn-1", outcome: "completed", lastPhase: "call.accepted" });
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
