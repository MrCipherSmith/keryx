#!/usr/bin/env bun
// Flow 114 / AC3 — run the OpenTUI-dependent suites and REFUSE to report success
// if any test was skipped.
//
// The suites in `src/tui` guard their renderer tests behind `test.skipIf(the
// optional dependency is absent)`. That is right for a developer without the
// prebuilt binary, and wrong as CI evidence: on a platform where the binary does
// not resolve, every renderer test skips and `bun test` still exits 0. The
// platform leg would be green while having exercised nothing — vacuous evidence
// of exactly the claim it is supposed to support.
//
// So this wrapper reads the run's own JUnit summary and treats a skip as a
// failure, loudly. It is deliberately not `bun test | grep`: the counts come
// from the reporter, not from parsing human-facing output.
//
// A second guard covers the opposite accident — a path or filter that matches
// nothing runs zero tests and also exits 0.
//
// Usage:  bun ./scripts/opentui-tests-no-skips.ts [<test path> …]
//         (defaults to `src/tui`)

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TARGETS = ["src/tui"];

interface JUnitTotals {
  tests: number;
  failures: number;
  skipped: number;
}

/** Read the counts off the JUnit `<testsuites>` element bun's reporter emits. */
function parseTotals(xml: string): JUnitTotals | undefined {
  const element = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  if (element === undefined) {
    return undefined;
  }
  const attribute = (name: string): number => {
    const raw = new RegExp(`\\b${name}="(\\d+)"`).exec(element)?.[1];
    return raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  };
  const totals = {
    tests: attribute("tests"),
    failures: attribute("failures"),
    skipped: attribute("skipped"),
  };
  return Object.values(totals).some(Number.isNaN) ? undefined : totals;
}

function loud(lines: string[]): void {
  const bar = "=".repeat(73);
  console.error(bar);
  for (const line of lines) {
    console.error(line);
  }
  console.error(bar);
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS;
const workspace = mkdtempSync(join(tmpdir(), "keryx-opentui-junit-"));
const report = join(workspace, "report.xml");

try {
  const run = Bun.spawnSync(
    ["bun", "test", ...targets, "--reporter=junit", `--reporter-outfile=${report}`],
    { stdout: "inherit", stderr: "inherit" },
  );

  let xml: string;
  try {
    xml = readFileSync(report, "utf8");
  } catch (error) {
    loud([
      "OPENTUI TEST GUARD: the JUnit report was never written.",
      `  ${error instanceof Error ? error.message : String(error)}`,
      "  The run's skip count cannot be established, so this leg proves nothing.",
    ]);
    process.exit(1);
  }

  const totals = parseTotals(xml);
  if (totals === undefined) {
    loud([
      "OPENTUI TEST GUARD: the JUnit report had no readable <testsuites> counts.",
      "  Without them a skipped test would pass unnoticed. Failing instead.",
    ]);
    process.exit(1);
  }

  console.log("");
  console.log(
    `OpenTUI suites (${targets.join(", ")}): ` +
      `${totals.tests} tests, ${totals.failures} failures, ${totals.skipped} skipped ` +
      `on ${process.platform}-${process.arch}`,
  );

  if (totals.tests === 0) {
    loud([
      `OPENTUI TEST GUARD: ${targets.join(", ")} matched ZERO tests.`,
      "  An empty run exits 0 and would be recorded as platform evidence.",
    ]);
    process.exit(1);
  }

  if (totals.skipped > 0) {
    loud([
      `OPENTUI TEST GUARD: ${totals.skipped} test(s) SKIPPED on ${process.platform}-${process.arch}.`,
      "",
      "  These suites skip their renderer tests when the optional TUI dependency's",
      "  prebuilt native binary does not resolve. A skip here therefore means the",
      "  platform-specific binary is MISSING on this runner — the exact failure this",
      "  job exists to catch. Reporting green with skips would record a platform as",
      "  covered while nothing on it was ever exercised.",
      "",
      "  Check the preceding native-binary verification step for the reason.",
    ]);
    process.exit(1);
  }

  if (run.exitCode !== 0 || totals.failures > 0) {
    loud([`OPENTUI TEST GUARD: the suites failed (exit ${run.exitCode}, ${totals.failures} failures).`]);
    process.exit(run.exitCode === 0 ? 1 : run.exitCode);
  }

  console.log(`No skips: every OpenTUI-dependent test really ran on ${process.platform}-${process.arch}.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
