// Flow 308 (W8, Lane B, T6): the impact-evidence gate provider — the
// function W6 will register at the `keryx.impact-evidence` hook slot (see
// `index.ts`'s doc comment). Pure composition over `evidence.ts` +
// `state.ts`; no host/harness wiring here.

import path from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDestructiveCommand } from "../../lib/command-risk";
import { commandWord, splitSegments } from "../../lib/shell-syntax";
import { isPathInside, toPosix } from "../../lib/fs";
import { loadSecurityConfig, resolveImpactEvidenceConfigTrusted } from "../config";
import type { ImpactEvidenceConfig } from "../types";
import { computeImpactEvidence, renderEvidenceBlock } from "./evidence";
import { appendLogRecord, loadSessionState, saveSessionState } from "./state";
import {
  IMPACT_EVIDENCE_HOOK_ID,
  type ImpactEvidence,
  type ImpactEvidenceDecision,
  type ImpactEvidenceHookClass,
  type ImpactEvidenceLogEvent,
  type ImpactEvidenceRequest,
} from "./types";

export { IMPACT_EVIDENCE_HOOK_ID };

/** `gate-advisory` by default, `gate` in strict mode — the whole rule. */
export function impactEvidenceHookClass(strict: boolean): ImpactEvidenceHookClass {
  return strict ? "gate" : "gate-advisory";
}

function killSwitchEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.KERYX_DISABLE_IMPACT_GATE;
  return value === "1" || value === "true";
}

/**
 * Resolve `p` to its real, symlink-free form. When `p` (or some suffix of
 * it) does not exist yet — the common case for a `Write` of a brand-new
 * file — walk up to the nearest EXISTING ancestor, realpath THAT (resolving
 * any symlink in the existing part of the path, including a symlinked
 * project root such as macOS's `/tmp` -> `/private/tmp`), and rejoin the
 * non-existent tail lexically. Falls back to the lexical path if even the
 * filesystem root can't be realpath'd (should not happen in practice).
 */
function realpathNearestExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return tail.length > 0 ? path.join(current, ...tail) : current;
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * F14 (review round 1, tightened in round 2): Claude (and any other host)
 * can send an absolute `file_path`. Left un-normalized, it never matches
 * anything the graph/test indexes know about (they are keyed on
 * root-relative POSIX paths), so evidence was unconditionally "not indexed"
 * for every real edit. Every file in the request is normalized to
 * root-relative POSIX before it reaches exemption matching, touch tracking,
 * or `computeEvidence` — a path that normalizes OUTSIDE `root` (a symlink
 * target elsewhere, `../secrets`, a different project) is dropped rather
 * than guessed at, and reported back to the caller as a warning plus a
 * `path-rejected` log entry.
 *
 * Round 1's version had three gaps a determined path could exploit:
 *
 *   1. It compared LEXICAL paths, so a symlink under `root` pointing
 *      outside it (or a symlink `root` itself sits behind — the classic
 *      macOS `/tmp` -> `/private/tmp` alias) either escaped undetected or was
 *      wrongly rejected as "outside" a root it was really inside. Both `root`
 *      and each candidate are resolved to their real path — `root` via
 *      `realpathNearestExisting` (it always exists), each candidate via the
 *      same helper so a not-yet-created file (a `Write` target) still gets
 *      its EXISTING ancestors' symlinks resolved.
 *   2. A relative path with a mid-string `..` that didn't start with `../`
 *      literally — `src/../../../etc/passwd` — passed the `startsWith`
 *      check untouched. Every candidate is `path.resolve`d against the
 *      (real) root first, which collapses `..` segments before containment
 *      is ever checked, so there is no lexical form left to sneak one past.
 *   3. The absolute-path branch's `isPathInside` call ran on the lexical,
 *      un-realpath'd root and candidate, missing the same symlink cases as
 *      (1). There is now exactly one containment check, after both sides are
 *      resolved to their real form, used by both the absolute and the
 *      relative branch.
 */
