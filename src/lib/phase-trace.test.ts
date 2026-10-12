import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_PHASE_TRACE, tracePhase } from "./phase-trace";

test("writes one timestamped line per call when the env names a file", () => {
  const file = join(mkdtempSync(join(tmpdir(), "phase-trace-")), "trace.log");
  tracePhase("first", { [ENV_PHASE_TRACE]: file });
  tracePhase("second", { [ENV_PHASE_TRACE]: file });
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z first$/);
  expect(lines[1]).toEndWith(" second");
});

test("is a no-op without the env, and never throws on an unwritable target", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-trace-"));
  tracePhase("ignored", {});
  tracePhase("ignored", { [ENV_PHASE_TRACE]: "" });
  expect(existsSync(join(dir, "x"))).toBe(false);
  expect(() => tracePhase("x", { [ENV_PHASE_TRACE]: join(dir, "missing", "deep", "t.log") })).not.toThrow();
});
