// Flow 303 (AC14), PR #669 review HIGH 2: the pre-renderer "keryx:
// starting…" line must never print for a readline-bound run — `--print`
// (even on a real TTY), `--no-tui`, no TTY at all (CI). It used to gate on
// raw `isTty` alone, which printed under `--print` whenever stdout happened
// to be a TTY (a scripted run captured from an interactive terminal, or a
// human piping `--print` output through `less`).
//
// A source-text check, like `shell-grant-refresh.test.ts` beside it: the
// print sits inside one long function that needs a terminal, a provider and
// a model to drive end to end.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { chooseShellSurface, parseShellCliFlags } from "./shell";

const source = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");

test("chooseShellSurface sends --print to readline regardless of TTY-ness (the exact gate the print relies on)", () => {
  const flags = parseShellCliFlags(["--print", "do the thing"]);
  expect(chooseShellSurface(flags, true)).toBe("readline");
  expect(chooseShellSurface(flags, false)).toBe("readline");
});

test("chooseShellSurface sends --no-tui and no-TTY (CI) to readline too", () => {
  expect(chooseShellSurface(parseShellCliFlags(["--no-tui"]), true)).toBe("readline");
  expect(chooseShellSurface(parseShellCliFlags([]), false)).toBe("readline");
});

test('the "keryx: starting…" line is gated on chooseShellSurface(…) !== "readline", not raw isTty', () => {
  const printIdx = source.indexOf('process.stderr.write("keryx: starting…\\n");');
  expect(printIdx).toBeGreaterThan(-1);

  // The `if` immediately above it must call chooseShellSurface — not just
  // read `runtime.isTty` / `process.stdout.isTTY` on their own, which is
  // exactly the regression (prints under `--print` on a real TTY).
  const guardStart = source.lastIndexOf("if (", printIdx);
  const guardLine = source.slice(guardStart, printIdx);
  expect(guardLine).toContain("chooseShellSurface(");
  expect(guardLine).toContain('!== "readline"');
});

test('the "keryx: starting…" gate runs before the grant refresh, and before the OFFICIAL `const surface =` (K-013 ordering unaffected)', () => {
  const printIdx = source.indexOf('process.stderr.write("keryx: starting…\\n");');
  const refreshIdx = source.indexOf("await refreshSavedGrants(");
  const officialSurfaceIdx = source.indexOf("const surface = chooseShellSurface(");
  expect(printIdx).toBeGreaterThan(-1);
  expect(refreshIdx).toBeGreaterThan(-1);
  expect(officialSurfaceIdx).toBeGreaterThan(-1);
  expect(printIdx).toBeLessThan(refreshIdx);
  // shell-grant-refresh.test.ts's own invariant, restated here so a reader
  // fixing THIS file sees immediately that it must not break that one:
  // the refresh still runs before the official surface assignment.
  expect(refreshIdx).toBeLessThan(officialSurfaceIdx);
});

test("the write is a single call with the trailing newline in the same string — no partial line is possible", () => {
  expect(source).toContain('process.stderr.write("keryx: starting…\\n");');
  // Never split into a bare write followed by a separate newline write.
  expect(source).not.toContain('process.stderr.write("keryx: starting…");');
});
