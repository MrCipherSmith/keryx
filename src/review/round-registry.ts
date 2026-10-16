// Flow 458 (owner decision on B1): the machine-local registry of review rounds keryx itself finished.
//
// A delta round is cut only from a previous round this pipeline ran. A package the branch under review committed fails
// that rule — including the flow packages keryx commits on a PR branch by design. This registry tells them apart on
// the machine that ran the round: `review ingest` (of a round past its draft), `review complete` and `review publish`
// append one line per finished round, with the sha256 of the package's manifest identity, findings.json and round.json,
// to a file OUTSIDE the repository, under the
// user's keryx directory (`keryxConfigDir`, the root auth.json, projects.json and the hook trust store live in), one
// file per repository identity. A package whose current files hash to an entry is one keryx finished here, whatever
// commit carried it.
//
// The boundary is the user, not the agent (TM-04): a PR author cannot write this file on the reviewer's machine, so a
// package committed by the PR is not trusted; an agent running as the user can, exactly as it can write any other
// user-owned file. On another machine there is no entry, and trust comes only from our own login's round block on the
// pull request.
//
// No raw filesystem call here: reads and writes go through the config-dir helpers (bounded read, owner-only append),
// which `config-dir.readers.test.ts` / `config-dir.writers.test.ts` hold every resolver-using module to.

import { createHash } from "node:crypto";
import path from "node:path";
import { appendOwnerOnlyLine, ensureKeryxSubdir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { packageFacts, roundStampOf, type PackageHashes } from "./round-record";

export const ROUND_REGISTRY_DIR = "review-rounds";

/** Compact the registry file once it grows past this, keeping the newest entry per package. */
export const REGISTRY_COMPACT_BYTES = 512 * 1024;

/**
 * v2: the manifest is hashed over its identity fields (round-record.ts `MANIFEST_IDENTITY_FIELDS`), findings and the
 * round record over their JSON content. A v1 entry hashed raw bytes and is ignored: it costs one full round, never trust.
 */
export type RoundRegistryEntry = {
  v: 2;
  packageId: string;
  targetKey: string;
  reviewedHead: string | null;
  manifestSha256: string;
  findingsSha256: string | null;
  roundRecordSha256?: string | undefined;
  completedAt: string;
  /**
   * What recorded it: `review ingest` of a finished round, `review complete`, `review publish`, or the operator's premise
   * answer (`decide-premise`), which rewrites findings.json of a round the registry already vouched for.
   */
  event: "ingest" | "complete" | "publish" | "decide-premise";
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * The identity of the repository a checkout belongs to: its `origin` URL without credentials or a `.git` suffix,
 * lower-cased, so every clone and worktree of one repository on this machine shares one registry file; without an
 * origin, the absolute git common directory. Undefined outside a git checkout.
 */
export function repoIdentity(cwd: string): string | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
      const out = result.stdout.toString().trim();
      return result.exitCode === 0 && out !== "" ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const origin = run(["config", "--get", "remote.origin.url"]);
  if (origin !== undefined) return `remote:${origin.replace(/\/\/[^/@]*@/, "//").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase()}`;
  const common = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common === undefined ? undefined : `dir:${path.resolve(cwd, common)}`;
}

/** The registry file of one repository identity. */
export function roundRegistryFile(identity: string, dir?: string): string {
  return path.join(keryxConfigDir(dir), ROUND_REGISTRY_DIR, `${sha256(identity).slice(0, 32)}.jsonl`);
}

function valid(entry: unknown): entry is RoundRegistryEntry {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const hex = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  return (
    e.v === 2 &&
    typeof e.packageId === "string" &&
    typeof e.targetKey === "string" &&
    (e.reviewedHead === null || typeof e.reviewedHead === "string") &&
    hex(e.manifestSha256) &&
    (e.findingsSha256 === null || hex(e.findingsSha256)) &&
    (e.roundRecordSha256 === undefined || hex(e.roundRecordSha256)) &&
    typeof e.completedAt === "string"
  );
}

function parseEntries(text: string): RoundRegistryEntry[] {
  const out: RoundRegistryEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (valid(parsed)) out.push(parsed);
    } catch {
      // A torn line damages one record, not the registry.
    }
  }
  return out;
}

/**
 * Every well-formed entry of a repository's registry, and a warning when the file could not be read whole: one past
 * the config read cap, not a regular file, or unreadable. An absent file is no warning, just no entries.
 */
export function readRoundRegistryReport(identity: string | undefined, dir?: string): { entries: RoundRegistryEntry[]; warning?: string | undefined } {
  if (identity === undefined) return { entries: [] };
  const file = roundRegistryFile(identity, dir);
  const read = readConfigFile(file);
  if (read.ok) return { entries: parseEntries(read.text) };
  if (read.reason === "absent") return { entries: [] };
  return { entries: [], warning: `the local round registry ${file} was not read (${read.reason === "too-large" ? "over the 1 MB read cap" : read.reason}): no committed package is vouched for by it this round` };
}

/** Every well-formed entry of a repository's registry; [] when it has none, or the file cannot be read. */
export function readRoundRegistry(identity: string | undefined, dir?: string): RoundRegistryEntry[] {
  return readRoundRegistryReport(identity, dir).entries;
}

/** The newest entry per package, in recording order: what a compaction keeps. */
export function compactEntries(entries: readonly RoundRegistryEntry[]): RoundRegistryEntry[] {
  const newest = new Map<string, number>();
  entries.forEach((entry, index) => newest.set(entry.packageId, index));
  return entries.filter((entry, index) => newest.get(entry.packageId) === index);
}

