// Deterministic policy engine types (flow 009, W7 / S3, task-M-01 / task-R0-02
// / task-CA-01 / task-FI-01).
//
// These types pin the policy/containment contract specified in
// `docs/requirements/keryx-project-agent-harness/specification.md`
// ("Policy Decision"), the frozen `policy-profile.schema.json` /
// `harness-policy-decision.schema.json`, and
// `docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md`
// (fail-closed posture; hard denies terminal; `override = false` const).
//
// They are deliberately side-effect-free: no clock, randomness, network, or
// filesystem surface is exposed here (see `engine.ts` for the deterministic
// `decide`/`contextIsPolicyTrusted` functions that consume them).

/** The three mutually-exclusive policy outcomes. */
export type PolicyOutcome = "allow" | "ask" | "deny";

/** The three frozen security profile identities (ADR-0003 profile matrix). */
export type PolicyProfileId =
  | "read-only-review"
  | "monitored-trusted-local"
  | "unattended-untrusted";

/** Trust posture of a profile (`policy-profile.schema.json#/properties/trustMode`). */
export type PolicyTrustMode = "read-only" | "trusted-local" | "untrusted";

/**
 * Per-capability default outcomes
 * (`policy-profile.schema.json#/properties/defaults`). These five keys are the
 * only risk classes the profile assigns a baseline for; `credential` and
 * `destructive` are derived from the mutation-sensitive baseline in `engine.ts`.
 */
export interface PolicyProfileDefaults {
  read: PolicyOutcome;
  write: PolicyOutcome;
  shell: PolicyOutcome;
  network: PolicyOutcome;
  delegate: PolicyOutcome;
}

/**
 * Fail-closed control requirements
 * (`policy-profile.schema.json#/properties/requiredControls`). `redactionFailure`
 * and `networkBrokerFailure` are pinned to `deny` by the frozen schema.
 */
export interface PolicyProfileRequiredControls {
  isolation: "not-required" | "required-fail-closed";
  redactionFailure: "deny";
  networkBrokerFailure: "deny";
}

/** A frozen security profile (`policy-profile.schema.json`). */
export interface PolicyProfile {
  schemaVersion: number;
  profileId: PolicyProfileId;
  profileVersion: string;
  fingerprint: string;
  trustMode: PolicyTrustMode;
  defaults: PolicyProfileDefaults;
  requiredControls: PolicyProfileRequiredControls;
}

/**
 * A recorded approval grant. An approval only authorizes an `ask` outcome into
 * `allow` when it is bound to the *current* action fingerprint
 * (`grantedForFingerprint === ctx.actionFingerprint`) and has not been consumed
 * (single-use approvals are terminal once `consumed`).
 */
export interface Approval {
  approvalId: string;
  actionFingerprint: string;
  grantedForFingerprint: string;
  singleUse: boolean;
  consumed: boolean;
}

/**
 * The evaluation context for a single `decide` call. `role` is an advisory
 * string only — it is NEVER used to grant authority the profile forbids
 * (SC_R08_ROLE_CANNOT_ESCALATE). `targetPath`, when present, is checked against
 * the managed flow-state guard (SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED).
 */
export interface PolicyContext {
  profile: PolicyProfile;
  role?: string;
  interactive: boolean;
  approvals: Approval[];
  actionFingerprint: string;
  targetPath?: string;
}

/**
 * Deterministic dependencies for `decide`: a fixed clock and a monotonic id
 * sequence. No `Date.now`/`Math.random`/network is used anywhere in the engine.
 */
export interface PolicyDeps {
  clock: () => string;
  idSeq: () => string;
}

/**
 * The pinned (base) policy decision shape. The durable wire record
 * (`harness-policy-decision.schema.json`) additionally carries
 * `hardDeny`/`override`/`approvalId`/`policyFingerprint`/`actionFingerprint`/
 * `provenanceId`/`redaction`/`role` — those are emitted on the returned object
 * (see {@link PolicyDecisionWire}) so it validates, while the pinned API surface
 * stays exactly these fields.
 */
export interface PolicyDecision {
  schemaVersion: number;
  decisionId: string;
  toolCallId: string;
  decision: PolicyOutcome;
  policyProfile: string;
  timestamp: string;
  matchedRules: string[];
  reason?: string;
}

/** Redaction states (`harness-policy-decision.schema.json#/properties/redaction`). */
export type PolicyRedaction = "not-needed" | "applied" | "failed-safe";

/**
 * The full wire projection emitted by `decide`. Superset of {@link PolicyDecision}
 * with the schema-required conditional fields. `override` is the frozen `false`
 * constant; when `hardDeny === true` the schema forces `decision === "deny"`.
 */
export interface PolicyDecisionWire extends PolicyDecision {
  policyFingerprint?: string;
  actionFingerprint?: string;
  provenanceId?: string;
  role?: string;
  approvalId?: string;
  hardDeny?: boolean;
  override?: false;
  redaction?: PolicyRedaction;
}

/** Reliability grades a context source can carry (mirrors the manifest enum). */
export type PolicyTrustReliability = "exact" | "estimated" | "unknown";

/**
 * The minimal trust-classification view of a context source consumed by
 * {@link contextIsPolicyTrusted}. Mirrors the manifest's per-source shape
 * (`src/harness/context/manifest.ts` `ContextManifestSource`) plus an explicit
 * `stale` freshness flag. All fields are optional so that a missing/absent
 * classification fails closed (never policy-trusted).
 */
export interface PolicyTrustSource {
  reliability?: PolicyTrustReliability;
  trustedAsPolicy?: boolean;
  stale?: boolean;
}
