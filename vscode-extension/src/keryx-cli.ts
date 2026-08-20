// Thin child_process I/O seam for shelling out to the `keryx` CLI. Kept
// separate from `status-logic.ts`/`version-logic.ts` (which are pure) and
// from `extension.ts` (which is `vscode`-API-calling) so each layer stays
// independently testable/mockable. This module IS impure (spawns a real
// process) but has no `vscode` dependency, so a future test could still
// exercise it directly against a real `keryx` binary on PATH without a VS
// Code instance — not done here since no such run was requested, but the
// seam is shaped for it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class KeryxBinaryNotFoundError extends Error {
  constructor(cause: unknown) {
    super(
      "The `keryx` CLI was not found on PATH. Install it (see https://github.com/MrCipherSmith/keryx) and reload the window.",
    );
    this.name = "KeryxBinaryNotFoundError";
    this.cause = cause;
  }
}

/**
 * Run a `keryx` subcommand in `cwd`, returning stdout/stderr/exit code
 * instead of throwing on a non-zero exit (the 3-state `status` contract and
 * `init --yes` both use exit code as signal, not just as a pass/fail gate).
 * A genuinely missing binary (ENOENT) is raised as a named error so the
 * activation call site can show an actionable message instead of an
 * unexplained crash.
 *
 * `env` and `binary` are injectable (defaulting to the real environment and
 * `"keryx"`) purely so tests can exercise the ENOENT branch deterministically
 * against a guaranteed-missing name instead of depending on `keryx` being
 * absent from the test runner's PATH.
 */
export async function runKeryx(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  binary = "keryx",
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, [...args], { cwd, env });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (nodeError.code === "ENOENT") {
      throw new KeryxBinaryNotFoundError(error);
    }
    // A non-zero exit from execFile still carries stdout/stderr — surface it
    // as a result, not an exception, so callers can parse output normally.
    return {
      stdout: nodeError.stdout ?? "",
      stderr: nodeError.stderr ?? "",
      exitCode: typeof nodeError.code === "number" ? nodeError.code : 1,
    };
  }
}
