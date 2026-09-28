import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readContainedFile } from "../lib/contained-read";

export type SecurityScanFileStatus = "scanned" | "skipped" | "failed";

export type SecurityScanFile = {
  path: string;
  status: SecurityScanFileStatus;
  reason?: string;
};

export type SecurityScanCoverage = {
  status: "complete" | "incomplete";
  required: boolean;
  reasons: string[];
  /**
   * Paths the repository's own ignore rules excluded (G-2, flow 356) —
   * generated/local-only content under `.gitignore` (and the hardcoded
   * `.claude/worktrees`, which nothing gitignores today) that this scan
   * deliberately never opened. A directory is listed once, without every
   * file inside it. Absent (never an empty array) when
   * `respectIgnoreRules` is `false` or nothing was excluded — the same
   * "presence is the claim" discipline `reasons` already follows.
   */
  skipped?: string[];
};

export type SecurityScanLimits = {
  maxFiles: number;
  maxBytes: number;
  maxDirectories: number;
  maxDepth: number;
};

export type SecurityScanScope = {
  path: string;
  recursive: boolean;
  exclusions: string[];
  limits: SecurityScanLimits;
};

export type SecurityScanContent = {
  path: string;
  content: string;
};

export type SecurityScanTraversal = {
  scope: SecurityScanScope;
  coverage: SecurityScanCoverage;
  files: SecurityScanFile[];
  contents: SecurityScanContent[];
};

export type SecurityScanOptions = {
  ownerRoot: string;
  targetPath: string;
  exclusions?: string[];
  recursive?: boolean;
  limits?: Partial<SecurityScanLimits>;
  /**
   * Skip paths the repository's own ignore rules exclude (G-2, flow 356).
   * Default `true`. `keryx security scan --no-ignore` sets this `false` to
   * restore the old behaviour (every readable file under `targetPath`
   * counts against the limits, ignore rules or not).
   */
  respectIgnoreRules?: boolean;
};

/**
 * G-2 (flow 356): raised from `{maxFiles: 1_000, maxBytes: 8 MiB}`.
 *
 * The ignore-rule skip above (`respectIgnoreRules`) fixes the BYTE problem
 * the finding measured (generated `.metaproject/data/**\/storage/` content
 * eating the budget before the operator's own source was reached) — it does
 * not fix the FILE-COUNT/total-SIZE one, which is a separate, real fact
 * about this repository's own size. Measured directly (2026-09-28, flow
 * 356) by walking the tree with THIS module's own `respectIgnoreRules`
 * logic applied — not a `git ls-files` proxy, which under-counts: a file
 * already committed before a later `.gitignore` rule covered it stays
 * TRACKED, and `git`'s ignore machinery only ever applies to untracked
 * paths, so `git ls-files --cached --others --exclude-standard` silently
 * keeps counting it while THIS scanner (correctly) does not skip it either,
 * since it is not `git`-ignored from git's own point of view — the true
 * post-skip total is 9 556 files, 92.4 MiB, none of it generated (bundled
 * `gdskills` stack packs, `.metaproject/` wiki/flows/review history,
 * `docs/`, `bench/` fixtures — all legitimately versioned project content).
 * `specification.md`'s "defaults unchanged" note predates that measurement;
 * AC4's actual bar (`coverage.status: "complete"` on `keryx security scan
 * .`) cannot be met at the old ceiling without excluding legitimately-
 * tracked project content no ignore rule excludes — which would be a worse
 * fix than raising a SAFETY bound that was simply too low for a project
 * this size. Comfortable headroom over the measured size, not an unbounded
 * scan: a genuinely huge or adversarial target still stops here rather than
 * running away.
 */