export function normalizeRequestFiles(root: string, files: string[]): { files: string[]; rejected: string[] } {
  const rootReal = realpathNearestExisting(path.resolve(root));
  const normalized: string[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const lexicalAbsolute = path.isAbsolute(file)
      ? path.resolve(file)
      : path.resolve(rootReal, toPosix(file).replace(/^\.\//, ""));
    const effective = realpathNearestExisting(lexicalAbsolute);
    if (!isPathInside(rootReal, effective)) {
      rejected.push(file);
      continue;
    }
    normalized.push(toPosix(path.relative(rootReal, effective)));
  }
  return { files: [...new Set(normalized)], rejected };
}

/**
 * F15 (review round 1, minor): the raw command text used to reach
 * `log.jsonl` verbatim (`rollback-required`/`rollback-accepted`) — a durable,
 * on-disk record of exactly what destructive shell command an agent ran.
 * That log is not the secrets/PII pipeline (no redaction, no HMAC, no
 * retention control), so a raw `rm -rf ~/.ssh` line sat there in the clear.
 * Only a SHA-256 prefix (so two occurrences of the same command are still
 * recognizably the same, without disclosing it) plus the classified command
 * family (`rm`, `git`, …, from the same `shell-syntax` primitives the
 * destructive classifier itself uses) is stored.
 */
export function redactCommandForLog(command: string): string {
  const segments = splitSegments(command);
  const family = segments.length > 0 ? commandWord(segments[0]!.words) || "(unknown)" : "(unknown)";
  const hash = createHash("sha256").update(command).digest("hex").slice(0, 12);
  return `sha256:${hash} family:${family}`;
}

export interface ImpactEvidenceProviderDeps {
  computeEvidence?: typeof computeImpactEvidence;
  loadConfig?: (root: string) => Promise<ImpactEvidenceConfig>;
}

async function defaultResolveConfig(
  root: string,
): Promise<{ config: ImpactEvidenceConfig; tampered: boolean; detail?: "absent" | "mismatch" }> {
  const security = await loadSecurityConfig(root);
  return resolveImpactEvidenceConfigTrusted(security);
}

interface DecisionContext {
  request: ImpactEvidenceRequest;
  files: string[];
  config: ImpactEvidenceConfig;
  hookClass: ImpactEvidenceHookClass;
  env: Record<string, string | undefined>;
  computeEvidence: typeof computeImpactEvidence;
}

/**
 * Build the provider function: `(request) => Promise<ImpactEvidenceDecision>`.
 * See `types.ts#ImpactEvidenceRequest`/`ImpactEvidenceDecision` for the
 * exact shape W6 registers this against.
 */
export function createImpactEvidenceProvider(
  deps: ImpactEvidenceProviderDeps = {},
): (request: ImpactEvidenceRequest) => Promise<ImpactEvidenceDecision> {
  const computeEvidence = deps.computeEvidence ?? computeImpactEvidence;
  const loadConfigOverride = deps.loadConfig;

  return async function impactEvidenceProvider(request: ImpactEvidenceRequest): Promise<ImpactEvidenceDecision> {
    const env = request.env ?? (process.env as Record<string, string | undefined>);

    // F11: an injected `loadConfig` (test-only) fully replaces config
    // resolution and is trusted as-is — it is the real, on-disk
    // `loadSecurityConfig` + checksum path that needs tamper-detection, and
    // that is exactly what `resolveImpactEvidenceConfigTrusted` adds.
    let config: ImpactEvidenceConfig;
    let tampered = false;
    let detail: "absent" | "mismatch" | undefined;
    if (loadConfigOverride) {
      config = await loadConfigOverride(request.root);
    } else {
      const resolved = await defaultResolveConfig(request.root);
      config = resolved.config;
      tampered = resolved.tampered;
      detail = resolved.detail;
    }
    const hookClass = impactEvidenceHookClass(config.strict);

    const { files, rejected } = normalizeRequestFiles(request.root, request.files);
    const extraWarnings: string[] = [];

    if (rejected.length > 0) {
      const record = await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "path-rejected",
        files: rejected,
      });
      const message = `skipped ${rejected.length} path(s) outside the project root: ${rejected.join(", ")}`;
      // F14(d) (review round 2): a request whose file(s) were rejected as
      // outside `root` used to fall through unconditionally — under
      // `gate`/`unattended-untrusted` a rejected path was silently dropped
      // and the request proceeded (or, if EVERY file was rejected, fell
      // into the ordinary "no files" allow path), rather than denying. Only
      // the two SUPERVISED `gate-advisory` profiles still allow through
      // (with a warning) — a human is watching there, so surfacing the
      // rejection is enough.
      if (hookClass === "gate" || request.profile === "unattended-untrusted") {
        return {
          hookId: IMPACT_EVIDENCE_HOOK_ID,
          hookClass,
          outcome: "deny",
          reason: "path-outside-root",
          warnings: [message],
          record,
        };
      }
      extraWarnings.push(message);
    }

    if (tampered) {
      await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "config-untrusted",
        files,
        // F11 (review round 2): distinguishes "no configChecksum was ever
        // recorded" from "one was recorded and does not match" — both are
        // untrusted, but only the second is provably tampered.
        ...(detail !== undefined ? { detail } : {}),
      });
      extraWarnings.push(
        detail === "absent"
          ? "impact-evidence config has no configChecksum — the impactEvidence block is not provably the operator's own, so loosening fields (enabled/exemptGlobs/dampenAfter) are ignored in favor of safe defaults"
          : "impact-evidence config checksum did not verify (or the config could not be read) — ignoring the stored block's loosening fields and using safe defaults",
      );
    }

    const decision = await computeDecision({ request, files, config, hookClass, env, computeEvidence });
    return extraWarnings.length > 0 ? { ...decision, warnings: [...extraWarnings, ...decision.warnings] } : decision;
  };
}

