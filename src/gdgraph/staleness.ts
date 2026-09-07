import { stat } from "node:fs/promises";
import path from "node:path";
import { gitCmd, gitHead, readProvenance } from "../sync/provenance";

// AFC-10 (flow 234, phase 2, frozen AC3): "a new commit, untracked, delete,
// rename and config change invalidate the snapshot; an unknown target differs
// from indexed/no-edges; a git error never becomes fresh."
//
// The PREVIOUS implementation of this module compared `.git/HEAD`'s mtime to
// the built graph's `nodes.jsonl` mtime. That is broken for every trigger AC3
// names: `.git/HEAD` is a symbolic ref ("ref: refs/heads/<branch>") whose
// CONTENT does not change on an ordinary commit to the current branch (only
// the ref file it points at does), so its mtime frequently does not advance
// either — measured directly against a real fixture in `staleness.test.ts`,
// a fresh commit left the old check reporting "not stale". It also never
// looked at working-tree status at all, so an untracked file, a deleted
// file, or a rename (which leaves file COUNT and CONTENT unchanged — the
// subtle case) were invisible to it. And on any error it returned `false`
// ("not stale"), i.e. a git failure silently read as fresh.
//
// This version checks each trigger against real signals:
//   - new commit:            recorded build provenance's commit vs current
//                             `git rev-parse HEAD` (falls back to
//                             `.git/logs/HEAD`'s mtime — which DOES advance
//                             on every commit/checkout/branch-switch, unlike
//                             `.git/HEAD`'s own — when no provenance was
//                             recorded for this build).
//   - untracked/delete/rename: `git status --porcelain=v1`, categorized by
//                             status letter. A plain in-place content edit
//                             (` M`/`M `) is deliberately NOT a trigger here —
//                             the module contract (`modules/gdgraph.md`,
//                             "Freshness & Refresh") only promises the
//                             file-level graph goes stale when the file SET
//                             moves; an edit with an unchanged import set
//                             leaves the file-level graph correct.
//   - config change:          `.metaproject/gdgraph.config.json`'s mtime vs
//                             `nodes.jsonl`'s. No separate baseline write is
//                             needed for this: the config file only *has* a
//                             newer mtime than the graph when someone touched
//                             it after the build ran.
//   - git failure:            ANY git invocation here failing (spawn error,
//                             non-zero exit, e.g. not a git repo) short-
//                             circuits the result to `status: "unknown"` —
//                             it is never allowed to fall through to "fresh".
export type StalenessStatus = "fresh" | "stale" | "unknown";

export interface StalenessCheck {
  status: StalenessStatus;
  // Human-readable reasons, one per trigger/failure that fired. Empty only
  // when `status === "fresh"`.
  reasons: string[];
}

function nodesJsonlPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
}

function gdgraphConfigPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "gdgraph.config.json");
}

// Categorize `git status --porcelain=v1` lines. Each line is exactly two
// status characters (index status, worktree status) followed by a space and
// the path (renames add " -> newPath"). A pure content modify (` M`/`M `/`MM`)
// intentionally does not set any of these three — see the module doc above.
//
// Lines under `.metaproject/` are skipped entirely: that tree holds gdgraph's
// OWN generated bookkeeping (`.provenance.json`, `artifacts/*`), which the
// module contract says is expected to sit modified/untracked in the working
// tree right after every build ("a rebuild leaves those files modified after
// the commit") — that is normal build residue, not evidence the SOURCE tree
// moved, and treating it as a trigger would make every build immediately
// report itself as stale. The config file is checked separately, by mtime.
//
// T19 finding 3 (flow 234 review): `git status --porcelain` paths are always
// relative to the REPOSITORY ROOT, not to the directory git was invoked in
// (`cwd` here, which is the *project* root and may sit below the git root in
// a monorepo). A bare ".metaproject/" prefix only ever matches when the
// project root IS the git root; `rootPrefix` (from `git rev-parse
// --show-prefix`, empty at the git root) is prepended so the same exclusion
// matches at both.
function categorizeStatusLines(
  porcelain: string,
  rootPrefix: string,
): { added: boolean; deleted: boolean; renamed: boolean } {
  const lines = porcelain.split("\n").filter((line) => line.length >= 2);
  const metaprojectPrefix = `${rootPrefix}.metaproject/`;
  let added = false;
  let deleted = false;
  let renamed = false;
  for (const line of lines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const rawPath = line.slice(3);
    // For a rename, porcelain prints "old -> new"; check the side(s) that
    // matter for the metaproject exclusion (either is enough to skip a pure
    // internal-bookkeeping rename, which does not occur in practice anyway).
    const isMetaprojectPath = rawPath
      .split(" -> ")
      .some((candidate) => candidate.replace(/^"|"$/g, "").startsWith(metaprojectPrefix));
    if (isMetaprojectPath) {
      continue;
    }
    if (indexStatus === "?" || worktreeStatus === "?" || indexStatus === "A") {
      added = true;
    }
    if (indexStatus === "D" || worktreeStatus === "D") {
      deleted = true;
    }
    if (indexStatus === "R" || worktreeStatus === "R") {
      renamed = true;
    }
  }
  return { added, deleted, renamed };
}