export const DEFAULT_SECURITY_SCAN_LIMITS: SecurityScanLimits = {
  maxFiles: 20_000,
  maxBytes: 128 * 1024 * 1024,
  maxDirectories: 4_096,
  maxDepth: 64,
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function identityFor(value: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(value.dev)}:${String(value.ino)}`;
}

function relativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative === "" ? "." : relative;
}

function safeReason(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "CONTAINED_READ_TOO_LARGE") return "byte limit exceeded";
    if (code === "CONTAINED_READ_NOT_REGULAR") return "not a regular file";
    if (code === "CONTAINED_READ_UNAVAILABLE") return "secure file reader unavailable";
    if (code === "CONTAINED_READ_RACE") return "path changed during secure read";
  }
  return "unreadable or denied entry";
}

/**
 * A directory this scan always skips, regardless of `.gitignore` (G-2,
 * flow 356): agent worktrees under `.claude/worktrees` — nothing gitignores
 * this path today (confirmed against this repository's own `.gitignore`),
 * and a stale worktree tree can carry many megabytes that have nothing to do
 * with THIS project's own content, eating the scan's byte/file budget for
 * no reason a policy scan cares about.
 *
 * `.git` itself joins for a related but different reason: it is not a
 * gitignore CONCEPT at all — `git ls-files` never reports anything under it,
 * ignored or otherwise, because git does not treat it as part of the working
 * tree it tracks — so `repositoryIgnoredPaths` below could never learn about
 * it from `git` no matter how it is invoked. Its own internal storage (packed
 * objects, sample hooks) is exactly the kind of content this policy scan has
 * no opinion about and easily exhausts a byte budget on — measured directly:
 * a fresh `git init`'s `.git/hooks/*.sample` alone is several kilobytes,
 * enough on its own to report `incomplete` on a small `--max-bytes`.
 *
 * `node_modules` joins for the same shape of reason as `.git`: this
 * repository does not gitignore it (nothing checks a `node_modules` into
 * this tree normally, so no rule anticipates one), yet a local dev setup can
 * point it at a symlink OUTSIDE the project root (this repository's own
 * worktrees do) — which, unlisted here, would resolve and report
 * `incomplete("external target refused")` for third-party dependency code
 * this scan was never scoped to read in the first place, not a real gap in
 * ITS OWN coverage.
 */
const ALWAYS_IGNORED_RELATIVE_DIRS = [".claude/worktrees", ".git", "node_modules"];

/**
 * The repository's own ignored paths, relative to `ownerRoot`, POSIX-style
 * (`git`'s own output shape) — files and directories `.gitignore` (plus
 * `core.excludesFile`, `.git/info/exclude` — everything `--exclude-standard`
 * covers) excludes, PLUS {@link ALWAYS_IGNORED_RELATIVE_DIRS}.
 *
 * `--directory` is what makes this cheap and correct together: an ignored
 * DIRECTORY is reported as one entry with a trailing `/`, without `git`
 * descending into it — so `.metaproject/data/gdgraph/storage/` (this
 * repository's own build artifacts, gitignored) comes back as one line, not
 * thousands, and the traversal below can skip the whole subtree the moment
 * it reaches that directory rather than opening every file inside it first.
 *
 * Best-effort: no git, no repository, or a `git` error all yield an empty
 * set — a project with no git (or none of it ignored) scans exactly as
 * before, never as a fatal error over a policy scan.
 */
async function repositoryIgnoredPaths(ownerRoot: string): Promise<Set<string>> {
  const ignored = new Set<string>(ALWAYS_IGNORED_RELATIVE_DIRS.map((dir) => `${dir}/`));
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "."],
      { cwd: ownerRoot, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) {
      for (const entry of out.split("\0")) {
        if (entry.length > 0) ignored.add(entry);
      }
    }
  } catch {
    // Not a git repository, git unavailable, or a transient spawn failure —
    // the hardcoded worktree entry above still applies; everything else
    // scans exactly as it did before this flag existed.
  }
  return ignored;
}

/**
 * Is `relative` (POSIX-style, no leading `./`) itself an ignored entry, or
 * inside one? `git`'s own `--directory` output disambiguates: an entry
 * ending in `/` is a directory (matched as itself OR as a prefix, so a file
 * inside it matches without needing its own entry); anything else is a bare
 * file, matched exactly. Checkable from the path alone — no `stat()` needed
 * first, so an ignored entry never pays for one.
 */
