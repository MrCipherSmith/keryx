import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { gitCmd, gitHead, readProvenance } from "../sync/provenance";

// W7 AC4 follow-up (flow 304 T8) — a real, previously-latent defect found
// while wiring up the `modified` bucket below: `gitCmd`/`gitCmdResult`
// (`../sync/provenance.ts`) both call `.trim()` on the ENTIRE stdout blob,
// not per line. `git status --porcelain=v1`'s status code for an unstaged
// content-only edit is TWO CHARACTERS WIDE, and the first is a literal space
// (" M"); when that line is the first line of the output, the whole-string
// trim silently eats that leading space — shifting every following character
// left by one, corrupting BOTH the status-letter read (`line[0]`/`line[1]`)
// and the reported path (`line.slice(3)`) for whichever file happens to sort
// first. This was invisible before this task because nothing previously
// asserted the SPECIFIC path a trigger named (only "some reason fired" —
// `line[0]` after the shift often still happened to equal the status letter
// being tested for `added`/`deleted`/`renamed`, purely by coincidence of
// which letter shifted into position 0). `gitCmd` is shared by several other
// callers and is out of this task's lane (`src/gdgraph/**`,
// `src/commands/gdgraph*.ts` only) to change; this module instead spawns
// `git status` itself and strips only the single trailing newline git always
// terminates the last line with, never the leading byte of the first one.
function gitStatusPorcelain(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", ["status", "--porcelain=v1"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        resolve(out.endsWith("\n") ? out.slice(0, -1) : out);
      });
    } catch {
      resolve(null);
    }
  });
}

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
//   - untracked/delete/rename/modify: `git status --porcelain=v1`, categorized
//                             by status letter. A plain in-place content edit
//                             (` M`/`M `) IS a trigger (W7 AC4 follow-up, flow
//                             304 T8) — but only when the file's own mtime
//                             postdates the build, so an edit already on disk
//                             when `gdgraph build` ran (already reflected in
//                             the graph) does not false-stale it.
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
// goes into its own `modified` bucket — see the module doc above and the
// caller's mtime gate.
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
// W7 AC4 ("a reason naming the changed file"): the trigger buckets carry the
// actual paths that tripped them, not just a boolean — a reader gets "which
// file", not only "some file". `nameFiles` below turns a bucket into the
// reason string, bounded the same way this codebase bounds every other
// unbounded listing (a handful named, "+N more" beyond that).
//
// W7 AC4 follow-up (flow 304 T8): a pure content edit (` M`/`M `/`MM`) is now
// its OWN bucket (`modified`) instead of being dropped — see the caller,
// which promotes it to a trigger only when the file's mtime postdates the
// build (a content edit already present at build time is already reflected
// in the graph and must not false-stale it).
function categorizeStatusLines(
  porcelain: string,
  rootPrefix: string,
): { added: string[]; deleted: string[]; renamed: string[]; modified: string[] } {
  const lines = porcelain.split("\n").filter((line) => line.length >= 2);
  const metaprojectPrefix = `${rootPrefix}.metaproject/`;
  const added: string[] = [];
  const deleted: string[] = [];
  const renamed: string[] = [];
  const modified: string[] = [];
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
    const displayPath = rawPath.replace(/^"|"$/g, "");
    if (indexStatus === "?" || worktreeStatus === "?" || indexStatus === "A") {
      added.push(displayPath);
      continue;
    }
    if (indexStatus === "D" || worktreeStatus === "D") {
      deleted.push(displayPath);
      continue;
    }
    if (indexStatus === "R" || worktreeStatus === "R") {
      renamed.push(displayPath);
      continue;
    }
    if (indexStatus === "M" || worktreeStatus === "M") {
      modified.push(displayPath);
    }
  }
  return { added, deleted, renamed, modified };
}

const REASON_FILE_DISPLAY_LIMIT = 5;

function nameFiles(message: string, files: string[]): string {
  if (files.length === 0) {
    return message;
  }
  const shown = files.slice(0, REASON_FILE_DISPLAY_LIMIT).join(", ");
  const overflow = files.length > REASON_FILE_DISPLAY_LIMIT
    ? ` (+${files.length - REASON_FILE_DISPLAY_LIMIT} more)`
    : "";
  return `${message}: ${shown}${overflow}`;
}

