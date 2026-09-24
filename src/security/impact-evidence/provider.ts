// Flow 308 (W8, Lane B, T6): the impact-evidence gate provider — the
// function W6 will register at the `keryx.impact-evidence` hook slot (see
// `index.ts`'s doc comment). Pure composition over `evidence.ts` +
// `state.ts`; no host/harness wiring here.

import { isDestructiveCommand } from "../../lib/command-risk";
import { loadSecurityConfig, resolveImpactEvidenceConfig } from "../config";
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

export interface ImpactEvidenceProviderDeps {
  computeEvidence?: typeof computeImpactEvidence;
  loadConfig?: (root: string) => Promise<ImpactEvidenceConfig>;
}

async function defaultLoadConfig(root: string): Promise<ImpactEvidenceConfig> {
  const security = await loadSecurityConfig(root);
  return resolveImpactEvidenceConfig(security);
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
  const loadConfig = deps.loadConfig ?? defaultLoadConfig;

  return async function impactEvidenceProvider(request: ImpactEvidenceRequest): Promise<ImpactEvidenceDecision> {
    const env = request.env ?? (process.env as Record<string, string | undefined>);
    const config = await loadConfig(request.root);
    const hookClass = impactEvidenceHookClass(config.strict);

    // --- Kill switch: bypasses the rollback gate too, and is itself logged
    // so "disabled" is never confused with "ran and found nothing" (AC15).
    if (killSwitchEnabled(env)) {
      const record = await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "disabled-env",
        files: request.files,
      });
      return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
    }
    if (!config.enabled) {
      const record = await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "disabled-config",
        files: request.files,
      });
      return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
    }

    // --- Shell path: a command was given. `isDestructiveCommand` decides
    // whether a rollback line is required — EVERY time, not just on first
    // touch (AC13).
    if (request.command !== undefined) {
      if (isDestructiveCommand(request.command)) {
        const rollback = request.rollbackLine?.trim();
        if (!rollback) {
          const record = await appendLogRecord(request.root, {
            sessionId: request.sessionId,
            event: "rollback-required",
            files: request.files,
            detail: request.command,
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
          files: request.files,
          detail: request.command,
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
        files: request.files,
      };
      return { hookId: IMPACT_EVIDENCE_HOOK_ID, hookClass, outcome: "allow", warnings: [], record };
    }

    // --- Edit path: no command, one or more files.
    if (request.files.length === 0) {
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

    const exempt = request.files.filter(isExempt);
    const nonExempt = request.files.filter((f) => !isExempt(f));

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
      for (const file of request.files) {
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
    const isDampened = firstTouch.some((file) => (denials[file] ?? 0) >= dampenAfter);

    let evidences: ImpactEvidence[];
    try {
      evidences = await Promise.all(firstTouch.map((file) => computeEvidence(request.root, file)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = await appendLogRecord(request.root, {
        sessionId: request.sessionId,
        event: "service-failed",
        files: firstTouch,
        detail: message,
      });
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

    const additionalContext = isDampened
      ? `Impact evidence dampened after repeated denials for: ${firstTouch.join(", ")}. Proceed with care — evidence is still available via \`keryx security impact-evidence test\`.`
      : renderEvidenceBlock(evidences, firstTouch);
    const event: ImpactEvidenceLogEvent = isDampened ? "dampened" : "injected";

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
  };
}