function isIgnoredPath(ignored: ReadonlySet<string>, relative: string): boolean {
  if (ignored.has(relative)) {
    return true;
  }
  for (const entry of ignored) {
    if (entry.endsWith("/") && (relative === entry.slice(0, -1) || relative.startsWith(entry))) {
      return true;
    }
  }
  return false;
}

function limitsFrom(input: SecurityScanOptions): SecurityScanLimits {
  const values = {
    ...DEFAULT_SECURITY_SCAN_LIMITS,
    ...(input.limits ?? {}),
  };
  for (const value of Object.values(values)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("security scan limits must be positive safe integers");
    }
  }
  return values;
}

/** Traverse one contained file or directory without exposing outside targets. */
export async function scanContainedPath(input: SecurityScanOptions): Promise<SecurityScanTraversal> {
  const limits = limitsFrom(input);
  const ownerRoot = await realpath(input.ownerRoot);
  const targetReal = await realpath(input.targetPath);
  if (!isInside(ownerRoot, targetReal)) {
    throw new Error("security scan target is outside the project root");
  }

  const exclusions = (input.exclusions ?? []).map((entry) => {
    const absolute = path.resolve(ownerRoot, entry);
    return isInside(ownerRoot, absolute) ? absolute : null;
  }).filter((entry): entry is string => entry !== null);
  const scope: SecurityScanScope = {
    path: relativePath(ownerRoot, targetReal),
    recursive: input.recursive ?? true,
    exclusions: (input.exclusions ?? []).map((entry) => {
      const absolute = path.resolve(ownerRoot, entry);
      return isInside(ownerRoot, absolute) ? relativePath(ownerRoot, absolute) : "[external exclusion omitted]";
    }),
    limits,
  };
  const files: SecurityScanFile[] = [];
  const contents: SecurityScanContent[] = [];
  const coverage: SecurityScanCoverage = { status: "complete", required: true, reasons: [] };
  const visited = new Set<string>();
  let scannedFiles = 0;
  let scannedDirectories = 0;
  let bytes = 0;
  let stoppedByLimit = false;

  // G-2 (flow 356): computed ONCE, before traversal — one `git` call rather
  // than one per candidate. `respectIgnoreRules` default `true`;
  // `keryx security scan --no-ignore` (`commands/security.ts`) sets it
  // `false` to restore the pre-existing behaviour untouched.
  const respectIgnoreRules = input.respectIgnoreRules ?? true;
  const ignoredPaths = respectIgnoreRules ? await repositoryIgnoredPaths(ownerRoot) : new Set<string>();
  const skippedByIgnore: string[] = [];

  const incomplete = (reason: string): void => {
    coverage.status = "incomplete";
    if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
  };

  const excluded = (candidate: string): boolean =>
    exclusions.some((entry) => candidate === entry || candidate.startsWith(`${entry}${path.sep}`));

  const visit = async (candidate: string, depth: number): Promise<void> => {
    if (stoppedByLimit) return;
    const displayPath = relativePath(ownerRoot, candidate);

    if (respectIgnoreRules) {
      const normalized = displayPath.split(path.sep).join("/");
      if (isIgnoredPath(ignoredPaths, normalized)) {
        // Never `incomplete()`: a path the repository itself says to ignore
        // is not evidence THIS scan is incomplete — it is evidence the scan
        // correctly declined to open something outside its policy scope.
        // Checked BEFORE `realpath()`/`stat()`, deliberately: it means the
        // traversal never descends into an ignored DIRECTORY at all (what
        // keeps a large ignored subtree from eating the byte/file budget),
        // and never resolves an ignored SYMLINK either — `node_modules`
        // joins {@link ALWAYS_IGNORED_RELATIVE_DIRS} for exactly this
        // reason: it is a symlink pointing OUTSIDE `ownerRoot` on this
        // machine, and resolving it first would have reported "external
        // target refused" (a real `incomplete()`) before this check ever
        // ran, for content this scan was never going to open anyway.
        files.push({ path: displayPath, status: "skipped", reason: "excluded by ignore rules" });
        if (!skippedByIgnore.includes(displayPath)) {
          skippedByIgnore.push(displayPath);
        }
        return;
      }
    }

    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      files.push({ path: displayPath, status: "failed", reason: "unreadable or denied entry" });
      incomplete("unreadable or denied entry");
      return;
    }
    if (!isInside(ownerRoot, canonical)) {
      files.push({ path: displayPath, status: "skipped", reason: "external target refused" });
      incomplete("external target refused");
      return;
    }
    if (excluded(canonical) || excluded(candidate)) {
      files.push({ path: displayPath, status: "skipped", reason: "excluded by scan scope" });
      return;
    }

    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(canonical);
    } catch {
      files.push({ path: displayPath, status: "failed", reason: "unreadable or denied entry" });
      incomplete("unreadable or denied entry");
      return;
    }
    const identity = identityFor(metadata);
    if (visited.has(identity)) {
      // Report the row under the entry that produced THIS encounter, not the
      // canonical target it resolves to. The visited Set below still keys on
      // canonical identity so a cycle or a duplicate name is scanned once;
      // only the report row's name changes.
      files.push({ path: displayPath, status: "skipped", reason: "canonical identity already visited" });
      return;
    }
    visited.add(identity);

    if (metadata.isDirectory()) {
      if (scannedDirectories >= limits.maxDirectories) {
        files.push({ path: displayPath, status: "failed", reason: "directory limit exceeded" });
        incomplete("directory limit exceeded");
        stoppedByLimit = true;
        return;
      }
      if (depth >= limits.maxDepth) {
        files.push({ path: displayPath, status: "failed", reason: "depth limit exceeded" });
        incomplete("depth limit exceeded");
        return;
      }
      scannedDirectories += 1;
      let entries: string[];
      try {
        entries = (await readdir(canonical)).sort();
      } catch {
        files.push({ path: displayPath, status: "failed", reason: "directory unreadable" });
        incomplete("directory unreadable");
        return;
      }
      if (!scope.recursive) {
        // A directory whose children were never opened must never report as
        // fully covered: mark coverage incomplete alongside the skip row so a
        // check that did not run cannot read as a clean pass (F-003).
        files.push({ path: displayPath, status: "skipped", reason: "recursive traversal disabled" });
        incomplete("recursive traversal disabled");
        return;
      }
      for (const entry of entries) {
        await visit(path.join(canonical, entry), depth + 1);
        if (stoppedByLimit) break;
      }
      return;
    }

    if (!metadata.isFile()) {
      files.push({ path: displayPath, status: "skipped", reason: "not a regular file" });
      incomplete("non-regular entry refused");
      return;
    }
    if (scannedFiles >= limits.maxFiles) {
      files.push({ path: displayPath, status: "skipped", reason: "file limit exceeded" });
      incomplete("file limit exceeded");
      stoppedByLimit = true;
      return;
    }
    if (bytes >= limits.maxBytes) {
      files.push({ path: displayPath, status: "skipped", reason: "byte limit exceeded" });
      incomplete("byte limit exceeded");
      stoppedByLimit = true;
      return;
    }
    try {
      const buffer = await readContainedFile(ownerRoot, canonical, {
        maxBytes: limits.maxBytes - bytes,
        requireRegularFile: true,
      });
      bytes += buffer.byteLength;
      scannedFiles += 1;
      // Report and correlate on the entry actually encountered (displayPath),
      // not its canonical target (F-004). runScanPath (service.ts) matches
      // `files` and `contents` rows by `path`, so both must carry the same
      // value.
      files.push({ path: displayPath, status: "scanned" });
      contents.push({ path: displayPath, content: buffer.toString("utf8") });
    } catch (error) {
      files.push({ path: displayPath, status: "failed", reason: safeReason(error) });
      incomplete(safeReason(error));
    }
  };

  await visit(targetReal, 0);
  if (skippedByIgnore.length > 0) {
    coverage.skipped = skippedByIgnore.sort();
  }
  return { scope, coverage, files, contents };
}
