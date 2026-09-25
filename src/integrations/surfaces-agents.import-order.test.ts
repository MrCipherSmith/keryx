// R1-F10 (review round 1, flow 310 W2): `registry.ts` imports
// `surfaces-agents.ts` eagerly (its `HARNESS_ADAPTERS` array literal
// references `AGENTS_CLAUDE` etc.), and `surfaces-agents.ts` used to import
// `../agents/catalog`/`../agents/export` eagerly in turn — and `export.ts`
// imports `getHarnessAdapter`/`surfacesOf` from `registry.ts` at its own top
// level. Importing `surfaces-agents.ts` FIRST in a fresh module graph (before
// anything has forced `registry.ts` to finish evaluating) crashed with a TDZ
// `ReferenceError: Cannot access 'AGENTS_CLAUDE' before initialization` at
// `registry.ts`'s `HARNESS_ADAPTERS` array literal. The fix moved
// `surfaces-agents.ts`'s imports of `../agents/catalog`/`../agents/export`
// to lazy, per-call `import()`s inside its async functions, so the cycle
// never closes during module evaluation.
//
// This can only be reproduced in a genuinely fresh module graph — Bun's
// module cache means importing the same specifier twice in one process
// (including this test file's own `bun:test` run) reuses the already-
// initialized module and would never see the TDZ crash the first import
// order can trigger. A subprocess is the only reliable repro.
import { describe, expect, test } from "bun:test";

const MODULE_PATH = new URL("./surfaces-agents.ts", import.meta.url).pathname;

describe("R1-F10: import order", () => {
  test("importing src/integrations/surfaces-agents.ts FIRST in a fresh process does not crash with a TDZ ReferenceError", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "-e", `await import(${JSON.stringify(MODULE_PATH)}); console.log("OK");`],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).not.toContain("ReferenceError");
    expect(stderr).not.toContain("before initialization");
    expect(stdout).toContain("OK");
    expect(exitCode).toBe(0);
  });
});
