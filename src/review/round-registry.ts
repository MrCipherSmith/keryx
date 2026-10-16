// Flow 458 (owner decision on B1): the machine-local registry of review rounds keryx itself finished.
//
// A delta round is cut only from a previous round this pipeline ran. A package the branch under review committed fails
// that rule — including the flow packages keryx commits on a PR branch by design. This registry tells them apart on
// the machine that ran the round: `review complete` and `review publish` append one line per finished round, with the
// sha256 of the package's manifest.json, findings.json and round.json, to a file OUTSIDE the repository, under the
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
import { appendOwnerOnlyLine, ensureKeryxSubdir, keryxConfigDir, readConfigFile } from "../lib/config-dir";
import { packageFacts, roundStampOf, type PackageHashes } from "./round-record";

export const ROUND_REGISTRY_DIR = "review-rounds";

export type RoundRegistryEntry = {
  v: 1;
  packageId: string;
  targetKey: string;
  reviewedHead: string | null;
  manifestSha256: string;
  findingsSha256: string | null;
  roundRecordSha256?: string | undefined;
  completedAt: string;
  /** What recorded it. */
  event: "complete" | "publish";
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
    e.v === 1 &&
    typeof e.packageId === "string" &&
    typeof e.targetKey === "string" &&
    (e.reviewedHead === null || typeof e.reviewedHead === "string") &&
    hex(e.manifestSha256) &&
    (e.findingsSha256 === null || hex(e.findingsSha256)) &&
    (e.roundRecordSha256 === undefined || hex(e.roundRecordSha256)) &&
    typeof e.completedAt === "string"
  );
}

/** Every well-formed entry of a repository's registry; [] when it has none, or the file cannot be read. */
export function readRoundRegistry(identity: string | undefined, dir?: string): RoundRegistryEntry[] {
  if (identity === undefined) return [];
  const read = readConfigFile(roundRegistryFile(identity, dir));
  if (!read.ok) return [];
  const out: RoundRegistryEntry[] = [];
  for (const line of read.text.split("\n")) {
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

export function appendRoundRegistry(identity: string, entry: RoundRegistryEntry, dir?: string): string {
  ensureKeryxSubdir([ROUND_REGISTRY_DIR], dir);
  const file = roundRegistryFile(identity, dir);
  appendOwnerOnlyLine(file, JSON.stringify(entry));
  return file;
}

/**
 * The entry that vouches for a package with these files, or undefined: same package id, the same manifest and findings
 * bytes, and — when the entry recorded one — the same round.json. Any edit after keryx finished it breaks the match.
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

/**
 * Record a round keryx just finished (`review complete`, `review publish`). Best-effort: a registry that cannot be
 * written costs a later delta round on this machine (it falls back to a full round), never the command's own result,
 * so the failure is returned for the caller to print rather than thrown.
 */
export function recordFinishedRound(packageDir: string, event: RoundRegistryEntry["event"], options: { cwd?: string; dir?: string; now?: Date } = {}): { file?: string; error?: string } {
  try {
    const facts = packageFacts(packageDir);
    if (facts === undefined) return { error: `${packageDir} has no readable manifest.json` };
    const identity = repoIdentity(options.cwd ?? packageDir);
    // Outside a git checkout no commit can carry the package, so there is nothing for the registry to vouch for later.
    if (identity === undefined) return {};
    const target = facts.manifest.target !== null && typeof facts.manifest.target === "object" ? (facts.manifest.target as Record<string, unknown>) : {};
    const packageId = typeof facts.manifest.reviewId === "string" ? facts.manifest.reviewId : path.basename(packageDir);
    const head = typeof target.head === "string" ? target.head : null;
    const entry: RoundRegistryEntry = {
      v: 1,
      packageId,
      targetKey: roundStampOf(facts.manifest)?.targetKey ?? `${String(target.kind ?? "unknown")}:${String(target.ref ?? "")}`,
      reviewedHead: head,
      manifestSha256: facts.hashes.manifestSha256,
      findingsSha256: facts.hashes.findingsSha256,
      ...(facts.hashes.roundRecordSha256 === null ? {} : { roundRecordSha256: facts.hashes.roundRecordSha256 }),
      completedAt: (options.now ?? new Date()).toISOString(),
      event,
    };
    return { file: appendRoundRegistry(identity, entry, options.dir) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
