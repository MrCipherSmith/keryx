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
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { gitToplevel } from "../lib/clone-scope";
import { claudeHooksExpected, inspectEntrypoints, type EntrypointInspection } from "../rules/entrypoint-inspection";
import { CODEX_PROJECT_DOC_MAX_BYTES } from "../rules/entrypoint-writers";

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

const UPDATE_FIX = "keryx update";

/**
 * Flow 361 (AC11): where keryx's managed content is, against where
 * `agentEntrypoints` says it belongs — the index block, the ignore block and
 * the managed Claude hooks, the `AGENTS.override.md` Codex reads, and the
 * per-developer files this checkout should have. Warnings only: nothing here
 * breaks keryx, and `keryx update` repairs every one except the two that need
 * a person (an override keryx did not write, one Codex would cut short).
 *
 * Content the team COMMITTED in `HEAD` is the owner-approved shared case — the
 * writers leave it where it is — so it is named in an `ok` line, never warned
 * about. Read-only: every question goes to git or the filesystem, nothing is
 * written (`inspectEntrypoints`).
 */
export async function checkEntrypoints(cwd: string): Promise<DoctorCheck> {
  const projectRoot = resolveProjectRoot(cwd);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(projectRoot, ".metaproject", "metaproject.json"), "utf8"));
  } catch {
    manifest = undefined;
  }
  const agentEntrypoints = typeof manifest === "object" && manifest !== null ? (manifest as { agentEntrypoints?: unknown }).agentEntrypoints : undefined;
  let inspection: EntrypointInspection;
  try {
    inspection = await inspectEntrypoints(projectRoot, agentEntrypoints, { hooksExpected: await claudeHooksExpected(projectRoot, manifest) });
  } catch (error) {
    return {
      id: "entrypoints",
      status: "warn",
      detail: `could not inspect the agent entrypoints: ${error instanceof Error ? error.message : String(error)}`,
      fix: UPDATE_FIX,
    };
  }

  const warnings: Array<{ detail: string; fix: string }> = [];
  const localPaths = inspection.targets.root.filter((entry) => entry.scope === "local").map((entry) => entry.path);
  for (const stray of inspection.strayIndexBlocks) {
    if (!stray.tracked || stray.committed) continue;
    warnings.push({
      detail: `${stray.path} carries the managed keryx:index block as an uncommitted edit, but its scope is local — the block belongs in ${localPaths.join(" / ")}`,
      fix: UPDATE_FIX,
    });
  }
  const { gitignoreBlock, strayHooks } = inspection;
  if (gitignoreBlock !== undefined && gitignoreBlock.tracked && !gitignoreBlock.committed) {
    warnings.push({ detail: ".gitignore carries keryx's managed ignore block as an uncommitted edit — it belongs in info/exclude", fix: UPDATE_FIX });
  }
  if (inspection.duplicateHooks && strayHooks !== undefined) {
    warnings.push({
      detail: `keryx-managed hooks are in both ${strayHooks.path} and ${strayHooks.to} — Claude Code merges the two files and would run each hook twice`,
      fix: UPDATE_FIX,
    });
  } else if (strayHooks !== undefined && strayHooks.tracked && !strayHooks.committed) {
    warnings.push({
      detail: `${strayHooks.path} holds keryx-managed hooks as an uncommitted edit, but claudeSettings scope is ${inspection.targets.claudeSettings.scope} — they belong in ${strayHooks.to}`,
      fix: UPDATE_FIX,
    });
  }

  const codex = inspection.codex;
  if (codex?.mode === "override") {
    const overridePath = codex.entry.path;
    if (codex.state === "stale") {
      warnings.push({ detail: `${overridePath} is stale — ${codex.entry.source} changed since it was generated, and Codex reads the override instead`, fix: UPDATE_FIX });
    } else if (codex.state === "source-missing") {
      warnings.push({ detail: `${overridePath} is stale — its source ${codex.entry.source} no longer exists`, fix: UPDATE_FIX });
    } else if (codex.state === "unmanaged") {
      warnings.push({
        detail: `${overridePath} was not generated by keryx, so Codex reads it instead of ${codex.entry.source} and without the managed block`,
        fix: `remove ${overridePath} and run keryx update, or set the codex entry's mode to "skip"`,
      });
    }
    if (codex.bytes !== undefined && codex.bytes > CODEX_PROJECT_DOC_MAX_BYTES) {
      warnings.push({
        detail: `${overridePath} is ${codex.bytes} bytes; Codex reads at most ${CODEX_PROJECT_DOC_MAX_BYTES} bytes of project instructions (project_doc_max_bytes) and truncates the rest`,
        fix: `shorten ${codex.entry.source} (keryx rules distill splits a large one), then keryx update — or raise project_doc_max_bytes in the Codex config`,
      });
    }
  }

  // A runtime back on shared (or Codex on `skip`) whose local target keryx
  // has not cleaned yet: Claude reads the block twice, or Codex keeps reading
  // an old copy of the team file. A file keryx leaves alone is not warned about.
  for (const leftover of inspection.localLeftovers) {
    if (leftover.action === "keep") continue;
    warnings.push({
      detail:
        leftover.runtime === "claude"
          ? `${leftover.path} still carries the managed keryx:index block, but ${leftover.because} — Claude Code reads the block from both ${leftover.path} and ${leftover.instead}`
          : `${leftover.path} is a keryx-generated override, but ${leftover.because} — Codex reads it instead of ${leftover.instead}`,
      fix: UPDATE_FIX,
    });
  }

  // Hooks still sitting in the other file are what `update` moves in; the
  // local file being absent meanwhile is the same finding, not a second one.
  const missing = inspection.localTargets.filter(
    (target) => target.expected && !target.exists && !(target.kind === "claudeSettings" && strayHooks !== undefined),
  );
  if (missing.length > 0) {
    warnings.push({
      detail: `${missing.map((target) => target.path).join(", ")} missing in this checkout — local targets are gitignored and per checkout, so a fresh clone or a linked worktree starts without them`,
      fix: UPDATE_FIX,
    });
  }
  const unignored = inspection.localTargets.filter((target) => target.exists && target.ignored === false);
  if (unignored.length > 0) {
    warnings.push({
      detail: `${unignored.map((target) => target.path).join(", ")} not ignored by git — a per-developer file that would show up in git status`,
      fix: UPDATE_FIX,
    });
  }

  if (warnings.length > 0) {
    return {
      id: "entrypoints",
      status: "warn",
      detail: warnings.map((warning) => warning.detail).join("; "),
      fix: [...new Set(warnings.map((warning) => warning.fix))].join("; "),
    };
  }
  return { id: "entrypoints", status: "ok", detail: describeEntrypoints(inspection) };
}

