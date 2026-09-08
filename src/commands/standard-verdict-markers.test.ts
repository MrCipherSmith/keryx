import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { standardCommand } from "./standard";

/**
 * F-240-04 (flow 240 T7): the contract `.github/workflows/ci.yml` depends on.
 *
 * `standard validate` exits 1 when the workspace fails validation, and `bun`
 * exits 1 when it cannot load `./src/cli.ts` at all. CI used to fold both into
 * `status=fail`, so a baseline job that never ran published `baseline-red` — and
 * a red baseline excuses every PR failure. Reproduced in a directory with no
 * `./src/cli.ts`: `error: Module not found "./src/cli.ts"`, `status=fail`.
 *
 * The fix separates "ran and failed" from "did not run" by requiring a VERDICT
 * LINE, because the exit-code channel cannot carry three states. Both CI jobs
 * run, verbatim:
 *
 *   if [ "$code" -eq 0 ] && grep -Fq 'workspace is Metaproject Standard compliant' validate.log
 *   elif [ "$code" -ne 0 ] && grep -Eq 'FAIL .*[0-9]+ error\(s\)' validate.log
 *   else status=unknown
 *
 * That is a contract on this command's output, and a contract nothing pins is a
 * contract that drifts: reword either line and CI silently degrades every run to
 * `unknown`. These tests pin both patterns against the real command, so the
 * rewording breaks here — where the reason is legible — instead of there.
 */

const PASS_MARKER = "workspace is Metaproject Standard compliant";
const FAIL_MARKER = /FAIL .*[0-9]+ error\(s\)/;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function runValidateCapturingOutput(root: string): Promise<{ output: string; exitCode: number }> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await standardCommand(["validate"], root);
    return { output: lines.join("\n"), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = previousExitCode;
  }
}

test("a workspace that is not a Metaproject emits the FAIL verdict CI greps for", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-standard-verdict-"));
  try {
    const { output, exitCode } = await runValidateCapturingOutput(root);

    expect(exitCode).toBe(1);
    expect(output).toMatch(FAIL_MARKER);
    expect(output).not.toContain(PASS_MARKER);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Deliberately asserted as an EXCLUSIVE OR rather than as "this repository
 * passes". CI's need is not that the repo is compliant — `standard-pr` measures
 * that — but that a command which RAN always emits exactly one recognisable
 * verdict, so "neither pattern matched" can safely mean "it did not run".
 * Pinning the repo's compliance state here instead would make this file go red
 * for reasons that have nothing to do with the markers.
 */
test("a real run always emits exactly one of the two verdicts, agreeing with its exit code", async () => {
  const { output, exitCode } = await runValidateCapturingOutput(REPO_ROOT);

  const passed = output.includes(PASS_MARKER);
  const failed = FAIL_MARKER.test(output);
  expect(passed !== failed).toBe(true);
  expect(passed).toBe(exitCode === 0);
});

test("neither verdict appears when the command never produced one", () => {
  // The exact bytes the reproduction produced. CI classifies this `unknown`.
  const didNotRun = 'error: Module not found "./src/cli.ts"';
  expect(didNotRun.includes(PASS_MARKER)).toBe(false);
  expect(FAIL_MARKER.test(didNotRun)).toBe(false);
});
