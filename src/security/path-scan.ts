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
};

export const DEFAULT_SECURITY_SCAN_LIMITS: SecurityScanLimits = {
  maxFiles: 1_000,
  maxBytes: 8 * 1024 * 1024,
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

  const incomplete = (reason: string): void => {
    coverage.status = "incomplete";
    if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
  };

  const excluded = (candidate: string): boolean =>
    exclusions.some((entry) => candidate === entry || candidate.startsWith(`${entry}${path.sep}`));

  const visit = async (candidate: string, depth: number): Promise<void> => {
    if (stoppedByLimit) return;
    const displayPath = relativePath(ownerRoot, candidate);
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
  return { scope, coverage, files, contents };
}