/** The `ok` line: where the block and the hooks are, with their scope — shared content committed in `HEAD` named as such. */
function describeEntrypoints(inspection: EntrypointInspection): string {
  const parts: string[] = [];
  const local = inspection.localTargets.filter((target) => target.kind !== "claudeSettings" && target.exists).map((target) => target.path);
  if (local.length > 0) parts.push(`managed block in ${local.join(", ")} (local)`);
  const committed = inspection.sharedIndexBlocks.filter((entry) => entry.committed).map((entry) => entry.path);
  const uncommitted = inspection.sharedIndexBlocks.filter((entry) => !entry.committed).map((entry) => entry.path);
  if (committed.length > 0) parts.push(`managed block in ${committed.join(", ")} (shared, committed in HEAD)`);
  if (uncommitted.length > 0) parts.push(`managed block in ${uncommitted.join(", ")} (shared)`);
  if (inspection.codex?.mode === "skip") parts.push("Codex skipped (mode \"skip\")");
  if (inspection.targetHoldsHooks) {
    parts.push(`hooks in ${inspection.targets.claudeSettings.path} (${inspection.targets.claudeSettings.scope})`);
  }
  return parts.length > 0 ? parts.join("; ") : "no managed entrypoint content to check";
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
  /**
   * Review round 1, L2/TEST-1: the ceiling {@link isKeryxProject}'s
   * outside-a-repo upward walk stops at (inclusive — see
   * {@link findMetaprojectUpward}). Defaults to `os.homedir()`. Tests inject
   * a fixture-local directory here so a stray `.metaproject` anywhere above
   * the REAL `$HOME` (or above the OS temp directory the fixture happens to
   * sit under) can never change the result — never set by a real caller.
   */
  readonly homeDir?: string;
}

