// Deterministic policy engine + context-trust guard (flow 009, W7 / S3,
// task-M-01 / task-R0-02 / task-CA-01 / task-FI-01).
//
// `decide` resolves exactly one policy outcome (allow/ask/deny) for a tool call
// under a frozen security profile, and `contextIsPolicyTrusted` guards whether a
// context source may act as policy. Both are deterministic and side-effect-free:
// clock and id sequence arrive via `deps`; there is NO `Date.now`,
// `Math.random`, network, or filesystem mutation anywhere in this module.
//
// Behaviour (per the frozen `harness-policy-decision.schema.json`, ADR-0003, and
// the acceptance scenarios pinned in `engine.test.ts`):
//   - Baseline: the profile's per-capability default decides allow/ask/deny.
//   - Hard deny: a `write`/`shell`/`network`/`delegate` risk that the profile
//     defaults to `deny` is a terminal hard deny — no approval, role, or
//     interactivity can flip it (`hardDeny: true`, `override: false`).
//   - Flow-file guard: a call targeting `flow.json` / managed flow-state is
//     denied regardless of a present, matching approval.
//   - Headless fail-closed: an outcome that would be `ask` becomes `deny` when
//     the context is non-interactive (never a silent allow).
//   - Stale/consumed approvals: an approval only authorizes `ask -> allow` when
//     it is bound to the current `actionFingerprint` and not consumed.
//   - Role no-escalate: `ctx.role` is advisory only and never grants authority
//     the profile forbids.
import path from "node:path";
import type { ToolRisk } from "../tool/types";
import type {
  Approval,
  PolicyContext,
  PolicyDecision,
  PolicyDecisionWire,
  PolicyDeps,
  PolicyOutcome,
  PolicyProfileDefaults,
  PolicyTrustSource,
} from "./types";

/**
 * The mutation-adjacent risks that become a terminal *hard deny* when the active
 * profile defaults them to `deny` (ADR-0003: hard denies are unoverridable).
 */
const HARD_DENY_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "write",
  "shell",
  "network",
  "delegate",
]);

/**
 * Resolve the profile's baseline outcome for a risk class. The five profile
 * `defaults` keys map directly; `credential` and `destructive` have no default
 * of their own and are treated as at-least-as-restrictive as `write` — they
 * never auto-allow (a `write=allow` profile still forces them to `ask`).
 */
function baseOutcomeFor(risk: ToolRisk, defaults: PolicyProfileDefaults): PolicyOutcome {
  switch (risk) {
    case "read":
      return defaults.read;
    case "write":
      return defaults.write;
    case "shell":
      return defaults.shell;
    case "network":
      return defaults.network;
    case "delegate":
      return defaults.delegate;
    case "credential":
    case "destructive":
      return defaults.write === "allow" ? "ask" : defaults.write;
    default: {
      // Exhaustiveness guard: an unknown risk fails closed to `deny`.
      const _exhaustive: never = risk;
      return "deny";
    }
  }
}

/**
 * True when the risk is one of the mutation-adjacent classes AND the profile
 * defaults it to `deny` — a terminal hard deny that nothing can override.
 */
function isHardDeny(risk: ToolRisk, defaults: PolicyProfileDefaults): boolean {
  if (!HARD_DENY_RISKS.has(risk)) return false;
  return baseOutcomeFor(risk, defaults) === "deny";
}

/**
 * True when `targetPath` points at a managed flow-state file (`flow.json` or any
 * `.json` under a `flows/` directory). Such targets are never writable through
 * the harness, even with a present, matching approval
 * (SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED). Pure string inspection — no fs access.
 */
function isManagedFlowFile(targetPath: string | undefined): boolean {
  if (targetPath === undefined || targetPath.length === 0) return false;
  if (path.basename(targetPath) === "flow.json") return true;
  return /(^|[\\/])flows[\\/].+\.json$/.test(targetPath);
}

/**
 * True when some approval in context validly authorizes the current action: it
 * was granted for the *current* action fingerprint and is not a consumed
 * single-use grant. A stale approval (granted for a different fingerprint) or a
 * consumed single-use approval does NOT authorize.
 */
function hasValidApproval(ctx: PolicyContext): Approval | undefined {
  return ctx.approvals.find(
    (approval) =>
      approval.grantedForFingerprint === ctx.actionFingerprint &&
      !(approval.singleUse && approval.consumed),
  );
}

interface BuildArgs {
  decision: PolicyOutcome;
  matchedRules: string[];
  reason: string;
  hardDeny: boolean;
  approvalId?: string;
  provenanceId?: string;
}

/**
 * Assemble a schema-valid wire decision. Only keys allowed by
 * `harness-policy-decision.schema.json` (`additionalProperties: false`) are
 * emitted. `override` is the frozen `false` constant; `approvalId`/`provenanceId`
 * are supplied on the `ask` path (schema-required there).
 */
