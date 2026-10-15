// Verification commands run by the parent (flow 457, T7, audit row 4).
//
// A reviewer or verifier child spawned by keryx shell has no shell_exec, so it cannot run the test that would confirm
// or refute a finding, and its claim is capped at `unverifiable`. `keryx review verify-run` runs the command in the
// parent (the orchestrator's own session, which has a shell), saves what it printed and its exit status to
// `<package>/research-evidence/verify-<finding>-<n>.txt`, and the parent hands that file to the verifier as context.
// A claim that cites such a file for its own finding is executed evidence, not reasoning: ingest records it as
// `execution` (`promoteParentExecutions`).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import type { VerificationClaimInput } from "./types";

export const VERIFY_EVIDENCE_DIR = "research-evidence";
const FINDING_ID = /^[\w.:#-]{1,80}$/;
const VERIFY_FILE = /research-evidence\/verify-([\w.:#-]+?)-(\d+)\.txt/g;
const MAX_STREAM_CHARS = 200_000;

export type VerifyRunResult = {
  file: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (argv: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export const defaultRunner: CommandRunner = async (argv, options) => {
  const proc = Bun.spawn([...argv], { cwd: options.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: options.timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, timedOut: proc.signalCode === "SIGKILL" };
};

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
 * Claims whose evidence cites a verify-run record of their own finding (an existing file under `cwd`, written by
 * `keryx review verify-run` for that finding) are recorded as `execution`: the command ran, in the parent. Any other
 * claim passes through unchanged.
 */
export function promoteParentExecutions(claims: readonly VerificationClaimInput[], cwd: string): VerificationClaimInput[] {
  return claims.map((claim) => {
    if (typeof claim.evidence !== "string" || typeof claim.finding !== "string" || claim.method === "execution") return { ...claim };
    for (const match of claim.evidence.matchAll(VERIFY_FILE)) {
      if (match[1] !== findingSlug(claim.finding)) continue;
      const cited = match[0];
      const candidates = [path.resolve(cwd, cited), ...findCited(cwd, cited)];
      const found = candidates.find((candidate) => existsSync(candidate) && isRecordFor(candidate, claim.finding as string));
      if (found !== undefined) return { ...claim, method: "execution", evidence: `${claim.evidence} [executed in the parent: ${path.relative(cwd, found)}]` };
    }
    return { ...claim };
  });
}

/** `research-evidence/verify-…` cited without its package: look in every review package under `cwd`. */
function findCited(cwd: string, cited: string): string[] {
  const reviews = path.join(cwd, ".metaproject", "reviews");
  if (!existsSync(reviews)) return [];
  try {
    return readdirSync(reviews).map((id) => path.join(reviews, id, cited));
  } catch {
    return [];
  }
}