/**
 * Directories `findMetaprojectUpward` must never check or cross, even when a
 * stray `.metaproject`/`.git` ends up directly inside one. The filesystem
 * root is never a project boundary, and neither is the OS temp directory: a
 * bare `mkdtemp()` fixture (this project's own tests, and any concurrent
 * process sharing the machine) routinely leaves debris there, and review
 * round 1 (L2/TEST-1) reproduced `keryx doctor`'s own new "not a keryx
 * project" test failing because of exactly that — a `.metaproject` living
 * directly in `/tmp` on the review machine.
 */
function isExcludedProjectRootCandidate(dir: string): boolean {
  return dir === path.parse(dir).root || dir === "/tmp" || dir === tmpdir();
}

/**
 * Walk upward from `cwd` looking for a `.metaproject/`, never checking or
 * crossing `ceiling`'s PARENT (i.e. `ceiling` itself is the last directory
 * checked) nor any {@link isExcludedProjectRootCandidate} directory
 * encountered along the way. Returns the directory holding `.metaproject/`,
 * or `undefined` when none was found within bounds.
 */
function findMetaprojectUpward(cwd: string, ceiling: string): string | undefined {
  let current = path.resolve(cwd);
  const resolvedCeiling = path.resolve(ceiling);
  for (;;) {
    if (isExcludedProjectRootCandidate(current)) {
      return undefined;
    }
    if (existsSync(path.join(current, ".metaproject"))) {
      return current;
    }
    if (current === resolvedCeiling) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Is there a `.metaproject/` at or above `cwd`? Deliberately narrower than
 * `resolveProjectRoot` (which also stops at a bare `.git`, no `.metaproject`
 * required, for OTHER callers that only need a repository boundary) —
 * backlog item 12 is specifically about the ABSENCE of a Metaproject
 * workspace, so a plain git repo with none still reads as "not a keryx
 * project" here.
 *
 * Review round 1 (L2/TEST-1): unlike `resolveProjectRoot`, the upward walk
 * here is BOUNDED, never delegating to that generic unceilinged walker.
 * Inside a git repository, the bound is the repo's own toplevel (`git
 * rev-parse --show-toplevel`) — the project is the nearest `.metaproject` at
 * or below it. Outside a repository, the bound is `$HOME` (its PARENT is
 * never checked), and the OS temp directory / filesystem root are never
 * considered candidates either way — an ancestor of a bare `mkdtemp()`
 * fixture (or of any unrelated directory on a shared machine) acquiring a
 * stray `.git`/`.metaproject` must never flip this to `true`.
 *
 * Also checks the MAIN checkout (same `resolveMainCheckoutRoot` as the
 * `worktrees` check, backlog item 13) when `cwd` itself has none: an agent
 * worktree under `.claude/worktrees/<name>` never carries its own
 * `.metaproject/` — that lives only in the main checkout — so without this,
 * `keryx doctor` run from inside one would misreport a real keryx project
 * as uninitialized. The main-checkout root, resolved via git's own
 * `--git-common-dir` plumbing, needs no separate bound: it can never resolve
 * to a bare temp directory in the first place.
 */
async function isKeryxProject(cwd: string, overrides: DoctorTestOverrides = {}): Promise<boolean> {
  const toplevel = await gitToplevel(cwd);
  const ceiling = toplevel ?? overrides.homeDir ?? homedir();
  if (findMetaprojectUpward(cwd, ceiling) !== undefined) {
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
 * Project-scoped checks (mcp, integrations, standard, entrypoints, worktrees,
 * graph/wiki freshness) are skipped entirely outside a keryx project (backlog
 * item 12) — {@link NOT_A_KERYX_PROJECT_CHECK} stands in for all seven.
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

  if (!(await isKeryxProject(cwd, overrides))) {
    return { checks: [...globalChecks, NOT_A_KERYX_PROJECT_CHECK] };
  }

  const projectChecks = await Promise.all([
    Promise.resolve(checkMcp(cwd)),
    checkIntegrations(cwd),
    checkStandard(cwd),
    checkEntrypoints(cwd),
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
drift, Metaproject Standard warnings, stale .claude/worktrees entries,
graph/wiki freshness, and entrypoints: the managed block, ignore rules and
Claude hooks against where agentEntrypoints says they belong. Exits 0
unless something is a "fail".`);
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
