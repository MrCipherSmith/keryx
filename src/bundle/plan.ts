// Flow 313 (W4 portability), T6 — `keryx bundle import`'s Plan stage: verify
// checksums (fail closed on any mismatch, W4-AC3), then diff every entry
// against the target scope's disk state and the applied-state ledger to
// bucket it new / identical / update / conflict, applying the
// learned-pattern scope rule (W4-AC11) and the private-dir `.gitignore`
// fail-closed rule (W4-AC8) along the way.

import { validateAgainstSchemaObject } from "../contracts/validator";
import { parseAgentFrontmatter, validateAgentFrontmatter } from "../agents/service";
import { checkPrivateDirGitignore } from "../lib/private-dir";
import { userStorePaths } from "../lib/keryx-home";
import hookConfigSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/hook-config.schema.json" with {
  type: "json",
};
import learnedPatternSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/learned-pattern.schema.json" with {
  type: "json",
};
import { readAppliedState, appliedStatePath, type AppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import type { BundleSource } from "./archive";
import { rewriteAgentOrigin } from "./export";
import { canonicalBundleKey, readTargetFile, scopeRoot, targetFor, type PathCtx } from "./paths";
import { verifyBundle } from "./verify";
import { BUNDLE_REFUSAL, type BundleContentKind, type BundleManifest, type BundleRefusal, type BundleScope } from "./types";

export type PlanBucket = "new" | "identical" | "update" | "conflict";
// R1-F1: an entry that would otherwise bucket "update" (content unchanged
// since it was last applied) but whose ledger record belongs to a DIFFERENT
// bundleId is a conflict, not a silent takeover — "owned-by-other-bundle".
export type PlanConflictReason = "user-modified" | "unmanaged-differs" | "owned-by-other-bundle";

export interface PlanEntry {
  path: string;
  kind: BundleContentKind;
  entryScope: BundleScope;
  targetScope: BundleScope;
  targetRelative: string;
  displayId: string;
  targetPath: string;
  bucket: PlanBucket;
  conflictReason?: PlanConflictReason;
  forced: boolean;
  incomingSha256: string;
  currentSha256?: string;
  ledgerSha256?: string;
  /** The ledger record's OWN bundleId, when a record already exists for this target — set whenever `conflictReason === "owned-by-other-bundle"`, so a forced import can report the takeover (R3-F16). */
  previousOwnerBundleId?: string;
  /** The ledger record's `sourceProject`, when it had one — reported alongside `previousOwnerBundleId` (R3-F16, R3-F18). */
  previousOwnerSourceProject?: string;
  bytes: Buffer;
}

type ReadAppliedStateForScope = { ok: true; state: AppliedState } | { ok: false; message: string };

export interface BundlePlan {
  ok: boolean;
  bundleId: string;
  refusals: BundleRefusal[];
  entries: PlanEntry[];
  /** The project root every entry's scope root was resolved against — apply re-runs path/symlink checks against the same root (R1-I1). */
  projectRoot: string;
  /** `manifest.provenance.sourceProject`, threaded through so apply.ts can record it on every ledger entry it writes (R3-F18). */
  bundleSourceProject?: string;
  /** `bundleContentDigest(manifest)` — likewise threaded through for the ledger (R3-F18). */
  bundleContentDigest: string;
}

export interface PlanBundleImportOptions {
  source: BundleSource;
  manifest: BundleManifest;
  projectRoot: string;
  targetScope?: BundleScope | undefined;
  force?: string[] | undefined;
  /** Required (`--allow-hooks`) before any `hook-config` entry may be planned (R1-F13). */
  allowHooks?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
  /** Injectable clock for the learned-pattern TTL's `importDay` anchor (R2-F19); defaults to `() => new Date()`. */
  now?: (() => Date) | undefined;
}

// --- learned-pattern candidate rewrite -------------------------------------

interface LearnedPatternTtl {
  expiresAt: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deterministic default TTL (R1-F11, then R2-F19): `max(createdAt, importDay)
 * + 30d`, where `importDay` is `now` floored to the UTC calendar date (not
 * the exact instant) — so replanning the same bundle within the same UTC day
 * reproduces the identical `expiresAt`, and therefore the identical
 * `incomingSha256` (R1-F11's determinism requirement still holds within a
 * day). Anchoring on `createdAt` ALONE (the round-1 fix) meant a bundle
 * older than 30 days imported patterns that were already expired the moment
 * they landed (R2-F19); anchoring on `now` alone reintroduces R1-F11's bug.
 * `max(...)` gives a floor of "at least 30 days from today", while still
 * respecting a `createdAt` far enough in the FUTURE (clock skew) to push it
 * out further. Falls back to `now` only if `createdAt` fails to parse, so a
 * malformed manifest (which `parseManifest`'s schema check should already
 * have refused) never throws here.
 */
function defaultLearnedPatternTtl(manifestCreatedAt: string, now: () => Date): LearnedPatternTtl {
  const base = new Date(manifestCreatedAt);
  const baseMs = Number.isNaN(base.getTime()) ? now().getTime() : base.getTime();
  const nowDate = now();
  const importDayMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const expiresMs = Math.max(baseMs, importDayMs) + THIRTY_DAYS_MS;
  return { expiresAt: new Date(expiresMs).toISOString() };
}

/**
 * Rewrite a learned-pattern record to `status: "candidate"` (per the spec,
 * `keryx learn accept` is the only command that may leave a record
 * `accepted` — an imported record, project- or user-scope, always lands as a
 * candidate, R1-F25), adding a deterministic `ttl` only if it is absent.
 * Stable JSON, 2-space indent + trailing newline — these bytes are what
 * `incomingSha256` covers.
 */
function rewriteLearnedPatternCandidate(record: Record<string, unknown>, manifestCreatedAt: string, now: () => Date): Buffer {
  const rewritten: Record<string, unknown> = { ...record, status: "candidate", supersededBy: null };
  if (rewritten.ttl === undefined || rewritten.ttl === null) {
    rewritten.ttl = defaultLearnedPatternTtl(manifestCreatedAt, now);
  }
  return Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
}

/**
 * `JSON.stringify` with object keys sorted recursively, so two independently
 * parsed objects compare equal whenever their VALUES match, regardless of
 * property insertion order.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * R2-F19 (the fix's side effect): the TTL is now day-granular and anchored
 * partly on `now`, so the SAME on-disk file compared against a freshly
 * rewritten candidate on a LATER day would otherwise differ only in
 * `ttl.expiresAt`, breaking "inspect after import reports identical"
 * (R1-F11). Two learned-pattern records are treated as identical content
 * when they match on every field except `ttl.expiresAt`.
 */
function learnedPatternEqualModuloTtl(currentBytes: Buffer, candidateBytes: Buffer): boolean {
  try {
    const strip = (raw: unknown): unknown => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
      const obj = { ...(raw as Record<string, unknown>) };
      if (typeof obj.ttl === "object" && obj.ttl !== null && !Array.isArray(obj.ttl)) {
        const ttl = { ...(obj.ttl as Record<string, unknown>) };
        delete ttl.expiresAt;
        obj.ttl = ttl;
      }
      return obj;
    };
    const current = strip(JSON.parse(currentBytes.toString("utf8")));
    const candidate = strip(JSON.parse(candidateBytes.toString("utf8")));
    return stableStringify(current) === stableStringify(candidate);
  } catch {
    return false;
  }
}

/**
 * A digest of the manifest's own sorted `"<path>\t<sha256>"` content list
 * (R3-F18) — the same shape `export.ts`'s no-remote default bundleId uses,
 * but here it is recorded in the applied-state ledger alongside
 * `provenance.sourceProject` purely for ownership audit/troubleshooting: a
 * later `bundle verify`/support investigation can tell whether "the same
 * bundleId, re-applied" really was a re-export of the same content, without
 * that comparison ever gating the plan/conflict decision itself (which
 * relies on `sourceProject`, a much cheaper and more targeted signal against
 * id-spoofing).
 */
function bundleContentDigest(manifest: BundleManifest): string {
  const sorted = [...manifest.contents].map((e) => `${e.path}\t${e.sha256}`).sort();
  return sha256Hex(Buffer.from(sorted.join("\n"), "utf8"));
}

export async function planBundleImport(opts: PlanBundleImportOptions): Promise<BundlePlan> {
  const ctx: PathCtx = { projectRoot: opts.projectRoot, env: opts.env, homeDir: opts.homeDir };
  const now = opts.now ?? (() => new Date());
  const contentDigest = bundleContentDigest(opts.manifest);

  // R3-F20: the ledger for a given target scope is read ONCE per plan, not
  // once per entry — re-inspecting/re-importing a large bundle (thousands of
  // entries, almost always all the same scope) previously re-read and
  // re-parsed the whole ledger file per entry, which cost ~39s at 9,999
  // entries. A corrupt ledger for a scope is cached too (so it is reported
  // once per entry that needs it, matching the previous per-entry refusal
  // shape, without re-reading the file each time).
  const ledgerByScope = new Map<BundleScope, ReadAppliedStateForScope>();
  async function ledgerFor(scope: BundleScope): Promise<ReadAppliedStateForScope> {
    const existing = ledgerByScope.get(scope);
    if (existing) return existing;
    const ledgerPath = appliedStatePath(scope, ctx);
    const read = await readAppliedState(ledgerPath);
    const entry: ReadAppliedStateForScope = read.ok ? { ok: true, state: read.state } : { ok: false, message: read.message };
    ledgerByScope.set(scope, entry);
    return entry;
  }

  // Step 1: checksums first. Any failure -> ok:false, no further work.
  const verified = verifyBundle(opts.source, opts.manifest);
  if (!verified.ok) {
    const refusals: BundleRefusal[] = [];
    for (const entry of verified.entries) {
      if (entry.status !== "ok") {
        refusals.push({
          reason: entry.status === "checksum-mismatch" ? BUNDLE_REFUSAL.checksumMismatch : entry.status === "size-mismatch" ? BUNDLE_REFUSAL.sizeMismatch : BUNDLE_REFUSAL.missingEntry,
          path: entry.path,
          message: `${entry.path}: ${entry.status}`,
        });
      }
    }
    for (const p of verified.unlisted) {
      refusals.push({ reason: BUNDLE_REFUSAL.unlistedFile, path: p, message: `${p} is present in the bundle but not listed in the manifest` });
    }
    return {
      ok: false,
      bundleId: opts.manifest.bundleId,
      refusals,
      entries: [],
      projectRoot: opts.projectRoot,
      ...(opts.manifest.provenance.sourceProject !== undefined ? { bundleSourceProject: opts.manifest.provenance.sourceProject } : {}),
      bundleContentDigest: contentDigest,
    };
  }

  const refusals: BundleRefusal[] = [];
  const entries: PlanEntry[] = [];
  const gitignoreChecked = new Set<string>();

  for (const contentEntry of opts.manifest.contents) {
    const bytes = opts.source.files.get(contentEntry.path) as Buffer;
    const targetScope = opts.targetScope ?? contentEntry.scope;

    // R1-F13: a bundle whose manifest claims one sourceScope must not
    // silently write a DIFFERENT scope's entry unless the caller explicitly
    // asked to retarget (`--target-scope`). Without that flag, a "project"
    // bundle carrying a `scope: user` hooks.json entry would otherwise write
    // straight into the global `~/.keryx/hooks.json`.
    if (opts.targetScope === undefined && contentEntry.scope !== opts.manifest.provenance.sourceScope) {
      refusals.push({
        reason: BUNDLE_REFUSAL.scopeMismatch,
        path: contentEntry.path,
        message: `${contentEntry.path}: entry scope "${contentEntry.scope}" differs from the bundle's provenance.sourceScope "${opts.manifest.provenance.sourceScope}"; pass --target-scope to import it anyway`,
      });
      continue;
    }

    // R1-F13: hook-config entries write into a live, every-project-affecting
    // config (`~/.keryx/hooks.json` or `.metaproject/hooks.json`, W6). Never
    // import one silently — the caller must opt in explicitly.
    if (contentEntry.kind === "hook-config" && opts.allowHooks !== true) {
      refusals.push({
        reason: BUNDLE_REFUSAL.hooksRequireOptIn,
        path: contentEntry.path,
        message: `${contentEntry.path}: importing a hook-config entry requires --allow-hooks`,
      });
      continue;
    }

    // Learned-pattern scope rule (W4-AC11): never retarget; scope is immutable.
    if (contentEntry.kind === "learned-pattern") {
      if (contentEntry.scope === "project" && targetScope !== "project" && targetScope !== "team") {
        refusals.push({
          reason: BUNDLE_REFUSAL.learnedPatternScope,
          path: contentEntry.path,
          message: `cannot import a project-scope learned-pattern at ${targetScope} scope; scope is immutable across import`,
        });
        continue;
      }
      if (contentEntry.scope === "user" && targetScope !== "user") {
        refusals.push({
          reason: BUNDLE_REFUSAL.learnedPatternScope,
          path: contentEntry.path,
          message: `cannot import a user-scope learned-pattern at ${targetScope} scope; scope is immutable across import`,
        });
        continue;
      }
    }
    // Retargeting for non-learned-pattern kinds (contentEntry.scope !==
    // targetScope) is allowed only when the same relative path is also valid
    // at the target scope; `targetFor` below enforces that
    // (path-not-valid-for-scope / kind-path-mismatch).

    let effectiveBytes = bytes;

    if (contentEntry.kind === "learned-pattern") {
      let record: unknown;
      try {
        record = JSON.parse(bytes.toString("utf8"));
      } catch {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path} is not valid JSON` });
        continue;
      }
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path} is not a JSON object` });
        continue;
      }
      const recordObj = record as Record<string, unknown>;
      if (recordObj.scope !== contentEntry.scope) {
        refusals.push({
          reason: BUNDLE_REFUSAL.learnedPatternScope,
          path: contentEntry.path,
          message: `${contentEntry.path}: record scope "${String(recordObj.scope)}" does not match manifest entry scope "${contentEntry.scope}"`,
        });
        continue;
      }
      effectiveBytes = rewriteLearnedPatternCandidate(recordObj, opts.manifest.createdAt, now);
      // Validate AFTER the candidate rewrite — the rewrite is what actually
      // gets written, so that is what must be schema-valid (R1-F12).
      let rewrittenParsed: unknown;
      try {
        rewrittenParsed = JSON.parse(effectiveBytes.toString("utf8"));
      } catch {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path}: candidate rewrite produced invalid JSON` });
        continue;
      }
      const patternValidation = validateAgainstSchemaObject(learnedPatternSchemaJson as Record<string, unknown>, rewrittenParsed);
      if (!patternValidation.valid) {
        refusals.push({
          reason: BUNDLE_REFUSAL.contentInvalid,
          path: contentEntry.path,
          message: `${contentEntry.path} fails learned-pattern schema: ${patternValidation.errors[0]?.message ?? "invalid"}`,
        });
        continue;
      }
    }

    // R1-F12: a hand-crafted (non-`keryx bundle export`) bundle must not be
    // able to hand `apply` an unvalidated hook-config payload — a
    // schema-invalid `hooks.json` would otherwise be written straight into
    // the live W6 hook runtime.
    if (contentEntry.kind === "hook-config") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path} is not valid JSON` });
        continue;
      }
      const validation = validateAgainstSchemaObject(hookConfigSchemaJson as Record<string, unknown>, parsed);
      if (!validation.valid) {
        refusals.push({
          reason: BUNDLE_REFUSAL.contentInvalid,
          path: contentEntry.path,
          message: `${contentEntry.path} fails hook-config schema: ${validation.errors[0]?.message ?? "invalid"}`,
        });
        continue;
      }
    }

    // R1-F12 (AC14): every imported agent's `origin` is forced to
    // `{ kind: imported, sourceRef: <this bundle's id> }` regardless of what
    // the bundle claims — the producer-side rewrite in export.ts is not a
    // guarantee a hand-crafted bundle honors it. Re-validated afterward
    // against the same W2 schema `keryx agents verify` uses.
    if (contentEntry.kind === "agent") {
      const text = bytes.toString("utf8");
      const rewritten = rewriteAgentOrigin(text, opts.manifest.bundleId);
      const parsedFrontmatter = parseAgentFrontmatter(rewritten);
      if (!parsedFrontmatter.ok) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path}: ${parsedFrontmatter.error.message}` });
        continue;
      }
      const validation = validateAgentFrontmatter(parsedFrontmatter.result.data);
      if (!validation.ok) {
        refusals.push({
          reason: BUNDLE_REFUSAL.contentInvalid,
          path: contentEntry.path,
          message: `${contentEntry.path} fails agent-definition schema: ${validation.errors[0]?.message ?? "invalid"}`,
        });
        continue;
      }
      effectiveBytes = Buffer.from(rewritten, "utf8");
    }

    const target = await targetFor(contentEntry, targetScope, ctx);
    if (!target.ok) {
      refusals.push(target.refusal);
      continue;
    }

    // Private-dir `.gitignore` fail-closed rule for user-scope memory entries.
    if (targetScope === "user" && contentEntry.kind === "memory-entry") {
      const memoryRoot = userStorePaths(opts.env ?? process.env, opts.homeDir).memory;
      if (!gitignoreChecked.has(memoryRoot)) {
        gitignoreChecked.add(memoryRoot);
        // `root` bounds the check's own ancestor-symlink walk to the user
        // store root, so a symlink ANYWHERE between it and `memoryRoot`
        // that escapes the store is refused too, not only a symlinked
        // `memory/` itself.
        const check = await checkPrivateDirGitignore(memoryRoot, scopeRoot("user", ctx));
        if (!check.ok) {
          refusals.push({ reason: BUNDLE_REFUSAL.privateGitignoreConflict, path: contentEntry.path, message: check.message });
          continue;
        }
      }
    }

    const targetRelative = contentEntry.path;

    // Choke point b (R3-F2), consulted BEFORE any on-disk read: the ledger is
    // keyed by the CANONICAL form of the path (`canonicalBundleKey`), not
    // the entry's own casing, so ownership is resolved from the ledger
    // record FIRST and is therefore filesystem-independent — on a
    // case-sensitive filesystem where no file exists at the exact incoming
    // case (only under the ledger's recorded case), the ownership record is
    // still found, exactly as a case-insensitive filesystem's own on-disk
    // fold would have found it by ordinary path lookup.
    const ledgerState = await ledgerFor(targetScope);
    if (!ledgerState.ok) {
      refusals.push({ reason: BUNDLE_REFUSAL.corruptLedger, path: contentEntry.path, message: ledgerState.message });
      continue;
    }
    const canonicalKey = canonicalBundleKey(targetRelative);
    const ledgerRecord = ledgerState.state.entries[canonicalKey];
    const ledgerSha256 = ledgerRecord?.sha256;
    // R1-F1: a ledger record that already exists but belongs to a DIFFERENT
    // bundleId means some other bundle wrote (and still owns) this target.
    // R3-F18: a record that DECLARES the same bundleId is not proof of the
    // same producer — a hand-crafted bundle can trivially spoof any
    // `bundleId` string. When the ledger record carries a `sourceProject`
    // (recorded from `manifest.provenance.sourceProject` at apply time) and
    // this import's manifest ALSO declares one, and they differ, the
    // declared id is being reused across two different sources; treated the
    // same as an ordinary ownership conflict (needs `--force`), not a
    // silent same-bundle update. Two bundles that both have NO sourceProject
    // (no git remote at export time) cannot be distinguished this way and
    // fall back to the plain bundleId check, same as before.
    const ledgerOwnedByOther =
      ledgerRecord !== undefined &&
      (ledgerRecord.bundleId !== opts.manifest.bundleId ||
        (ledgerRecord.sourceProject !== undefined && opts.manifest.provenance.sourceProject !== undefined && ledgerRecord.sourceProject !== opts.manifest.provenance.sourceProject));

    // Case-variant of an already-owned path: the ledger record exists but
    // was recorded under a DIFFERENT case than this entry's incoming path.
    // Treated as the SAME logical target and resolved to the ledger's own
    // recorded path rather than the incoming one — apply then writes (and
    // uninstall then removes) at that one recorded path either way, so a
    // case-sensitive filesystem can never end up with a second, case-variant
    // file for what the ledger already considers one target.
    //
    // Flow 313 (W4) round-4 review R4-F6: this retarget used to apply ONLY
    // for a same-bundle case-variant (`!ledgerOwnedByOther`); a FORCED
    // cross-bundle case-variant transfer was deliberately left pointed at
    // the incoming path, which is exactly what stranded the previous
    // owner's file — the ledger keeps one record (now for the incoming
    // bundle, at the incoming case), but the previous owner's file, at its
    // OWN recorded case, was never touched and had no record pointing at it
    // any more. Retargeting a cross-bundle transfer too (the simpler of the
    // two documented options; the alternative, removing the previous file as
    // part of the transfer, was rejected because it would delete a file
    // `--force` did not ask to delete) makes a forced takeover REPLACE the
    // previous owner's file at its own path — one file, one record, exactly
    // like the same-bundle case already guarantees. `ledgerOwnedByOther`
    // still drives the conflict/ownership bookkeeping below (via
    // `currentSha256`/`ledgerSha256` read from this retargeted path); only
    // the WRITE location itself is unconditional here.
    let effectiveTargetPath = target.absolutePath;
    let effectiveTargetRelative = targetRelative;
    if (ledgerRecord !== undefined && ledgerRecord.path !== targetRelative) {
      const recordedTarget = await targetFor({ path: ledgerRecord.path, kind: contentEntry.kind, scope: contentEntry.scope }, targetScope, ctx);
      if (!recordedTarget.ok) {
        refusals.push(recordedTarget.refusal);
        continue;
      }
      effectiveTargetPath = recordedTarget.absolutePath;
      effectiveTargetRelative = ledgerRecord.path;
    }

    const displayId = `${targetScope}:${effectiveTargetRelative}`;

    // R2-F20: distinguish "target does not exist" from "target exists but
    // could not be read" (permissions, an I/O error). Swallowing every error
    // the same way planned an unreadable-but-present user file as `new`,
    // which apply then clobbered and uninstall's rollback later deleted.
    const currentFile = await readTargetFile(effectiveTargetPath);
    if (!currentFile.ok) {
      refusals.push({ ...currentFile.refusal, path: contentEntry.path });
      continue;
    }
    const currentBytes = currentFile.bytes;

    // R2-F19 (side effect of the TTL fix above): if this is the exact same
    // learned-pattern content already on disk and it differs only in the
    // now day-granular `ttl.expiresAt`, treat the file already there as the
    // content to compare/apply — so re-planning the same import on a later
    // UTC day still reports `identical`, not a spurious `update` (R1-F11).
    if (contentEntry.kind === "learned-pattern" && currentBytes !== undefined && learnedPatternEqualModuloTtl(currentBytes, effectiveBytes)) {
      effectiveBytes = currentBytes;
    }

    const incomingSha256 = sha256Hex(effectiveBytes);
    const currentSha256 = currentBytes === undefined ? undefined : sha256Hex(currentBytes);

    let bucket: PlanBucket;
    let conflictReason: PlanConflictReason | undefined;

    if (currentSha256 === undefined) {
      // R3-F2 follow-up: this branch used to always bucket `new` — but the
      // ledger's ownership record (looked up above by canonical key, BEFORE
      // any on-disk read) is filesystem-independent, so a case-variant path
      // from a DIFFERENT bundle must conflict here too, not only when
      // on-disk case-folding happens to resolve `currentSha256` to a match.
      // Without this branch, the exact same bundle-B-ships-`rules/X.md`
      // scenario the ledger-owned check below already handles bucketed
      // `new` on a case-sensitive filesystem (Linux CI) while correctly
      // bucketing `conflict` on a case-insensitive one (macOS).
      if (ledgerOwnedByOther) {
        bucket = "conflict";
        conflictReason = "owned-by-other-bundle";
      } else {
        bucket = "new";
      }
    } else if (currentSha256 === incomingSha256) {
      // Identical bytes: safe regardless of ownership — apply never writes
      // an `identical` entry, and only claims the ledger record when it
      // already belongs to this bundle (see apply.ts), so this can never
      // silently transfer ownership.
      bucket = "identical";
    } else if (ledgerSha256 !== undefined && currentSha256 === ledgerSha256) {
      if (ledgerOwnedByOther) {
        // R1-F1: content unchanged since ANOTHER bundle applied it. Without
        // this branch this bucketed "update" and a forced-by-default write
        // silently transferred ownership; now it requires `--force <path>`
        // like any other conflict, and the transfer is explicit.
        bucket = "conflict";
        conflictReason = "owned-by-other-bundle";
      } else {
        bucket = "update";
      }
    } else if (ledgerSha256 !== undefined && currentSha256 !== ledgerSha256) {
      bucket = "conflict";
      conflictReason = "user-modified";
    } else {
      // ledgerSha256 undefined here implies ledgerRecord is undefined too,
      // so ledgerOwnedByOther is always false in this branch.
      bucket = "conflict";
      conflictReason = "unmanaged-differs";
    }

    const forced = (opts.force ?? []).includes(effectiveTargetRelative) || (opts.force ?? []).includes(displayId);
    if (bucket === "conflict" && !forced) {
      refusals.push({ reason: BUNDLE_REFUSAL.unresolvedConflict, path: contentEntry.path, message: `${displayId} conflicts and was not passed to --force` });
    }

    entries.push({
      path: contentEntry.path,
      kind: contentEntry.kind,
      entryScope: contentEntry.scope,
      targetScope,
      targetRelative: effectiveTargetRelative,
      displayId,
      targetPath: effectiveTargetPath,
      bucket,
      ...(conflictReason !== undefined ? { conflictReason } : {}),
      forced,
      incomingSha256,
      ...(currentSha256 !== undefined ? { currentSha256 } : {}),
      ...(ledgerSha256 !== undefined ? { ledgerSha256 } : {}),
      // R3-F16: carried through so a forced takeover can be reported (who
      // owned it before) instead of silently disappearing into a bare
      // "written" line.
      ...(conflictReason === "owned-by-other-bundle" && ledgerRecord !== undefined ? { previousOwnerBundleId: ledgerRecord.bundleId } : {}),
      ...(conflictReason === "owned-by-other-bundle" && ledgerRecord?.sourceProject !== undefined ? { previousOwnerSourceProject: ledgerRecord.sourceProject } : {}),
      bytes: effectiveBytes,
    });
  }

  const forceValues = new Set(opts.force ?? []);
  const matchedForce = new Set<string>();
  for (const entry of entries) {
    if (forceValues.has(entry.targetRelative)) matchedForce.add(entry.targetRelative);
    if (forceValues.has(entry.displayId)) matchedForce.add(entry.displayId);
  }
  for (const forceValue of forceValues) {
    if (!matchedForce.has(forceValue)) {
      refusals.push({ reason: BUNDLE_REFUSAL.unknownForcePath, path: forceValue, message: `--force ${forceValue} does not match any planned entry` });
    }
  }

  return {
    ok: refusals.length === 0,
    bundleId: opts.manifest.bundleId,
    refusals,
    entries,
    projectRoot: opts.projectRoot,
    ...(opts.manifest.provenance.sourceProject !== undefined ? { bundleSourceProject: opts.manifest.provenance.sourceProject } : {}),
    bundleContentDigest: contentDigest,
  };
}