/**
 * Append one entry. Past {@link REGISTRY_COMPACT_BYTES} the file is rewritten (atomically, owner-only) with the newest
 * entry per package, so it stays well under the read cap; a file already past the cap cannot be read and is started
 * again, which costs at most one full round per package, never trust it should not give.
 */
export function appendRoundRegistry(identity: string, entry: RoundRegistryEntry, dir?: string): { file: string; compacted?: number | undefined; warning?: string | undefined } {
  ensureKeryxSubdir([ROUND_REGISTRY_DIR], dir);
  const file = roundRegistryFile(identity, dir);
  appendOwnerOnlyLine(file, JSON.stringify(entry));
  const read = readConfigFile(file);
  if (read.ok && Buffer.byteLength(read.text) > REGISTRY_COMPACT_BYTES) {
    const all = parseEntries(read.text);
    const kept = compactEntries(all);
    writeOwnerOnlyFileAtomic(file, kept.map((item) => `${JSON.stringify(item)}\n`).join(""));
    return { file, compacted: all.length - kept.length };
  }
  if (!read.ok && read.reason === "too-large") {
    writeOwnerOnlyFileAtomic(file, `${JSON.stringify(entry)}\n`);
    return { file, warning: `the local round registry ${file} was past the read cap and was started again with this entry` };
  }
  return { file };
}

/**
 * The entry that vouches for a package with these files, or undefined: same package id, the same manifest identity
 * (target, head, flow, mode and start's stamps — not its lifecycle status), the same findings and, when the entry
 * recorded one, the same round.json. Changing what the round reviewed or found breaks the match; closing it does not.
 */
export function registryVouches(entries: readonly RoundRegistryEntry[], packageId: string, hashes: PackageHashes | undefined): RoundRegistryEntry | undefined {
  if (hashes === undefined) return undefined;
  return [...entries].reverse().find(
    (entry) =>
      entry.packageId === packageId &&
      entry.manifestSha256 === hashes.manifestSha256 &&
      entry.findingsSha256 === hashes.findingsSha256 &&
      (entry.roundRecordSha256 === undefined || entry.roundRecordSha256 === hashes.roundRecordSha256),
  );
}

/** The package id the registry records a package under: its manifest's `reviewId`, else its directory name. */
function packageIdOf(packageDir: string, manifest: Record<string, unknown>): string {
  return typeof manifest.reviewId === "string" ? manifest.reviewId : path.basename(packageDir);
}

/**
 * Whether the registry vouches for the package's files as they are now (review RG2-001). A writer that changes a
 * vouched package's findings.json (the operator's premise answer) asks this before the write, and re-records after it
 * only when it was vouched, so the answer keeps the round trusted without vouching for a package keryx never finished.
 */
export function registryVouchesPackage(packageDir: string, options: { cwd?: string; dir?: string } = {}): boolean {
  try {
    const facts = packageFacts(packageDir);
    if (facts === undefined) return false;
    const identity = repoIdentity(options.cwd ?? packageDir);
    if (identity === undefined) return false;
    return registryVouches(readRoundRegistry(identity, options.dir), packageIdOf(packageDir, facts.manifest), facts.hashes) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Record a round keryx just finished: `review ingest` of a round past its draft (the flow loop starts round N+1 right
 * after it), `review complete`, `review publish` — each re-records, since each may change findings. A package without
 * completion evidence is not recorded (`skipped` says why). Best-effort: a registry that cannot be written costs a later
 * delta round on this machine (it falls back to a full round), never the command's own result, so the failure is
 * returned for the caller to print rather than thrown.
 */
export function recordFinishedRound(
  packageDir: string,
  event: RoundRegistryEntry["event"],
  options: { cwd?: string; dir?: string; now?: Date } = {},
): { file?: string; error?: string; skipped?: string; warning?: string } {
  try {
    const facts = packageFacts(packageDir);
    if (facts === undefined) return { error: `${packageDir} has no readable manifest.json` };
    if (!facts.completion.eligible || !facts.completion.completed.ok) return { skipped: `not a finished round yet (${facts.completion.completed.why})` };
    const identity = repoIdentity(options.cwd ?? packageDir);
    // Outside a git checkout no commit can carry the package, so there is nothing for the registry to vouch for later.
    if (identity === undefined) return {};
    const target = facts.manifest.target !== null && typeof facts.manifest.target === "object" ? (facts.manifest.target as Record<string, unknown>) : {};
    const packageId = packageIdOf(packageDir, facts.manifest);
    const head = typeof target.head === "string" ? target.head : null;
    const entry: RoundRegistryEntry = {
      v: 2,
      packageId,
      targetKey: roundStampOf(facts.manifest)?.targetKey ?? `${String(target.kind ?? "unknown")}:${String(target.ref ?? "")}`,
      reviewedHead: head,
      manifestSha256: facts.hashes.manifestSha256,
      findingsSha256: facts.hashes.findingsSha256,
      ...(facts.hashes.roundRecordSha256 === null ? {} : { roundRecordSha256: facts.hashes.roundRecordSha256 }),
      completedAt: (options.now ?? new Date()).toISOString(),
      event,
    };
    const written = appendRoundRegistry(identity, entry, options.dir);
    return { file: written.file, ...(written.warning === undefined ? {} : { warning: written.warning }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
