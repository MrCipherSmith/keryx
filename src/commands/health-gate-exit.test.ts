// T48 (flow 233, AFC-05/AC4): `runExitCode` in `src/commands/health.ts` had
// the same denylist shape T38 fixed in `src/commands/security.ts`'s
// `exitCodeFor`/`reportExitCode` (T35 F-002) — reported rather than fixed by
// that task because it is a different file with its own gate vocabulary
// (T38-implementation.md "Concerns" / finding T38-F-001).
//
// `GateStatus` (`src/health/types.ts`) is `"pass" | "warn" | "incomplete" |
// "fail"` — an unrelated vocabulary to `SecurityGate`, so this file does not
// import or reuse `isPassGate`/`exitCodeFor`/`reportExitCode` from
// `./security`.
//
// `runExitCode` is exported from `./health` for direct testing: a live
// `HealthReport.gate.status` is always produced fresh by `computeGate`
// (`src/health/gate.ts`), which only ever returns one of the four
// recognized `GateStatus` values, so the "unrecognized value" arm has no
// CLI-reachable reproduction and needs a direct call with a
// `"banana" as unknown as GateStatus` cast to exercise at all — the same
// technique `security-gate-exit.test.ts` uses for `SecurityGate`.

import { describe, expect, test } from "bun:test";
import { runExitCode } from "./health";
import type { GateStatus } from "../health/types";

describe("runExitCode — exhaustive over GateStatus, default arm blocks", () => {
  test("pass exits 0 in both strict and non-strict runs — the pass control", () => {
    expect(runExitCode("pass", true)).toBe(0);
    expect(runExitCode("pass", false)).toBe(0);
  });

  test("fail exits 1 regardless of --strict — an established threshold violation always blocks", () => {
    expect(runExitCode("fail", true)).toBe(1);
    expect(runExitCode("fail", false)).toBe(1);
  });

  test("incomplete exits 1 regardless of --strict — a required check that is missing, skipped, unparsed or unfinished is never signed as passed", () => {
    expect(runExitCode("incomplete", true)).toBe(1);
    expect(runExitCode("incomplete", false)).toBe(1);
  });

  test("warn exits 1 only under --strict; a plain (non-strict) run is not blocked by a warning", () => {
    expect(runExitCode("warn", true)).toBe(1);
    expect(runExitCode("warn", false)).toBe(0);
  });

  test("an unrecognized gate value refuses in both strict and non-strict runs, rather than falling through to pass", () => {
    // TypeScript's own `GateStatus` union would refuse this literal; the
    // cast is the only way to reach the exhaustive switch's default arm —
    // exactly the arm this task closes ("an unrecognized or newly added
    // value fails closed rather than passing silently").
    const bogus = "banana" as unknown as GateStatus;
    expect(runExitCode(bogus, true)).toBe(1);
    expect(runExitCode(bogus, false)).toBe(1);
  });

  test("full truth table for every recognized value — pinned so a later edit cannot silently regress an already-correct cell", () => {
    const table: Array<{ status: GateStatus; strict: boolean; exit: number }> = [
      { status: "pass", strict: false, exit: 0 },
      { status: "pass", strict: true, exit: 0 },
      { status: "warn", strict: false, exit: 0 },
      { status: "warn", strict: true, exit: 1 },
      { status: "incomplete", strict: false, exit: 1 },
      { status: "incomplete", strict: true, exit: 1 },
      { status: "fail", strict: false, exit: 1 },
      { status: "fail", strict: true, exit: 1 },
    ];
    for (const { status, strict, exit } of table) {
      expect(runExitCode(status, strict)).toBe(exit);
    }
  });
});