// W7 AC4 follow-up: when `provenance.commit !== head.commit`, name which
// file(s) actually moved between the two, the same way the working-tree
// triggers already do — a caller told "HEAD moved" without knowing which
// files still has to run a full diff itself to find out. One extra git call,
// gated behind the already-uncommon "commit moved" branch (never on the
// common clean/fresh path), so this stays within the module's own
// cheap-probe budget.
async function committedChangedFiles(
  cwd: string,
  fromCommit: string,
  toCommit: string,
  rootPrefix: string,
): Promise<string[]> {
  const diff = await gitCmd(cwd, ["diff", "--name-only", fromCommit, toCommit]);
  if (diff === null) {
    return [];
  }
  const metaprojectPrefix = `${rootPrefix}.metaproject/`;
  return diff
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(metaprojectPrefix));
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
  //
  // Flow 280 (the graph-provenance stall): this comparison is intentionally a
  // bare commit-hash check, and it stays one. The disagreement that flow
  // fixed — a `.metaproject/`-only commit left `keryx sync` saying "nothing
  // to rebuild" while THIS check said "stale" forever, because nothing ever
  // advanced the provenance commit this reads — was not a defect in this
  // comparison. `checkGraphStaleness` has no notion of "since provenance was
  // last recorded" and no per-commit diff to reason from; it only ever sees
  // the two endpoints (`provenance.commit`, `head.commit`). Rederiving "did
  // any code file change between them" here would mean re-running the same
  // diff `../sync/diff.ts` already computes, in a module whose contract is a
  // cheap, dependency-light freshness probe (staleness.test.ts, AFC-10) —
  // and would leave that diff computed twice, once here and once in sync's
  // own loop, with the two free to drift. The fix instead makes the ONE place
  // that already has the diff (`../commands/sync.ts`'s per-module loop)
  // advance provenance to HEAD when that diff is empty, so this check's
  // simple "did the commit move" question starts answering "no" again — which
  // is also why it is correct for this to stay a hard equality check: once
  // provenance is honestly advanced, an ADVANCING mismatch here really does
  // mean the graph predates HEAD, and this is exactly the check the wiki gate
  // (`../wiki/staleness.ts`) needs to keep trusting for that.
  // W7 AC4 (PART A item 3): a graph that DID record provenance and then had
  // `.provenance.json` deleted (or one that was never recorded at all) has no
  // reliable "did the commit move" signal any more — only the best-effort
  // `.git/logs/HEAD` mtime fallback below, which is silent whenever the build
  // happened to run after the last commit (the common, unremarkable case).
  // Before this fix, that silence made the whole check return `fresh` with no
  // trace that the one strong freshness signal (a recorded baseline commit)
  // was missing — exactly the "silently reads as confirmed-current" outcome
  // this module's own contract says a check must never produce. `provenanceMissing`
  // is set whenever there is nothing to compare HEAD against; if nothing else
  // below turns up a concrete reason, the result downgrades from `fresh` to
  // `unknown` (a weaker claim — "not verified", not "confirmed stale") rather
  // than staying silently fresh.
  let provenanceMissing = false;
  const head = await gitHead(cwd);
  // T19 finding 3: `--show-prefix` is the project root's path relative to the
  // git root (empty string AT the git root) — needed both here (to scope a
  // commit-range diff to real source, excluding the graph's own bookkeeping)
  // and below (the working-tree `.metaproject/` exclusion). Fetched once and
  // reused, so this stays within the module's stated "one or two git calls"
  // budget rather than asking twice.
  const rootPrefix = head !== null ? ((await gitCmd(cwd, ["rev-parse", "--show-prefix"])) ?? "") : "";
  if (head === null) {
    gitFailed = true;
    reasons.push("git rev-parse HEAD failed (not a git repository, or git is unavailable)");
  } else {
    const provenance = await readProvenance(cwd, "gdgraph");
    if (provenance) {
      if (provenance.commit !== head.commit) {
        const changedFiles = await committedChangedFiles(cwd, provenance.commit, head.commit, rootPrefix);
        reasons.push(
          nameFiles(
            `HEAD moved since the graph was built (built at ${provenance.commit.slice(0, 12)}, now ${head.commit.slice(0, 12)})`,
            changedFiles,
          ),
        );
      }
    } else {
      provenanceMissing = true;
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

  // --- untracked / deleted / renamed / modified ------------------------------
  const porcelain = await gitStatusPorcelain(cwd);
  if (porcelain === null) {
    gitFailed = true;
    reasons.push("git status failed");
  } else {
    // `rootPrefix` (fetched once, above) is the project root's path relative
    // to the git root — exactly what `git status --porcelain`'s repo-root-
    // relative paths need for the `.metaproject/` exclusion to match
    // regardless of where the project root sits (T19 finding 3).
    const { added, deleted, renamed, modified } = categorizeStatusLines(porcelain, rootPrefix);
    if (added.length > 0) {
      reasons.push(nameFiles("an untracked or newly added file exists in the working tree", added));
    }
    if (deleted.length > 0) {
      reasons.push(nameFiles("a tracked file was deleted in the working tree", deleted));
    }
    if (renamed.length > 0) {
      reasons.push(nameFiles("a file was renamed (staged) in the working tree", renamed));
    }
    // W7 AC4 follow-up (flow 304 T8): a pure content edit is a trigger too,
    // but ONLY when the file's own mtime postdates the graph's build — an
    // edit already on disk when `gdgraph build` ran is already reflected in
    // the graph; re-flagging it would false-stale every build whose source
    // tree was not pristine (i.e. nearly all of them). `nodesStat.mtimeMs` is
    // this module's existing build-time proxy (already used for the config-
    // change check below), reused here rather than introducing a second
    // "when was it built" concept.
    if (modified.length > 0) {
      const postBuildEdits: string[] = [];
      for (const displayPath of modified) {
        const projectRelative = rootPrefix && displayPath.startsWith(rootPrefix)
          ? displayPath.slice(rootPrefix.length)
          : rootPrefix
            ? null // outside this project's subtree in the repo — not ours to report
            : displayPath;
        if (projectRelative === null) {
          continue;
        }
        const fileStat = await stat(path.join(cwd, projectRelative)).catch(() => null);
        if (fileStat && fileStat.mtimeMs > nodesStat.mtimeMs) {
          postBuildEdits.push(displayPath);
        }
      }
      if (postBuildEdits.length > 0) {
        reasons.push(nameFiles("a tracked file was modified since the graph was built", postBuildEdits));
      }
    }
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
  if (reasons.length > 0) {
    return { status: "stale", reasons };
  }
  if (provenanceMissing) {
    // No concrete trigger fired, but there was also no recorded build
    // baseline to check the strongest signal (the commit) against — the
    // mtime fallback is a best-effort proxy, not confirmation. Reported as
    // `unknown`, not `fresh`: freshness genuinely was not established here,
    // it just was not disproven either.
    return {
      status: "unknown",
      reasons: [
        "no build provenance recorded (.provenance.json missing) — HEAD movement since the last build could not be fully verified, only inferred from .git/logs/HEAD mtime",
      ],
    };
  }
  return { status: "fresh", reasons: [] };
}

// Flow 237 T11 (F4): the boolean wrapper `graphMaybeStale` used to live here.
// It mapped BOTH `"stale"` and `"unknown"` to `true`, which was safe for the
// callers it had (nothing could read a git failure as "fresh") but lossy: the
// difference between "the repo moved" and "we could not tell" — the whole
// point of the tri-state, and the difference between STALE_NOTE and
// UNKNOWN_NOTE below — did not survive the call. T6 moved the last two
// production callers (`commands/gdgraph.ts`, `wiki/staleness.ts`) onto
// `checkGraphStaleness`, leaving the wrapper with no caller but its own test:
// a collapse sitting in the codebase waiting for the next caller to pick it
// up by accident. There is no boolean surface any more. Callers that only
// want a yes/no write `(await checkGraphStaleness(cwd)).status !== "fresh"`
// at the call site, where the discarded distinction is visible in the diff.
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
