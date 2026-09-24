// Flow 313 (W4 portability), T6 — `keryx bundle import`'s Plan stage: verify
// checksums (fail closed on any mismatch, W4-AC3), then diff every entry
// against the target scope's disk state and the applied-state ledger to
// bucket it new / identical / update / conflict, applying the
// learned-pattern scope rule (W4-AC11) and the private-dir `.gitignore`
// fail-closed rule (W4-AC8) along the way.

import { readFile } from "node:fs/promises";

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
import { readAppliedState, appliedStatePath } from "./applied-state";
import { sha256Hex } from "./checksum";
import type { BundleSource } from "./archive";
import { rewriteAgentOrigin } from "./export";
import { targetFor, type PathCtx } from "./paths";
import { verifyBundle } from "./verify";
import { BUNDLE_REFUSAL, type BundleContentKind, type BundleManifest, type BundleRefusal, type BundleScope } from "./types";

export type PlanBucket = "new" | "identical" | "update" | "conflict";
export type PlanConflictReason = "user-modified" | "unmanaged-differs";

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
  bytes: Buffer;
}

export interface BundlePlan {
  ok: boolean;
  bundleId: string;
  refusals: BundleRefusal[];
  entries: PlanEntry[];
  /** The project root every entry's scope root was resolved against — apply re-runs path/symlink checks against the same root (R1-I1). */
  projectRoot: string;
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
}

// --- learned-pattern candidate rewrite -------------------------------------

interface LearnedPatternTtl {
  expiresAt: string;
}

/**
 * Deterministic default TTL: 30 days from the bundle's own `manifest.createdAt`
 * (not wall-clock `now`) so the rewritten bytes — and therefore
 * `incomingSha256` — are identical on every plan of the same bundle. Using
 * `Date.now()` here made `inspect` report `update` right after a fresh
 * `import`, and every re-import silently pushed the TTL out another 30 days
 * (R1-F11). Falls back to the current time only if `createdAt` fails to
 * parse, so a malformed manifest (which `parseManifest`'s schema check should
 * already have refused) never throws here.
 */
function defaultLearnedPatternTtl(manifestCreatedAt: string): LearnedPatternTtl {
  const base = new Date(manifestCreatedAt);
  const baseMs = Number.isNaN(base.getTime()) ? Date.now() : base.getTime();
  const expires = new Date(baseMs + 30 * 24 * 60 * 60 * 1000);
  return { expiresAt: expires.toISOString() };
}

/**
 * Rewrite a learned-pattern record to `status: "candidate"` (per the spec,
 * `keryx learn accept` is the only command that may leave a record
 * `accepted` — an imported record, project- or user-scope, always lands as a
 * candidate, R1-F25), adding a deterministic `ttl` only if it is absent.
 * Stable JSON, 2-space indent + trailing newline — these bytes are what
 * `incomingSha256` covers.
 */
function rewriteLearnedPatternCandidate(record: Record<string, unknown>, manifestCreatedAt: string): Buffer {
  const rewritten: Record<string, unknown> = { ...record, status: "candidate", supersededBy: null };
  if (rewritten.ttl === undefined || rewritten.ttl === null) {
    rewritten.ttl = defaultLearnedPatternTtl(manifestCreatedAt);
  }
  return Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
}

async function currentFileSha(absolutePath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(absolutePath);
    return sha256Hex(bytes);
  } catch {
    return undefined;
  }
}

export async function planBundleImport(opts: PlanBundleImportOptions): Promise<BundlePlan> {
  const ctx: PathCtx = { projectRoot: opts.projectRoot, env: opts.env, homeDir: opts.homeDir };

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
    return { ok: false, bundleId: opts.manifest.bundleId, refusals, entries: [], projectRoot: opts.projectRoot };
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
      effectiveBytes = rewriteLearnedPatternCandidate(recordObj, opts.manifest.createdAt);
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
        const check = await checkPrivateDirGitignore(memoryRoot);
        if (!check.ok) {
          refusals.push({ reason: BUNDLE_REFUSAL.privateGitignoreConflict, path: contentEntry.path, message: check.message });
          continue;
        }
      }
    }

    const targetRelative = contentEntry.path;
    const displayId = `${targetScope}:${targetRelative}`;
    const incomingSha256 = sha256Hex(effectiveBytes);
    const currentSha256 = await currentFileSha(target.absolutePath);

    const ledgerPath = appliedStatePath(targetScope, ctx);
    const ledgerState = await readAppliedState(ledgerPath);
    if (!ledgerState.ok) {
      refusals.push({ reason: BUNDLE_REFUSAL.corruptLedger, path: contentEntry.path, message: ledgerState.message });
      continue;
    }
    const ledgerRecord = ledgerState.state.entries[targetRelative];
    const ledgerSha256 = ledgerRecord?.sha256;

    let bucket: PlanBucket;
    let conflictReason: PlanConflictReason | undefined;

    if (currentSha256 === undefined) {
      bucket = "new";
    } else if (currentSha256 === incomingSha256) {
      bucket = "identical";
    } else if (ledgerSha256 !== undefined && currentSha256 === ledgerSha256) {
      bucket = "update";
    } else if (ledgerSha256 !== undefined && currentSha256 !== ledgerSha256) {
      bucket = "conflict";
      conflictReason = "user-modified";
    } else {
      bucket = "conflict";
      conflictReason = "unmanaged-differs";
    }

    const forced = (opts.force ?? []).includes(targetRelative) || (opts.force ?? []).includes(displayId);
    if (bucket === "conflict" && !forced) {
      refusals.push({ reason: BUNDLE_REFUSAL.unresolvedConflict, path: contentEntry.path, message: `${displayId} conflicts and was not passed to --force` });
    }

    entries.push({
      path: contentEntry.path,
      kind: contentEntry.kind,
      entryScope: contentEntry.scope,
      targetScope,
      targetRelative,
      displayId,
      targetPath: target.absolutePath,
      bucket,
      ...(conflictReason !== undefined ? { conflictReason } : {}),
      forced,
      incomingSha256,
      ...(currentSha256 !== undefined ? { currentSha256 } : {}),
      ...(ledgerSha256 !== undefined ? { ledgerSha256 } : {}),
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

  return { ok: refusals.length === 0, bundleId: opts.manifest.bundleId, refusals, entries, projectRoot: opts.projectRoot };
}
