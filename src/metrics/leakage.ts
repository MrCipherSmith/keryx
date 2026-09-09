// Real gold-artifact leakage check (specification.md §7, AC-5: "A dogfood case whose
// gold artifact is reachable by the agent fails its leakage assertion and is excluded
// from scoring"). This module is the deterministic check that decision rests on — never
// a guess, never "probably fine": it looks at the real filesystem state of the exact
// root an agent's tools are confined to and reports whether the gold artifact is
// actually there.
//
// Real finding this closes (docs/requirements/keryx-benchmark-suite/plan.md): the M1
// ablation runner's worktrees are a full `git worktree add --detach <path> HEAD`
// checkout (src/harness/child/git-worktree-port.ts) — which includes
// scripts/benchmark/ablation-tasks.ts and mutating-tasks.ts THEMSELVES, containing the
// exact expectedFile/expectedSymbol answer key (and, for mutating tasks, the seeded
// test that IS the solution spec). An agent with `read_file` could read its own answer
// key directly. This was never checked before AC-5; the fix is two-part: strip these
// gold-bearing files from every worktree before the agent ever sees it (the producer
// scripts do this), AND this module is the check that PROVES a given worktree is clean
// before a case is trusted, or catches it when it is not.

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import type { LeakageAssertion } from "./benchmark";

export type LeakageCheckResult = {
  readonly assertion: LeakageAssertion;
  /** Repo-relative gold-artifact paths that were actually found reachable, if any. */
  readonly reachablePaths: readonly string[];
};

/**
 * Check whether any of `goldArtifactPaths` (repo-relative) exist under `agentRoot` —
 * the exact directory an agent's file-reading tools are confined to for this case.
 * `"failed"` when ANY gold artifact is reachable (AC-5's unsafe state); `"passed"` only
 * when the check genuinely looked and found none reachable.
 *
 * RESOLVED 2026-09-09, flow 238/T15: an empty `goldArtifactPaths` list, or an `agentRoot`
 * that does not exist, used to also report `"passed"` — the same "absence of a check
 * rendered as a clean result" bug this repository has already found and fixed three times
 * elsewhere (see the module comment above, and this function's sibling
 * `checkAnswerReachability` below, which has always correctly returned `"unverified"` in
 * both of these cases). `LeakageAssertion` (./benchmark.ts) has no `"unverified"` member —
 * only `"passed" | "failed" | "not-applicable"` — so `"not-applicable"` is the honest value
 * here: "this check had nothing to verify," never "this check ran and found it clean."
 * Every real caller in this codebase always passes a concrete, existing worktree root and a
 * non-empty gold-path list, so this changes no production behavior — it only closes the
 * loophole a caller could otherwise read as a clean bill of health for a check that never
 * actually ran.
 */
export function checkGoldLeakage(agentRoot: string, goldArtifactPaths: readonly string[]): LeakageCheckResult {
  if (goldArtifactPaths.length === 0) {
    return { assertion: "not-applicable", reachablePaths: [] };
  }
  if (!existsSync(agentRoot)) {
    return { assertion: "not-applicable", reachablePaths: [] };
  }
  const reachablePaths = goldArtifactPaths.filter((relPath) => existsSync(path.join(agentRoot, relPath)));
  return { assertion: reachablePaths.length > 0 ? "failed" : "passed", reachablePaths };
}

// ---------------------------------------------------------------------------
// Reachable answers (AC7 / AC-M07)
// ---------------------------------------------------------------------------
//
// `checkGoldLeakage` above answers "is the gold *file* still here?". AC7 asks a
// strictly larger question, and the difference is the whole point of the clause:
// a benchmark whose answer is already present in what the system under test can
// see is not a measurement, and it must be refused before it runs rather than
// discounted afterwards. The answer does not have to arrive in a file named
// `gold`. It can be a leftover note in `src/`, a wiki page written after the fix
// and never rolled back, or a comment naming the symbol the task asks the agent
// to find. So this scans content, not just paths.
//
// Every ambiguous outcome resolves to `unverified`, which the preflight treats as
// a block. That is deliberate and it is the lesson from the three import guards
// in this repository that passed while scanning an empty directory: a check that
// looked at nothing has not cleared anything. Concretely, `unverified` covers a
// missing root, a spec with no needles and no gold paths, a walk that matched
// zero files, a walk truncated by its own cap, and any file that could not be
// read. Only a scan that genuinely examined files and found nothing is `clean`.

