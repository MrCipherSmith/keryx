// Flow 487: /diag recognises its own command word and never throws.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { callDiagnostics } from "../lib/call-diagnostics";
import { isDiagCommand, maybeDumpOnInterrupt, runDiagCommand } from "./diag-command";

test("isDiagCommand matches the bare word and with args, nothing else", () => {
  expect(isDiagCommand("/diag")).toBe(true);
  expect(isDiagCommand("  /diag now")).toBe(true);
  expect(isDiagCommand("/diagram")).toBe(false);
  expect(isDiagCommand("/trail")).toBe(false);
});

test("runDiagCommand returns a summary line and never throws", () => {
  const text = runDiagCommand();
  expect(text).toContain("Diagnostics:");
  expect(text).toContain("in flight");
});

test("maybeDumpOnInterrupt dumps only when a call has waited long, and says where", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-int-"));
  const stop = callDiagnostics.start({ sessionId: "diag-interrupt-test", configDir: dir, intervalMs: 3_600_000 });
  try {
    // Nothing in flight: nothing to explain.
    expect(maybeDumpOnInterrupt({ stageMs: 0, callMs: 0 })).toBeUndefined();
    callDiagnostics.begin("int-1", "spawn_subagent");
    callDiagnostics.stage("int-1", "approval");
    // A fresh call under the default limits is an ordinary interrupt: no file noise.
    expect(maybeDumpOnInterrupt()).toBeUndefined();
    const note = maybeDumpOnInterrupt({ stageMs: 0, callMs: 0 });
    expect(note).toContain("diagnostics saved before interrupt");
    expect(note).toContain("spawn_subagent in approval");
    const file = callDiagnostics.dumpPath();
    expect(file !== undefined && existsSync(file)).toBe(true);
    expect(readFileSync(file as string, "utf8")).toContain("operator interrupt after long wait");
  } finally {
    callDiagnostics.end("int-1", "ok");
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

