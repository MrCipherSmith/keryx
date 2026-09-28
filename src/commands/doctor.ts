// `keryx doctor [--json]` — flow 353 (P0 W5), AC1.
//
// One page, one pass, every line either "the operator can trust this" (ok),
// "the operator should look at this, nothing is broken" (warn), or "this is
// broken, here is the command that fixes it" (fail). It aggregates existing,
// already-fast checks rather than reinventing them — `integrations doctor`,
// `standard doctor`, the sandbox report — because a SECOND implementation of
// any of those is a second place for the two to disagree.
//
// SPEED IS A CORRECTNESS PROPERTY HERE (AC1: "runs on a fresh clone in under
// 3 s"), not a nice-to-have, so every check below is bounded:
//   - the MCP check does NOT dial servers (unlike `keryx mcp doctor`, which
//     is a real network/subprocess operation with a 10s-per-server default
//     timeout) — it reads config + trust/approval state only. Real
//     connectivity stays behind `keryx mcp doctor`, named in the fix hint.
//   - graph/wiki freshness are READ from the last report, never recomputed
//     (same rule `health/metrics/wiki-freshness.ts` already states for
//     `keryx health run`, for the identical reason).
//   - `keryx version check`'s own network call already carries a 2s timeout
//     and a 24h success cache (`lib/version-check.ts`).

import packageJson from "../../package.json" with { type: "json" };
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { checkVersion } from "../lib/version-check";
import { resolveProjectRoot } from "../lib/contained-path";
import { loadMcpServers } from "../mcp-servers/config";
import { loadTrustStore, requiresApproval } from "../mcp-servers/trust";
import { buildSandboxReport } from "./sandbox";
import { configuredProviders } from "./providers";
import { runDoctor as runStandardDoctor } from "../standard/service";
import { harnessAdapterIds, doctorIntegration } from "../integrations/service";
import { checkGraphStaleness } from "../gdgraph/service";
import { readWikiFreshnessMetric } from "../health/service";
import { resolveMainCheckoutRoot } from "../lib/git-worktrees";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** The command that fixes it. Absent for an already-`ok` check. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly checks: DoctorCheck[];
}

/** `git worktree list --porcelain`'s `worktree <path>` lines, resolved. Empty (never throws) without git or outside a repo. */
async function registeredWorktrees(cwd: string): Promise<Set<string>> {
  if (!Bun.which("git")) return new Set();
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return new Set();
    const paths = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.add(path.resolve(line.slice("worktree ".length).trim()));
      }
    }
    return paths;
  } catch {
    return new Set();
  }
}

/**
 * `.claude/worktrees/<name>` entries this project's agent harness creates
 * (`gdgraph/build.ts`'s "transient per-agent scratch checkouts") that git no
 * longer recognises as a real worktree — either the directory lost its
 * `.git` pointer, or `git worktree list` simply does not carry this path
 * (removed by hand, or by a `git worktree remove` whose directory delete
 * failed and left the shell behind). Both are what `git worktree prune`
 * exists to clean up; this only REPORTS them; it never deletes anything.
 *
 * Backlog item 13 (flow 356): `.claude/worktrees` is resolved beside the
 * MAIN checkout (`resolveMainCheckoutRoot`, `git rev-parse
 * --git-common-dir`), not beside `cwd` — run from inside a LINKED worktree,
 * `path.join(cwd, ".claude", "worktrees")` used to say "no .claude/worktrees
 * directory" while the main checkout had dozens, because it was looking
 * beside the wrong root. `git worktree list` itself is unaffected by this
 * (it already answers the same way from any worktree of one repo), so only
 * the directory this check reads needs to change.
 */