function buildDecision(
  call: { toolCallId: string },
  ctx: PolicyContext,
  deps: PolicyDeps,
  decisionId: string,
  timestamp: string,
  args: BuildArgs,
): PolicyDecision {
  const wire: PolicyDecisionWire = {
    schemaVersion: 1,
    decisionId,
    toolCallId: call.toolCallId,
    decision: args.decision,
    policyProfile: ctx.profile.profileId,
    policyFingerprint: ctx.profile.fingerprint,
    actionFingerprint: ctx.actionFingerprint,
    timestamp,
    matchedRules: args.matchedRules,
    reason: args.reason,
    hardDeny: args.hardDeny,
    override: false,
    redaction: "not-needed",
  };
  if (ctx.role !== undefined && ctx.role.length > 0) {
    wire.role = ctx.role;
  }
  if (args.approvalId !== undefined) {
    wire.approvalId = args.approvalId;
  }
  if (args.provenanceId !== undefined) {
    wire.provenanceId = args.provenanceId;
  }
  return wire;
}

/**
 * Resolve exactly one deterministic policy outcome for `call` under `ctx`.
 *
 * Precedence (fail-closed): hard deny -> managed flow-file guard -> profile
 * baseline (deny/allow) -> approval-authorized allow -> headless fail-closed
 * deny -> ask. `deps.clock`/`deps.idSeq` make the emitted record deterministic.
 */
export function decide(call: { toolCallId: string; risk: ToolRisk }, ctx: PolicyContext, deps: PolicyDeps): PolicyDecision {
  const { profile } = ctx;
  const { defaults } = profile;
  const risk = call.risk;
  const decisionId = deps.idSeq();
  const timestamp = deps.clock();

  const build = (args: BuildArgs): PolicyDecision =>
    buildDecision(call, ctx, deps, decisionId, timestamp, args);

  // 1. Hard deny — terminal, unoverridable by approval, role, or interactivity.
  if (isHardDeny(risk, defaults)) {
    return build({
      decision: "deny",
      matchedRules: [`hard-deny:${risk}`, `profile:${profile.profileId}`],
      reason: `Hard deny: ${risk} is forbidden under ${profile.profileId} and cannot be overridden.`,
      hardDeny: true,
    });
  }

  // 2. Managed flow-state guard — denied regardless of any matching approval.
  if (isManagedFlowFile(ctx.targetPath)) {
    return build({
      decision: "deny",
      matchedRules: ["flow-file-protection", `profile:${profile.profileId}`],
      reason: "Direct mutation of managed flow-state (flow.json) is never permitted.",
      hardDeny: false,
    });
  }

  const base = baseOutcomeFor(risk, defaults);

  // 3. Profile baseline deny (e.g. credential/destructive under read-only).
  if (base === "deny") {
    return build({
      decision: "deny",
      matchedRules: [`profile:${profile.profileId}:${risk}=deny`],
      reason: `Denied by ${profile.profileId} default for ${risk}.`,
      hardDeny: false,
    });
  }

  // 4. Profile baseline allow.
  if (base === "allow") {
    return build({
      decision: "allow",
      matchedRules: [`profile:${profile.profileId}:${risk}=allow`],
      reason: `Allowed by ${profile.profileId} default for ${risk}.`,
      hardDeny: false,
    });
  }

  // 5. base === "ask": a valid approval bound to the current fingerprint
  //    authorizes allow. Role is never consulted (no self-escalation).
  const approval = hasValidApproval(ctx);
  if (approval !== undefined) {
    return build({
      decision: "allow",
      matchedRules: [`approval:${approval.approvalId}`, `profile:${profile.profileId}:${risk}=ask`],
      reason: `Approved by valid grant ${approval.approvalId} for the current action fingerprint.`,
      hardDeny: false,
    });
  }

  // 6. Headless fail-closed: an ask without a live approver becomes deny.
  if (ctx.interactive === false) {
    return build({
      decision: "deny",
      matchedRules: ["headless-fail-closed", `profile:${profile.profileId}:${risk}=ask`],
      reason: `Approval required for ${risk} but the session is non-interactive; failing closed.`,
      hardDeny: false,
    });
  }

  // 7. Interactive ask — request approval. Schema requires approvalId +
  //    provenanceId here; both are deterministic ids from `deps.idSeq`.
  const approvalId = deps.idSeq();
  const provenanceId = deps.idSeq();
  return build({
    decision: "ask",
    matchedRules: [`profile:${profile.profileId}:${risk}=ask`],
    reason: `Approval required for ${risk} under ${profile.profileId}.`,
    hardDeny: false,
    approvalId,
    provenanceId,
  });
}

/**
 * Guard whether a context source may act as policy (SC_R07). Fail closed: a
 * source is policy-trusted ONLY when it is fresh (`stale !== true`), explicitly
 * `trustedAsPolicy`, and of exact reliability. Stale, untrusted, low-reliability
 * (`estimated`/`unknown`), or missing-field sources are never policy-trusted.
 */
export function contextIsPolicyTrusted(source: PolicyTrustSource): boolean {
  if (source.stale === true) return false;
  if (source.trustedAsPolicy !== true) return false;
  return source.reliability === "exact";
}