export type ReachableAnswer = {
  readonly kind: "path" | "content" | "wiki";
  /** Repo-relative location, so evidence is quotable without leaking absolute paths. */
  readonly where: string;
  readonly needle: string | null;
};

export type AnswerReachabilityStatus = "clean" | "reachable" | "unverified";

export type AnswerReachabilityReport = {
  readonly status: AnswerReachabilityStatus;
  readonly reachable: readonly ReachableAnswer[];
  readonly scannedFiles: number;
  readonly problems: readonly string[];
};

export type AnswerSpec = {
  /** Files whose mere presence is the answer key. */
  readonly goldArtifactPaths?: readonly string[];
  /** Literal strings that appear only in the answer (a symbol name, a patch marker). */
  readonly answerNeedles?: readonly string[];
  /** Repo-relative wiki roots, so a wiki hit is attributed as such. */
  readonly wikiDirs?: readonly string[];
};

export type ReachabilityScanOptions = {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly extensions?: readonly string[];
  readonly skipDirs?: readonly string[];
};

const DEFAULT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml"];
const DEFAULT_SKIP_DIRS: readonly string[] = ["node_modules", ".git", "dist", "build", "coverage", ".worktrees"];
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 2_000_000;

export function checkAnswerReachability(
  agentRoot: string,
  spec: AnswerSpec,
  options: ReachabilityScanOptions = {},
): AnswerReachabilityReport {
  const needles = (spec.answerNeedles ?? []).filter((needle) => needle.trim().length > 0);
  const goldPaths = spec.goldArtifactPaths ?? [];
  const problems: string[] = [];

  if (goldPaths.length === 0 && needles.length === 0) {
    return {
      status: "unverified",
      reachable: [],
      scannedFiles: 0,
      problems: ["answer spec carries neither gold artifact paths nor answer needles: nothing to look for"],
    };
  }
  if (!existsSync(agentRoot)) {
    return { status: "unverified", reachable: [], scannedFiles: 0, problems: [`agent root does not exist: ${agentRoot}`] };
  }

  const reachable: ReachableAnswer[] = [];
  for (const relPath of goldPaths) {
    if (existsSync(path.join(agentRoot, relPath))) {
      reachable.push({ kind: "path", where: relPath, needle: null });
    }
  }

  let scannedFiles = 0;
  if (needles.length > 0) {
    const scan = scanForNeedles(agentRoot, needles, spec.wikiDirs ?? [], options);
    scannedFiles = scan.scannedFiles;
    reachable.push(...scan.hits);
    problems.push(...scan.problems);
    if (scan.scannedFiles === 0) {
      problems.push(`scan matched no readable files under ${agentRoot}: the answer was never actually looked for`);
    }
  }

  if (reachable.length > 0) return { status: "reachable", reachable, scannedFiles, problems };
  if (problems.length > 0) return { status: "unverified", reachable: [], scannedFiles, problems };
  return { status: "clean", reachable: [], scannedFiles, problems: [] };
}

type NeedleScan = {
  readonly hits: readonly ReachableAnswer[];
  readonly scannedFiles: number;
  readonly problems: readonly string[];
};

function scanForNeedles(
  agentRoot: string,
  needles: readonly string[],
  wikiDirs: readonly string[],
  options: ReachabilityScanOptions,
): NeedleScan {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);

  const hits: ReachableAnswer[] = [];
  const problems: string[] = [];
  let scannedFiles = 0;
  const queue: string[] = [agentRoot];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      problems.push(`directory unreadable: ${path.relative(agentRoot, dir) || "."} (${describeError(error)})`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(agentRoot, full);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.has(path.extname(entry.name))) continue;

      if (scannedFiles >= maxFiles) {
        problems.push(`scan truncated at ${maxFiles} files before reaching ${rel}`);
        return { hits, scannedFiles, problems };
      }

      let size: number;
      try {
        size = statSync(full).size;
      } catch (error) {
        problems.push(`file unreadable: ${rel} (${describeError(error)})`);
        continue;
      }
      if (size > maxFileBytes) {
        problems.push(`file too large to scan: ${rel} (${size} bytes)`);
        continue;
      }

      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch (error) {
        problems.push(`file unreadable: ${rel} (${describeError(error)})`);
        continue;
      }
      scannedFiles += 1;

      const isWiki = wikiDirs.some((wikiDir) => rel === wikiDir || rel.startsWith(`${wikiDir}${path.sep}`));
      for (const needle of needles) {
        if (content.includes(needle)) hits.push({ kind: isWiki ? "wiki" : "content", where: rel, needle });
      }
    }
  }

  return { hits, scannedFiles, problems };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
