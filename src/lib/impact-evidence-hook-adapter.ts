// Flow 306 (W6, T20): wires W8's impact-evidence gate
// (`src/security/impact-evidence`, reached only through its facade,
// `src/security/service.ts`) behind W6's `keryx.impact-evidence` hook port
// (`ImpactEvidenceProvider`, `src/harness/hooks/builtins.ts`).
//
// Lives in `src/lib/` (the shared zone, `src/lib/import-zones.ts`) rather than
// `src/commands/agent-hooks.ts` (adapter zone): `src/lib/serve-turn.ts`'s
// `buildRemoteHookRuntime` needs the exact same wiring for a remote turn, and
// `lib/` may not import from `commands/` (see that function's own doc
// comment) — putting the adapter in `commands/` would leave the remote-turn
// caller unable to reach it. `lib/` importing both `security` (core) and
// `harness/hooks` (client) is unrestricted by the zone table itself (shared
// is "not itself restricted by this table"), and `lib/serve-turn.ts` already
// imports `security/service.ts` for the same reason.
//
// MAPPING
//
//   - W6 only calls this port on a session's FIRST edit of a file
//     (`ImpactEvidenceInput.firstEditInSession` is always `true` by
//     construction — `runtime.ts`'s `runBuiltinHook` never calls the port
//     otherwise), and only ever registers it `class: "gate-advisory"`
//     (`builtins.ts`'s `IMPACT_EVIDENCE` registration, matcher `Write|Edit`).
//     So a hard `deny` has no home in `ImpactEvidenceResult` (only
//     `decision?: "ask"` exists) — both of W8's escalating outcomes
//     (`"ask"` and, under its own `gate`/strict class or a rejected path,
//     `"deny"`) map to `decision: "ask"` here, never silently down to
//     nothing. `"allow"` maps to `{}` (no decision) — matching W8's own CLI
//     codec (`commands/security-impact-evidence.ts`), which treats `"allow"`
//     as "defer to the host's own prompt", never as an auto-approve.
//   - A rejected/thrown provider call is NOT caught here: it propagates out
//     of `evidenceFor`, so W6's `runOneHook` routes it through the same
//     `buildFailureOutcome("crash", …)` gate-advisory-failure path every
//     other builtin-port failure already uses (T5's own crash-handling,
//     untouched by this file).
//   - The kill switch (`KERYX_DISABLE_IMPACT_GATE`) and the
//     `.metaproject/security.config.json` `impactEvidence` block
//     (enabled/strict/exemptGlobs/dampenAfter, with its checksum-trust check)
//     are NOT read here — `createImpactEvidenceProvider()` already resolves
//     and honors them internally. Reading them again here would be a second,
//     driftable copy.
//
// KNOWN LIMITATION — see `CreateShellImpactEvidenceProviderOptions.profile`'s
// own doc comment: `ImpactEvidenceInput` carries no per-fire policy profile,
// so this adapter is built once, with whatever profile the hook runtime was
// CONSTRUCTED under, not re-derived per call. Fixing that needs
// `runtime.ts`'s `runBuiltinHook` to forward its own `fireProfileId` into
// `ImpactEvidenceInput` — `src/harness/hooks/*` is off limits for this task
// (owned by T5) — so it is left as a documented follow-up rather than reached
// around.
import {
  createImpactEvidenceProvider,
  type ImpactEvidenceDecision,
  type ImpactEvidenceProfile,
  type ImpactEvidenceRequest,
} from "../security/service";
import type { ImpactEvidenceInput, ImpactEvidenceProvider, ImpactEvidenceResult } from "../harness/hooks/builtins";

export interface CreateShellImpactEvidenceProviderOptions {
  /** The project root W8's gate scopes config, session state, and its log to. */
  root: string;
  /**
   * The policy profile this hook runtime was built under
   * (`PolicyProfileId`'s three literals are byte-identical to
   * `ImpactEvidenceProfile`'s, so a caller's `PolicyProfileId` value is
   * accepted here without a cast). Captured once at construction time — see
   * this module's own KNOWN LIMITATION note: a live per-fire profile change
   * (e.g. the `/plan` read-only toggle, `FireContext.profileId`) is NOT
   * reflected in a request built from an already-constructed provider.
   */
  profile: ImpactEvidenceProfile;
  /** Injectable for tests; defaults to a real `createImpactEvidenceProvider()`. */
  provider?: (request: ImpactEvidenceRequest) => Promise<ImpactEvidenceDecision>;
}

function toImpactEvidenceRequest(
  opts: CreateShellImpactEvidenceProviderOptions,
  input: ImpactEvidenceInput,
): ImpactEvidenceRequest {
  return {
    root: opts.root,
    sessionId: input.sessionId,
    toolName: input.toolName,
    files: [input.filePath],
    profile: opts.profile,
  };
}

function toHookResult(decision: ImpactEvidenceDecision): ImpactEvidenceResult {
  const result: ImpactEvidenceResult = {};
  if (decision.additionalContext !== undefined) {
    result.additionalContext = decision.additionalContext;
  }
  // W6's port can only escalate to "ask" at this slot (gate-advisory, never a
  // hard deny) — map both of W8's escalating outcomes ("ask", and "deny" from
  // its own strict/gate class or a rejected path) onto it, rather than
  // dropping a "deny" verdict down to allow.
  if (decision.outcome === "ask" || decision.outcome === "deny") {
    result.decision = "ask";
  }
  return result;
}

/**
 * Build the production `keryx.impact-evidence` port: W8's
 * `createImpactEvidenceProvider()` behind W6's `ImpactEvidenceProvider`
 * shape. Wired as the default `ports.impactEvidence` for every real session
 * (`commands/agent-hooks.ts`'s `buildShellHookRuntime`, `lib/serve-turn.ts`'s
 * `buildRemoteHookRuntime`); tests keep injecting fakes/the NOOP port
 * directly, and never need this factory.
 */
export function createShellImpactEvidenceProvider(
  opts: CreateShellImpactEvidenceProviderOptions,
): ImpactEvidenceProvider {
  const provider = opts.provider ?? createImpactEvidenceProvider();
  return {
    async evidenceFor(input: ImpactEvidenceInput): Promise<ImpactEvidenceResult> {
      const decision = await provider(toImpactEvidenceRequest(opts, input));
      return toHookResult(decision);
    },
  };
}
