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
//   - W6 only calls this port on a session's FIRST edit of a file (or, since
//     fix round 3 F-001, the first edit of ANY file in a multi-file
//     `apply_patch` call — `ImpactEvidenceInput.firstEditInSession` is always
//     `true` by construction, `runtime.ts`'s `runBuiltinHook` never calls the
//     port otherwise), and only ever registers it `class: "gate-advisory"`
//     (`builtins.ts`'s `IMPACT_EVIDENCE` registration, matcher `Write|Edit`).
//   - Fix round 3, F-003: W8's own escalating outcomes are no longer folded
//     into one. `"ask"` maps to `decision: "ask"`; a W8 `"deny"` (its own
//     strict/gate class, or a rejected path) maps to `decision: "deny"` —
//     previously both mapped to `"ask"`, which let an operator APPROVE what
//     W8 strict mode requires to fail closed. `"allow"` still maps to `{}`
//     (no decision) — matching W8's own CLI codec
//     (`commands/security-impact-evidence.ts`), which treats `"allow"` as
//     "defer to the host's own prompt", never as an auto-approve. W8's
//     `warnings` (e.g. a rejected out-of-root path folded to a warning
//     rather than a decision) are forwarded rather than dropped.
//   - Fix round 4, F-001: `input.acknowledgement` (set only when
//     `HookRuntime.acknowledgeImpactEvidence` recorded an interactive
//     operator approval for every file in this call) is forwarded to W8's
//     own `ImpactEvidenceRequest.acknowledgement`. Before this, strict mode
//     re-asked about the same file on every subsequent edit for the rest of
//     the session — an operator's approval of the hook's `ask` was never
//     distinguishable, on W8's side, from a file nobody had ever been asked
//     about. Still never a fabricated rollback line or any other content the
//     operator would have to type (see the F19 note in
//     `security/impact-evidence/index.ts`) — a plain approval marker only,
//     which is all W8's `acknowledgement` field requires (any non-empty
//     string).
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
//     driftable copy. The one exception is the raw `env` map W8's kill-switch
//     check itself reads (`provider.ts`'s `killSwitchEnabled`): an explicit
//     `opts.env` is forwarded so a caller (a test, or a future per-session
//     override) never has to mutate the real `process.env` global to flip it
//     — `createShellImpactEvidenceProvider`'s own callers
//     (`commands/agent-hooks.ts`, `lib/serve-turn.ts`) already resolve an
//     `env` for `KERYX_HOOKS`; this just reuses that same resolved value
//     instead of letting `provider.ts` fall back to `process.env` on its own.
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
  /**
   * Fix round 3 (F-005/hermeticity): the same resolved env `KERYX_HOOKS` is
   * already checked against (`buildShellHookRuntime`'s `env` local,
   * `buildRemoteHookRuntime`'s), forwarded to W8's own `KERYX_DISABLE_IMPACT_GATE`
   * kill-switch check (`provider.ts`'s `killSwitchEnabled`) instead of
   * letting it read the real `process.env` on its own. Absent (every
   * existing call site before this field existed) ⇒ `provider.ts` falls back
   * to `process.env` itself, byte-identical to before.
   */
  env?: Record<string, string | undefined>;
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
    files: input.files,
    profile: opts.profile,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    // Fix round 4, F-001: forwards the runtime's own interactive-approval
    // record (`HookRuntime.acknowledgeImpactEvidence`, `builtins.ts`'s
    // `ImpactEvidenceInput.acknowledgement`) into W8's own acknowledgement
    // field — without this an approved `ask` was never distinguishable from
    // one that was never asked about, so W8 strict mode re-asked forever.
    ...(input.acknowledgement !== undefined ? { acknowledgement: input.acknowledgement } : {}),
  };
}

function toHookResult(decision: ImpactEvidenceDecision): ImpactEvidenceResult {
  const result: ImpactEvidenceResult = {};
  if (decision.additionalContext !== undefined) {
    result.additionalContext = decision.additionalContext;
  }
  // Fix round 3, F-003: W8's two escalating outcomes are no longer folded
  // into one. "ask" stays an approval ask; W8's own "deny" (its strict/gate
  // class, or a rejected path) now maps to a real "deny" instead of being
  // silently loosened to something an operator could approve.
  if (decision.outcome === "ask" || decision.outcome === "deny") {
    result.decision = decision.outcome;
  }
  if (decision.warnings.length > 0) {
    result.warnings = decision.warnings;
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