/**
 * The structured staleness check (AFC-10). Never throws — a git failure is
 * reported as `status: "unknown"` with a reason, not thrown and not "fresh".
 */
export async function checkGraphStaleness(cwd: string): Promise<StalenessCheck> {
  const nodesStat = await stat(nodesJsonlPath(cwd)).catch(() => null);
  if (!nodesStat) {
    return { status: "stale", reasons: ["graph has not been built yet (no nodes.jsonl)"] };
  }

  const reasons: string[] = [];
  let gitFailed = false;

  // --- new commit -----------------------------------------------------------
  const head = await gitHead(cwd);
  if (head === null) {
    gitFailed = true;
    reasons.push("git rev-parse HEAD failed (not a git repository, or git is unavailable)");
  } else {
    const provenance = await readProvenance(cwd, "gdgraph");
    if (provenance) {
      if (provenance.commit !== head.commit) {
        reasons.push(
          `HEAD moved since the graph was built (built at ${provenance.commit.slice(0, 12)}, now ${head.commit.slice(0, 12)})`,
        );
      }
    } else {
      // No recorded build provenance for this graph. Fall back to the
      // reflog's mtime: unlike `.git/HEAD` (a symbolic ref whose content is
      // usually just "ref: refs/heads/<branch>" and does not change on an
      // ordinary commit), `.git/logs/HEAD` gets a new entry — and therefore a
      // fresh mtime — on every commit, checkout, and branch switch.
      const logsHeadStat = await stat(path.join(cwd, ".git", "logs", "HEAD")).catch(() => null);
      if (logsHeadStat && logsHeadStat.mtimeMs > nodesStat.mtimeMs) {
        reasons.push(
          "repo HEAD moved since the graph was built (no build provenance recorded; inferred from .git/logs/HEAD)",
        );
      }
    }
  }

  // --- untracked / deleted / renamed ----------------------------------------
  const porcelain = await gitCmd(cwd, ["status", "--porcelain=v1"]);
  if (porcelain === null) {
    gitFailed = true;
    reasons.push("git status failed");
  } else {
    // T19 finding 3: `--show-prefix` is the project root's path relative to
    // the git root (empty string AT the git root, "packages/proj/" style
    // below it) — exactly the prefix `git status --porcelain`'s repo-root-
    // relative paths need for the `.metaproject/` exclusion to match
    // regardless of where the project root sits. A failed/non-git lookup
    // (already caught above by the HEAD/status checks) falls back to "",
    // preserving today's at-the-root behavior rather than under-excluding.
    const rootPrefix = (await gitCmd(cwd, ["rev-parse", "--show-prefix"])) ?? "";
    const { added, deleted, renamed } = categorizeStatusLines(porcelain, rootPrefix);
    if (added) reasons.push("an untracked or newly added file exists in the working tree");
    if (deleted) reasons.push("a tracked file was deleted in the working tree");
    if (renamed) reasons.push("a file was renamed (staged) in the working tree");
  }

  // --- config changed ---------------------------------------------------------
  const configStat = await stat(gdgraphConfigPath(cwd)).catch(() => null);
  if (configStat && configStat.mtimeMs > nodesStat.mtimeMs) {
    reasons.push("gdgraph.config.json changed since the graph was built");
  }

  if (gitFailed) {
    // A git failure is reported as its own status — never silently
    // downgraded to "fresh", and never conflated with a confirmed "stale"
    // either, since we could not fully verify either way.
    return { status: "unknown", reasons };
  }
  return reasons.length > 0 ? { status: "stale", reasons } : { status: "fresh", reasons: [] };
}

// Back-compat boolean surface for existing callers (`commands/gdgraph.ts`,
// `wiki/staleness.ts`): "not demonstrably fresh" -> true. `"stale"` and
// `"unknown"` both map to `true` so a git failure can never read as `false`
// ("fresh") the way the old mtime-diff implementation did.
export async function graphMaybeStale(cwd: string): Promise<boolean> {
  const result = await checkGraphStaleness(cwd);
  return result.status !== "fresh";
}

export const STALE_NOTE = "note: repo moved since the last graph build — `keryx gdgraph build` to refresh.";

// Flow 237 T6 (AFC-28/AC-28, "a check that could not run is unknown rather
// than passed"): a git failure means staleness genuinely could not be
// determined — it is not evidence the repo moved. Printing `STALE_NOTE`
// ("repo moved...") for this case asserted something the check never
// established. Every live caller must print THIS note (with the tri-state's
// own reasons) for `status: "unknown"`, and reserve `STALE_NOTE` for a
// confirmed `status: "stale"`.
export const UNKNOWN_NOTE =
  "note: could not determine whether the graph is stale (see reasons below) — run `keryx gdgraph build` if unsure.";
