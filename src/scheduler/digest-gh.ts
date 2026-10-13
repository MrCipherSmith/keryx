// Flow 389: how the scheduled digest runs `gh`.
//
// The digest never builds a gh command line itself. Every call is a catalogue
// entry (`../trigger/granted-tools`), whose argv is fixed and read-only, run
// with the flow 295 granted-command runner (`execFile`, no shell, timeout,
// output cap, secrets scrubbed). What this file adds is the multi-account rule:
//
//   ~/work/**        -> the work GitHub account
//   everything else  -> the personal account
//
// The machine's `gh` wrapper picks the account from the git toplevel of its
// cwd. Granted tools run from an empty scratch directory (flow 295 N2), so the
// wrapper can no longer see the project. The digest therefore computes the
// account from the PROJECT'S path and passes it as `GH_ACCOUNT`, the wrapper's
// own override. It never runs `gh auth switch` or `gh auth login`, and no
// catalogue entry could (see `ghReadOnlyProblem`).
//
// `GH_ACCOUNT` means something only to that wrapper. Against the real `gh`
// binary it is ignored and gh uses whichever login is active. The digest cannot
// ask gh who that is (`gh api` and `gh auth` are not in the read-only catalogue),
// so it states in every run report which account it asked for, and the guide
// says the choice needs the wrapper.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runGrantedCommand } from "../commands/trigger-agent-task";

export type GhAccount = "work" | "personal";

/** The account the project's path selects. A path under the work root is `work`, anything else `personal`. */
export function ghAccountForPath(
  projectRoot: string,
  options: { readonly home?: string; readonly workRoot?: string } = {},
): GhAccount {
  const home = options.home ?? homedir();
  const workRoot = options.workRoot ?? path.join(home, "work");
  let resolved = projectRoot;
  try {
    resolved = realpathSync(projectRoot);
  } catch {
    // a path that cannot be resolved is judged as written
  }
  let work = workRoot;
  try {
    work = realpathSync(workRoot);
  } catch {
    // the work root may not exist on this machine
  }
  return resolved === work || resolved.startsWith(`${work}${path.sep}`) ? "work" : "personal";
}

/**
 * The variables a digest's gh child may inherit from serve: what gh and the machine's gh wrapper need to
 * find their config, the network and the locale, and nothing else. A token variable (`GH_TOKEN`,
 * `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`) is never on the list: it would silently override the account the
 * project's path chose, and no other secret of the host has any business in a read-only `gh` call.
 */
const GH_ENV_ALLOWED: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  // gh's own config location, and the gh wrapper's overrides (see the header of this file)
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_REAL_BIN",
  "GH_WORK_ROOT",
  "GH_WORK_CONFIG_DIR",
  "GH_PERSONAL_CONFIG_DIR",
  // a corporate proxy or CA bundle, so gh can still reach GitHub
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

function ghEnvAllowed(name: string): boolean {
  return GH_ENV_ALLOWED.has(name) || name.startsWith("LC_") || name.startsWith("XDG_");
}

/** The environment the digest's gh calls run with: an allowlisted part of the operator's own, plus the path-chosen account. */
export function ghEnvForProject(
  projectRoot: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const workRoot = base["GH_WORK_ROOT"];
  const account = ghAccountForPath(projectRoot, workRoot !== undefined && workRoot.length > 0 ? { workRoot } : {});
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && ghEnvAllowed(name)) env[name] = value;
  }
  return { ...env, GH_ACCOUNT: account };
}

export interface GhCall {
  /** The verified absolute path of `gh`. */
  readonly bin: string;
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly secrets: readonly string[];
}

export interface GhResult {
  readonly ok: boolean;
  /** The command's standard output (already scrubbed). Empty on failure. */
  readonly stdout: string;
  /** Why it failed; empty on success. */
  readonly detail: string;
  readonly exitCode: number | null;
}

/** The seam a test replaces with a fake `gh`. Production is `defaultGhRunner`. */
export type GhRunner = (call: GhCall) => Promise<GhResult>;

const STDERR_MARK = "\n[stderr]\n";
const TRUNCATED = /\n\[output truncated at \d+ bytes\]/;
const EXIT_MARK = /\n\[exit: [^\]]*\]$/;

/** Split the granted runner's combined output back into stdout and a failure detail. */
export function parseGrantedOutput(output: string, ok: boolean, exitCode: number | null): GhResult {
  const exit = EXIT_MARK.exec(output);
  const withoutExit = exit === null ? output : output.slice(0, exit.index);
  const stderrAt = withoutExit.indexOf(STDERR_MARK);
  const stdout = stderrAt === -1 ? withoutExit : withoutExit.slice(0, stderrAt);
  const stderr = stderrAt === -1 ? "" : withoutExit.slice(stderrAt + STDERR_MARK.length).trim();
  if (!ok) {
    const why = stderr.length > 0 ? stderr : exit !== null ? exit[0].trim() : "gh failed";
    return { ok: false, stdout: "", detail: `${why.replace(/\s+/g, " ").slice(0, 300)}`, exitCode };
  }
  // A capped answer is half a JSON document: treat it as a failure, never parse it.
  if (TRUNCATED.test(stdout)) {
    return { ok: false, stdout: "", detail: "gh answered with more output than the cap allows", exitCode };
  }
  return { ok: true, stdout, detail: "", exitCode };
}

export const defaultGhRunner: GhRunner = async (call) => {
  const result = await runGrantedCommand(call.bin, call.argv, call.cwd, call.env, call.signal, call.secrets);
  return parseGrantedOutput(result.output, result.ok, result.exitCode);
};