async function computeDecision(ctx: DecisionContext): Promise<ImpactEvidenceDecision> {
  const { request, files, config, hookClass, env, computeEvidence } = ctx;

  // --- Kill switch: bypasses the rollback gate too, and is itself logged
  // so "disabled" is never confused with "ran and found nothing" (AC15).
  if (killSwitchEnabled(env)) {
    const record = await appendLogRecord(request.root, {
      sessionId: request.sessionId,
      event: "disabled-env",
      files,
    });
    return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
  }
  // F11: when the config was tampered, `config.enabled` is already forced
  // `true` by `resolveImpactEvidenceConfigTrusted` — this branch simply never
  // fires for a tampered "disabled" config, which is the fix.
  if (!config.enabled) {
    const record = await appendLogRecord(request.root, {
      sessionId: request.sessionId,
      event: "disabled-config",
      files,
    });
    return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
  }

  // --- Shell path: a command was given. `isDestructiveCommand` decides
  // whether a rollback line is required — EVERY time, not just on first
  // touch (AC13).
  if (request.command !== undefined) {
    if (isDestructiveCommand(request.command)) {
      const rollback = request.rollbackLine?.trim();
      const detail = redactCommandForLog(request.command);
      if (!rollback) {
        const record = await appendLogRecord(request.root, {
          sessionId: request.sessionId,
          event: "rollback-required",
          files,
          detail,
        });
        return {
          hookId: IMPACT_EVIDENCE_HOOK_ID,
          hookClass,
          outcome: "ask",
          reason: "rollback-line-required",
          warnings: [],
          record,
        };
      }
      const record = await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "rollback-accepted",
        files,
        detail,
      });
      return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
    }
    // Non-destructive: allow, no rollback demand, no log-file noise — the
    // record is present (the return shape requires one) but never
    // persisted to `log.jsonl`.
    const record = {
      at: new Date().toISOString(),
      sessionId: request.sessionId,
      event: "not-applicable" as ImpactEvidenceLogEvent,
      files,
    };
    return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
  }

  // --- Edit path: no command, one or more files.
  if (files.length === 0) {
    const record = {
      at: new Date().toISOString(),
      sessionId: request.sessionId,
      event: "not-applicable" as ImpactEvidenceLogEvent,
      files: [],
    };
    return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
  }

  const state = await loadSessionState(request.root, request.sessionId);
  const exemptMatchers = config.exemptGlobs.map((pattern) => new Bun.Glob(pattern));
  const isExempt = (file: string): boolean => exemptMatchers.some((matcher) => matcher.match(file));

  const exempt = files.filter(isExempt);
  const nonExempt = files.filter((f) => !isExempt(f));

  if (exempt.length > 0 && nonExempt.length === 0) {
    const record = await appendLogRecord(request.root, {
      sessionId: request.sessionId,
      event: "skipped-exempt",
      files: exempt,
    });
    return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
  }

  const touchedSet = new Set(state.touched);
  const firstTouch = nonExempt.filter((f) => !touchedSet.has(f));
  const repeats = nonExempt.filter((f) => touchedSet.has(f));

  // Denial dampening bookkeeping: the caller reports the PREVIOUS prompt
  // for these files was denied, so bump the per-file counters before this
  // decision consults them.
  const denials: Record<string, number> = { ...state.denials };
  if (request.denied) {
    for (const file of files) {
      denials[file] = (denials[file] ?? 0) + 1;
    }
    await saveSessionState(request.root, request.sessionId, {
      touched: state.touched,
      denials,
      pendingAck: state.pendingAck ?? [],
    });
  }

  if (firstTouch.length === 0) {
    // Every non-exempt file was already touched this session — no block
    // (AC10), though exempt files (if any) are still logged above's sibling
    // case did not apply since nonExempt.length > 0 here.
    const record = await appendLogRecord(request.root, {
      sessionId: request.sessionId,
      event: "skipped-repeat",
      files: repeats,
    });
    return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
  }

  const dampenAfter = config.dampenAfter;
  const hasAcknowledgement = Boolean(request.acknowledgement && request.acknowledgement.trim().length > 0);

  // N8 (review round 2): strict mode's `ask` below never marked a file
  // touched (an acknowledgement can only arrive on a LATER request), so a
  // file that was asked about once and never acknowledged used to be asked
  // about again, from scratch, with the FULL evidence block, forever —
  // every edit re-asks forever. `state.pendingAck` (persisted below, on the
  // `ask` branch) remembers which files this session already asked about;
  // a follow-up request for one of them that still carries no
  // acknowledgement gets the condensed notice instead of recomputing full
  // evidence, and — like a reported denial — counts toward the ordinary
  // per-file dampening threshold too, so a file that is never acknowledged
  // eventually folds into the same "dampened after repeated denials"
  // bucket. Only a NON-empty acknowledgement clears it (see the allow path
  // below).
  const pendingAckSet = new Set(state.pendingAck ?? []);
  const pendingReAsk =
    config.strict && !hasAcknowledgement ? firstTouch.filter((file) => pendingAckSet.has(file)) : [];
  for (const file of pendingReAsk) {
    denials[file] = (denials[file] ?? 0) + 1;
  }

  // F17 (review round 1): dampening used to be an ALL-OR-NOTHING call over
  // the whole batch (`.some(...)`) — one repeatedly-denied file collapsed the
  // evidence for every OTHER first-touch file in the same batch too, even
  // one that had never been denied. Split per file instead: a dampened file
  // gets the condensed notice, every other first-touch file in the batch
  // still gets its full evidence block.
  const deniedDampened = firstTouch.filter(
    (file) => (denials[file] ?? 0) >= dampenAfter && !pendingReAsk.includes(file),
  );
  const dampenedFiles = [...new Set([...deniedDampened, ...pendingReAsk])];
  const normalFiles = firstTouch.filter((file) => !dampenedFiles.includes(file));

  let evidences: ImpactEvidence[] = [];
  if (normalFiles.length > 0) {
    try {
      evidences = await Promise.all(normalFiles.map((file) => computeEvidence(request.root, file)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "service-failed",
        files: normalFiles,
        detail: message,
      });
      // F12 (review round 1, major): `gate` (strict mode) must fail CLOSED
      // on a service failure in EVERY profile, per W6's failure table — not
      // only `unattended-untrusted`. `gate-advisory` keeps its previous
      // behavior: deny under `unattended-untrusted`, allow-with-warning
      // under the two supervised profiles.
      if (hookClass === "gate") {
        return {
          hookId: IMPACT_EVIDENCE_HOOK_ID,
          hookClass,
          outcome: "deny",
          reason: "hook-crashed",
          warnings: [`impact-evidence service failed: ${message}`],
          record,
        };
      }
      if (request.profile === "unattended-untrusted") {
        return {
          hookId: IMPACT_EVIDENCE_HOOK_ID,
          hookClass,
          outcome: "deny",
          reason: "hook-advisory-failed",
          warnings: [`impact-evidence service failed: ${message}`],
          record,
        };
      }
      return {
        hookId: IMPACT_EVIDENCE_HOOK_ID,
        hookClass,
        outcome: "allow",
        additionalContext: "Impact evidence is unavailable for this change (the evidence service failed).",
        warnings: [`impact-evidence service failed: ${message} — proceeding without evidence`],
        record,
      };
    }
  }

  const parts: string[] = [];
  if (evidences.length > 0) {
    parts.push(renderEvidenceBlock(evidences, normalFiles));
  }
  if (deniedDampened.length > 0) {
    parts.push(
      `Impact evidence dampened after repeated denials for: ${deniedDampened.join(", ")}. Proceed with care — evidence is still available via \`keryx security impact-evidence test\`.`,
    );
  }
  if (pendingReAsk.length > 0) {
    parts.push(
      `Impact evidence pending acknowledgement for: ${pendingReAsk.join(", ")} (already shown; condensed until acknowledged). Full evidence is still available via \`keryx security impact-evidence test\`.`,
    );
  }
  const additionalContext = parts.join("\n\n");
  const event: ImpactEvidenceLogEvent = dampenedFiles.length > 0 ? "dampened" : "injected";

  // Strict mode: an injection needs an acknowledgement before it is
  // allowed to proceed.
  if (config.strict && !hasAcknowledgement) {
    const record = await appendLogRecord(request.root, {
      sessionId: request.sessionId,
      event,
      files: firstTouch,
    });
    // N8: remember these files as awaiting acknowledgement — and persist the
    // bumped `denials` from the `pendingReAsk` re-asks above — so a follow-up
    // request that still carries no acknowledgement is recognized next time
    // instead of asking about the same file, from scratch, forever.
    const newPendingAck = [...new Set([...pendingAckSet, ...firstTouch])];
    await saveSessionState(request.root, request.sessionId, {
      touched: state.touched,
      denials,
      pendingAck: newPendingAck,
    });
    return {
      hookId: IMPACT_EVIDENCE_HOOK_ID,
      hookClass,
      outcome: "ask",
      reason: "acknowledgement-required",
      additionalContext,
      warnings: [],
      record,
    };
  }

  // Mark touched only AFTER a successful injection the caller is not, in
  // this very request, reporting as denied — a file whose previous prompt
  // was denied stays "first touch" so a retry keeps consulting the
  // denial-dampening path above instead of silently falling into
  // `skipped-repeat` the moment it was ever shown once.
  const newTouched = request.denied ? state.touched : [...new Set([...state.touched, ...firstTouch])];
  // N8: a file that just got its acknowledgement (or was allowed through a
  // non-strict path) is no longer awaiting one.
  const newPendingAck = state.pendingAck ? state.pendingAck.filter((file) => !firstTouch.includes(file)) : [];
  await saveSessionState(request.root, request.sessionId, { touched: newTouched, denials, pendingAck: newPendingAck });

  const record = await appendLogRecord(request.root, {
    sessionId: request.sessionId,
    event,
    files: firstTouch,
  });
  return {
    hookId: IMPACT_EVIDENCE_HOOK_ID,
    hookClass,
    outcome: "allow",
    additionalContext,
    warnings: [],
    record,
  };
}
