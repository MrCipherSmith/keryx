// Flow 308 (W8, Lane B, T6): the impact-evidence gate provider — the
// function W6 will register at the `keryx.impact-evidence` hook slot (see
// `index.ts`'s doc comment). Pure composition over `evidence.ts` +
// `state.ts`; no host/harness wiring here.

import path from "node:path";
import { createHash } from "node:crypto";
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
 * F14 (review round 1): Claude (and any other host) can send an absolute
 * `file_path`. Left un-normalized, it never matches anything the graph/test
 * indexes know about (they are keyed on root-relative POSIX paths), so
 * evidence was unconditionally "not indexed" for every real edit. Every file
 * in the request is normalized to root-relative POSIX before it reaches
 * exemption matching, touch tracking, or `computeEvidence` — a path that
 * normalizes OUTSIDE `root` (a symlink target elsewhere, `../secrets`, a
 * different project) is dropped rather than guessed at, and reported back to
 * the caller as a warning plus a `path-rejected` log entry.
 */
export function normalizeRequestFiles(root: string, files: string[]): { files: string[]; rejected: string[] } {
  const normalized: string[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (path.isAbsolute(file)) {
      if (!isPathInside(root, file)) {
        rejected.push(file);
        continue;
      }
      normalized.push(toPosix(path.relative(path.resolve(root), path.resolve(file))));
      continue;
    }
    const relative = toPosix(file).replace(/^\.\//, "");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      rejected.push(file);
      continue;
    }
    normalized.push(relative);
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

async function defaultResolveConfig(root: string): Promise<{ config: ImpactEvidenceConfig; tampered: boolean }> {
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
    if (loadConfigOverride) {
      config = await loadConfigOverride(request.root);
    } else {
      const resolved = await defaultResolveConfig(request.root);
      config = resolved.config;
      tampered = resolved.tampered;
    }
    const hookClass = impactEvidenceHookClass(config.strict);

    const { files, rejected } = normalizeRequestFiles(request.root, request.files);
    const extraWarnings: string[] = [];

    if (rejected.length > 0) {
      await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "path-rejected",
        files: rejected,
      });
      extraWarnings.push(`skipped ${rejected.length} path(s) outside the project root: ${rejected.join(", ")}`);
    }

    if (tampered) {
      await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "config-tampered",
        files,
      });
      extraWarnings.push(
        "impact-evidence config checksum did not verify (or the config could not be read) — ignoring the stored block and using safe defaults",
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
    await saveSessionState(request.root, request.sessionId, { touched: state.touched, denials });
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
  // F17 (review round 1): dampening used to be an ALL-OR-NOTHING call over
  // the whole batch (`.some(...)`) — one repeatedly-denied file collapsed the
  // evidence for every OTHER first-touch file in the same batch too, even
  // one that had never been denied. Split per file instead: a dampened file
  // gets the condensed notice, every other first-touch file in the batch
  // still gets its full evidence block.
  const dampenedFiles = firstTouch.filter((file) => (denials[file] ?? 0) >= dampenAfter);
  const normalFiles = firstTouch.filter((file) => (denials[file] ?? 0) < dampenAfter);

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
          reason: "hook-failed",
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
  if (dampenedFiles.length > 0) {
    parts.push(
      `Impact evidence dampened after repeated denials for: ${dampenedFiles.join(", ")}. Proceed with care — evidence is still available via \`keryx security impact-evidence test\`.`,
    );
  }
  const additionalContext = parts.join("\n\n");
  const event: ImpactEvidenceLogEvent = dampenedFiles.length > 0 ? "dampened" : "injected";

  // Strict mode: an injection needs an acknowledgement before it is
  // allowed to proceed.
  if (config.strict && (!request.acknowledgement || request.acknowledgement.trim().length === 0)) {
    const record = await appendLogRecord(request.root, {
      sessionId: request.sessionId,
      event,
      files: firstTouch,
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
  await saveSessionState(request.root, request.sessionId, { touched: newTouched, denials });

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