async function checkWorktrees(cwd: string): Promise<DoctorCheck> {
  const mainRoot = (await resolveMainCheckoutRoot(cwd)) ?? cwd;
  const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
  let entries: string[];
  try {
    entries = (await readdir(worktreesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { id: "worktrees", status: "ok", detail: "no .claude/worktrees directory" };
  }
  if (entries.length === 0) {
    return { id: "worktrees", status: "ok", detail: ".claude/worktrees is empty" };
  }

  const registered = await registeredWorktrees(cwd);
  const stale = entries.filter((name) => {
    const full = path.resolve(worktreesDir, name);
    return !existsSync(path.join(full, ".git")) || !registered.has(full);
  });

  if (stale.length === 0) {
    return {
      id: "worktrees",
      status: "ok",
      detail: `${entries.length} worktree(s) under .claude/worktrees, all registered`,
    };
  }
  return {
    id: "worktrees",
    status: "warn",
    detail: `${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} under .claude/worktrees: ${stale.join(", ")}`,
    fix: "git worktree prune, then remove the listed directories under .claude/worktrees by hand",
  };
}

/** A simple `>=X.Y.Z` floor check — the only shape `package.json`'s `engines.bun` actually uses. An unparseable floor or current version never fails the check; it is not this check's job to validate either string. */
export function meetsBunFloor(current: string, floor: string): boolean {
  const floorMatch = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(floor);
  const currentMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!floorMatch || !currentMatch) return true;
  for (let i = 1; i <= 3; i += 1) {
    const f = Number(floorMatch[i]);
    const c = Number(currentMatch[i]);
    if (c !== f) return c > f;
  }
  return true;
}

/**
 * `bunFloorOverride` (review round 1, T1) exists ONLY so a test can drive a
 * genuine `fail` through the real `doctorCommand`/`buildDoctorReport` path —
 * a floor from anywhere but `package.json` is not a real environment fact,
 * so no production caller ever passes it; every real invocation reads the
 * documented floor, unchanged.
 */
function checkBun(bunFloorOverride?: string): DoctorCheck {
  const floor = bunFloorOverride ?? (packageJson as { engines?: { bun?: string } }).engines?.bun;
  const current = Bun.version;
  if (floor === undefined || meetsBunFloor(current, floor)) {
    return { id: "bun", status: "ok", detail: `Bun ${current}${floor ? ` (floor ${floor})` : ""}` };
  }
  return {
    id: "bun",
    status: "fail",
    detail: `Bun ${current} is below the documented floor ${floor}`,
    fix: "upgrade Bun: https://bun.sh/docs/installation",
  };
}

function checkRipgrep(): DoctorCheck {
  const rg = Bun.which("rg");
  return rg
    ? { id: "ripgrep", status: "ok", detail: `rg at ${rg}` }
    : {
        id: "ripgrep",
        status: "warn",
        detail: "ripgrep (rg) not found on PATH — keryx ctx rg and search_code are unavailable",
        fix: "brew install ripgrep (macOS) or apt install ripgrep (Debian/Ubuntu)",
      };
}

async function checkVersionAvailability(): Promise<DoctorCheck> {
  const result = await checkVersion({ currentVersion: packageJson.version });
  if (result.status === "update-available") {
    return {
      id: "version",
      status: "warn",
      detail: `keryx ${result.currentVersion} → ${result.latestVersion} is available`,
      fix: result.installCommand,
    };
  }
  if (result.status === "up-to-date") {
    return { id: "version", status: "ok", detail: `keryx ${result.currentVersion} is up to date` };
  }
  // "unavailable" (offline, timeout, suppressed, …) is not the operator's
  // fault and blocks nothing — reported at `ok` with the reason, not `warn`.
  return { id: "version", status: "ok", detail: `keryx ${result.currentVersion}; update check unavailable (${result.reason})` };
}

function checkSandbox(): DoctorCheck {
  const report = buildSandboxReport();
  if (report.launcher.available) {
    return { id: "sandbox", status: "ok", detail: `${report.launcherName ?? "sandbox launcher"} available` };
  }
  const known = report.launcherName !== undefined;
  return {
    id: "sandbox",
    status: "warn",
    detail: known
      ? `${report.launcherName} not installed on ${report.platform} — OS-sandboxed shell exec is unavailable`
      : `no OS sandbox launcher support on ${report.platform}`,
    fix: known ? "keryx sandbox status for what installing it would unlock" : "keryx sandbox status for details",
  };
}

/** Names only — never a credential value. See `configuredProviders` (providers.ts), which already returns name+models only. */
function checkProviders(env: Record<string, string | undefined>): DoctorCheck {
  const providers = configuredProviders(env);
  if (providers.length === 0) {
    return {
      id: "providers",
      status: "warn",
      detail: "no provider credentials configured",
      fix: "keryx auth login <provider>, or set a provider API key",
    };
  }
  return {
    id: "providers",
    status: "ok",
    detail: `${providers.length} provider(s) configured: ${providers.map((p) => p.name).join(", ")}`,
  };
}

/**
 * Config validity + trust/approval state, NOT connectivity — see the
 * module doc comment for why doctor never dials here. `keryx mcp doctor`
 * remains the deep check (connects, counts tools, names what dropped).
 */
function checkMcp(cwd: string): DoctorCheck {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadMcpServers({ cwd, gitRoot: projectRoot });
  const ownProblems = config.problems.filter((p) => !p.foreign);
  if (ownProblems.length > 0) {
    return {
      id: "mcp",
      status: "fail",
      detail: `${ownProblems.length} config problem(s) in keryx's own MCP config: ${ownProblems.map((p) => p.message).join("; ")}`,
      fix: "keryx mcp list for details",
    };
  }
  const approvals = loadTrustStore();
  const held = config.servers.filter((server) => server.enabled && requiresApproval(server, approvals));
  if (held.length > 0) {
    return {
      id: "mcp",
      status: "warn",
      detail: `${held.length} server(s) from committed config awaiting approval: ${held.map((s) => s.name).join(", ")}`,
      fix: "keryx mcp trust <name>, after reading what it launches",
    };
  }
  return {
    id: "mcp",
    status: "ok",
    detail: `${config.servers.length} server(s) configured; run \`keryx mcp doctor\` to also check connectivity`,
  };
}

async function checkIntegrations(cwd: string): Promise<DoctorCheck> {
  const results = await Promise.all(
    harnessAdapterIds().map(async (id) => {
      try {
        return await doctorIntegration(cwd, id);
      } catch {
        // An adapter that cannot even be diagnosed is not this check's
        // failure to report as drift — `integrations doctor` itself is
        // where that error belongs.
        return { runtimeId: id, surfaces: [], problems: [], ok: true };
      }
    }),
  );
  const drifted = results.filter((r) => !r.ok);
  if (drifted.length === 0) {
    return { id: "integrations", status: "ok", detail: "no drift in any installed integration" };
  }
  return {
    id: "integrations",
    status: "warn",
    detail: `drift in: ${drifted.map((r) => r.runtimeId).join(", ")}`,
    fix: "keryx integrations doctor --runtime all",
  };
}

async function checkStandard(cwd: string): Promise<DoctorCheck> {
  const result = await runStandardDoctor(cwd);
  if (result.errors.length > 0) {
    return {
      id: "standard",
      status: "fail",
      detail: `${result.errors.length} error(s): ${result.errors.map((e) => e.message).join("; ")}`,
      fix: "keryx standard doctor",
    };
  }
  if (result.warnings.length > 0) {
    return {
      id: "standard",
      status: "warn",
      detail: `${result.warnings.length} warning(s): ${result.warnings.map((w) => w.message).join("; ")}`,
      fix: "keryx standard doctor",
    };
  }
  return { id: "standard", status: "ok", detail: "workspace is Metaproject Standard compliant" };
}

async function checkGraphFreshness(cwd: string): Promise<DoctorCheck> {
  const result = await checkGraphStaleness(cwd);
  if (result.status === "fresh") {
    return { id: "graph-freshness", status: "ok", detail: "code graph is fresh" };
  }
  return {
    id: "graph-freshness",
    status: "warn",
    detail: result.reasons.join("; ") || `code graph is ${result.status}`,
    fix: "keryx gdgraph build",
  };
}

async function checkWikiFreshness(cwd: string): Promise<DoctorCheck> {
  const metric = await readWikiFreshnessMetric(cwd);
  if (metric.status === "measured") {
    const pct = metric.ratio !== undefined ? `${Math.round(metric.ratio * 100)}%` : "an unmeasured share";
    return {
      id: "wiki-freshness",
      status: "ok",
      detail: `${pct} of ${metric.pagesTotal ?? "?"} wiki page(s) fresh`,
    };
  }
  return {
    id: "wiki-freshness",
    status: "warn",
    detail: metric.reason ?? `wiki freshness: ${metric.status}`,
    fix: "keryx wiki freshness",
  };
}

export interface DoctorTestOverrides {
  /** Review round 1, T1: drive a genuine `bun` `fail` without touching `package.json` or the running Bun. Never set by a real caller. */
  readonly bunFloor?: string;
}

/**
 * Is there a `.metaproject/` at or above `cwd`? Deliberately narrower than
 * `resolveProjectRoot` (which also stops at a bare `.git`, no `.metaproject`
 * required, for OTHER callers that only need a repository boundary) —
 * backlog item 12 is specifically about the ABSENCE of a Metaproject
 * workspace, so a plain git repo with none still reads as "not a keryx
 * project" here.
 *
 * Also checks the MAIN checkout (same `resolveMainCheckoutRoot` as the
 * `worktrees` check, backlog item 13) when `cwd` itself has none: an agent
 * worktree under `.claude/worktrees/<name>` never carries its own
 * `.metaproject/` — that lives only in the main checkout — so without this,
 * `keryx doctor` run from inside one would misreport a real keryx project
 * as uninitialized.
 */
async function isKeryxProject(cwd: string): Promise<boolean> {
  if (existsSync(path.join(resolveProjectRoot(cwd), ".metaproject"))) {
    return true;
  }
  const mainRoot = await resolveMainCheckoutRoot(cwd);
  return mainRoot !== undefined && existsSync(path.join(mainRoot, ".metaproject"));
}

/**
 * Backlog item 12 (flow 356): outside a keryx project, `doctor` used to run
 * every project-scoped check against a directory with no `.metaproject/` —
 * `checkStandard` alone produced SEVEN "Required file … is missing" `fail`
 * lines and exit 1, which reads as "keryx is broken" rather than "run
 * `keryx init`". Detected ONCE, here: one `warn` line replaces every
 * project-scoped check, and the command exits 0 (the global, non-project
 * checks below still run and can still genuinely `fail`, e.g. Bun below the
 * documented floor — that is a real problem with no project involved).
 */
const NOT_A_KERYX_PROJECT_CHECK: DoctorCheck = {
  id: "project",
  status: "warn",
  detail: "not a keryx project — run `keryx init`",
  fix: "keryx init",
};

/**
 * Build the whole report. Every check runs, regardless of any other one's
 * result — a broken MCP config must never hide a stale graph. Order here
 * is the order AC1 lists them in, which is also render/JSON order.
 *
 * Project-scoped checks (mcp, integrations, standard, worktrees, graph/wiki
 * freshness) are skipped entirely outside a keryx project (backlog item 12)
 * — {@link NOT_A_KERYX_PROJECT_CHECK} stands in for all six.
 */
export async function buildDoctorReport(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  overrides: DoctorTestOverrides = {},
): Promise<DoctorReport> {
  const globalChecks = await Promise.all([
    checkVersionAvailability(),
    Promise.resolve(checkBun(overrides.bunFloor)),
    Promise.resolve(checkRipgrep()),
    Promise.resolve(checkSandbox()),
    Promise.resolve(checkProviders(env)),
  ]);

  if (!(await isKeryxProject(cwd))) {
    return { checks: [...globalChecks, NOT_A_KERYX_PROJECT_CHECK] };
  }

  const projectChecks = await Promise.all([
    Promise.resolve(checkMcp(cwd)),
    checkIntegrations(cwd),
    checkStandard(cwd),
    checkWorktrees(cwd),
    checkGraphFreshness(cwd),
    checkWikiFreshness(cwd),
  ]);
  return { checks: [...globalChecks, ...projectChecks] };
}

/** Exit-code predicate, extracted so it is testable against a synthetic report without needing a real environment to produce a genuine "fail". */
export function doctorFailed(report: DoctorReport): boolean {
  return report.checks.some((check) => check.status === "fail");
}

export function formatDoctorReport(report: DoctorReport): string {
  const symbolFor: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines = ["keryx doctor", ""];
  for (const check of report.checks) {
    lines.push(`  ${symbolFor[check.status]} ${check.id}: ${check.detail}`);
    if (check.fix) {
      lines.push(`      fix: ${check.fix}`);
    }
  }
  return lines.join("\n");
}

export async function doctorCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
  overrides: DoctorTestOverrides = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`keryx doctor [--json]

One page: keryx's own version and update availability, the Bun floor,
ripgrep on PATH, the OS sandbox launcher, providers with a credential
present (names only), MCP servers and their trust state, integrations
drift, Metaproject Standard warnings, stale .claude/worktrees entries, and
graph/wiki freshness. Exits 0 unless something is a "fail".`);
    return;
  }
  const report = await buildDoctorReport(cwd, process.env, overrides);
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }
  if (doctorFailed(report)) {
    process.exitCode = 1;
  }
}
