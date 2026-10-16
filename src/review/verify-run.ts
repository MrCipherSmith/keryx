// Verification commands run by the parent (flow 457, T7, audit row 4).
//
// A reviewer or verifier child spawned by keryx shell has no shell_exec, so it cannot run the test that would confirm
// or refute a finding, and its claim is capped at `unverifiable`. `keryx review verify-run` runs the command in the
// parent (the orchestrator's own session, which has a shell), saves what it printed and its exit status to
// `<package>/research-evidence/verify-<finding>-<n>.txt`, and the parent hands that file to the verifier as context.
// A claim that cites such a file for its own finding is executed evidence, not reasoning: ingest records it as
// `execution` (`promoteParentExecutions`).

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import type { VerificationClaimInput } from "./types";

export const VERIFY_EVIDENCE_DIR = "research-evidence";
const FINDING_ID = /^[\w.:#-]{1,80}$/;
/** `[reviews/<id>/]research-evidence/verify-<finding>-<n>.txt`; the package id, when cited, must be the package's own. */
const VERIFY_FILE = /(reviews\/([\w.-]+)\/)?research-evidence\/verify-([\w.:#-]+?)-(\d+)\.txt/g;
const MAX_STREAM_CHARS = 200_000;

export type VerifyRunResult = {
  file: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (argv: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

/**
 * Runs the command in its own process group (security review M7) and, on timeout, kills the whole group: a
 * `sh -c "…"` command line forks children that a kill of the shell alone would leave running.
 */
export const defaultRunner: CommandRunner = (argv, options) =>
  new Promise((resolve, reject) => {
    const [command, ...rest] = argv;
    if (command === undefined) {
      reject(new Error("verify-run needs a command"));
      return;
    }
    const child = spawn(command, rest, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length <= MAX_STREAM_CHARS) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length <= MAX_STREAM_CHARS) stderr += chunk;
    });
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // The group leader may have exited while a grandchild still runs; a timed-out run has already killed the group.
      resolve({ exitCode: code ?? (signal === null ? 1 : 128 + (signal === "SIGKILL" ? 9 : 15)), stdout, stderr, timedOut });
    });
  });

/** A file-name-safe form of a finding id (`#` and `:` are kept out of file names). */
export function findingSlug(finding: string): string {
  return finding.replace(/[^\w.-]/g, "_");
}

/** The next free `verify-<finding>-<n>.txt` in the package. */
export function nextVerifyFile(packageDir: string, finding: string): string {
  const dir = path.join(packageDir, VERIFY_EVIDENCE_DIR);
  const slug = findingSlug(finding);
  const taken = existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(`verify-${slug}-`) && name.endsWith(".txt")).length : 0;
  let n = taken + 1;
  while (existsSync(path.join(dir, `verify-${slug}-${n}.txt`))) n += 1;
  return path.join(dir, `verify-${slug}-${n}.txt`);
}

const clip = (text: string): string => (text.length > MAX_STREAM_CHARS ? `${text.slice(0, MAX_STREAM_CHARS)}\n…(clipped: ${text.length - MAX_STREAM_CHARS} more characters)` : text);

/** Runs `argv` in `cwd` and saves the record. One argument is run through `sh -c`, so a quoted command line works. */
export async function verifyRun(input: {
  packageDir: string;
  finding: string;
  argv: readonly string[];
  cwd: string;
  timeoutMs?: number | undefined;
  runner?: CommandRunner | undefined;
  now?: Date | undefined;
}): Promise<VerifyRunResult> {
  if (!FINDING_ID.test(input.finding)) throw new Error(`--finding must be a finding id (letters, digits, . : # - _), got "${input.finding}"`);
  if (input.argv.length === 0) throw new Error("verify-run needs a command after `--`: keryx review verify-run --package <dir> --finding <id> -- <command…>");
  const argv = input.argv.length === 1 ? ["sh", "-c", input.argv[0]!] : [...input.argv];
  const timeoutMs = input.timeoutMs ?? 600_000;
  const result = await (input.runner ?? defaultRunner)(argv, { cwd: input.cwd, timeoutMs });
  const file = nextVerifyFile(input.packageDir, input.finding);
  await mkdir(path.dirname(file), { recursive: true });
  const body = [
    `# keryx review verify-run`,
    `finding: ${input.finding}`,
    `command: ${input.argv.join(" ")}`,
    `cwd: ${input.cwd}`,
    `time: ${(input.now ?? new Date()).toISOString()}`,
    `exit: ${result.exitCode}${result.timedOut ? ` (killed after ${timeoutMs} ms)` : ""}`,
    "",
    "--- stdout ---",
    clip(result.stdout).trimEnd(),
    "--- stderr ---",
    clip(result.stderr).trimEnd(),
    "",
  ].join("\n");
  await writeFileAtomic(file, body);
  return { file, exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
}

/** Whether `file` is a verify-run record (written by keryx: it starts with the header and names `finding`). */
function isRecordFor(file: string, finding: string): boolean {
  try {
    const head = readFileSync(file, "utf8").slice(0, 400);
    return head.startsWith("# keryx review verify-run") && head.includes(`\nfinding: ${finding}\n`);
  } catch {
    return false;
  }
}

/**
 * Claims whose evidence cites a verify-run record of their own finding IN THIS PACKAGE (an existing file under
 * `<packageDir>/research-evidence/`, written by `keryx review verify-run` for that finding) are recorded as
 * `execution`: the command ran, in the parent. A record of the same finding id in another package (another round,
 * another review) does not count (security review minor), and without a package nothing is promoted. Any other
 * claim passes through unchanged.
 */
export function promoteParentExecutions(claims: readonly VerificationClaimInput[], packageDir: string | undefined): VerificationClaimInput[] {
  return claims.map((claim) => {
    if (packageDir === undefined || typeof claim.evidence !== "string" || typeof claim.finding !== "string" || claim.method === "execution") return { ...claim };
    for (const match of claim.evidence.matchAll(VERIFY_FILE)) {
      if (match[2] !== undefined && match[2] !== path.basename(packageDir)) continue;
      if (match[3] !== findingSlug(claim.finding)) continue;
      const found = path.join(packageDir, VERIFY_EVIDENCE_DIR, `verify-${match[3]}-${match[4]}.txt`);
      if (existsSync(found) && isRecordFor(found, claim.finding)) {
        return { ...claim, method: "execution", evidence: `${claim.evidence} [executed in the parent: ${path.join(path.basename(packageDir), VERIFY_EVIDENCE_DIR, path.basename(found))}]` };
      }
    }
    return { ...claim };
  });
}
