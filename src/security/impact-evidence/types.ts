// Flow 308 (W8, Lane B, T6): types for the impact-evidence gate.
//
// Core zone (`src/lib/import-zones.ts`) — pure types, no logic, no I/O, and
// no import from `src/harness` (client zone) or `src/commands`/`src/mcp`
// (adapter zone). `ImpactEvidenceProfile` is intentionally a plain string
// union rather than importing whatever profile type the harness runtime
// carries — see the note on that type below.

/**
 * The three postures a caller of the impact-evidence gate can be running
 * under. This is a STRUCTURAL type local to this module — it does not import
 * a profile type from `src/harness` (client zone), which this core module may
 * never import from. A future harness-side profile type is expected to be a
 * (possibly wider) enum that maps onto these three names; that mapping is
 * the harness integration's job, not this module's.
 */
export type ImpactEvidenceProfile = "read-only-review" | "monitored-trusted-local" | "unattended-untrusted";

/**
 * `gate-advisory` never blocks — it can only allow (optionally with an "ask"
 * outcome the caller may choose to honor or not) and surface context.
 * `gate` (strict mode) can produce a hard `ask`/`deny` the caller must honor.
 */
export type ImpactEvidenceHookClass = "gate-advisory" | "gate";

export type ImpactEvidenceOutcome = "allow" | "ask" | "deny";

/** Named, stable reasons a decision carries — never free text a caller must parse. */
export type ImpactEvidenceReason =
  | "rollback-line-required"
  | "acknowledgement-required"
  | "hook-advisory-failed"
  // N5 (review round 2): aligned with W6's failure-table names. A `gate`
  // (strict) hook class fails CLOSED on any service/parse failure, in EVERY
  // profile, with THIS reason — W6's name for a gate hook crash.
  // `hook-advisory-failed` stays reserved for `gate-advisory` denying under
  // `unattended-untrusted` specifically (the pre-existing behavior).
  // `hook-timeout` is reserved for a future timeout distinction and unused
  // here.
  | "hook-crashed"
  | "hook-timeout"
  // F14 (review round 2): a request whose files were ALL rejected by
  // containment (or, under a gate class, any rejected) does not fall through
  // to allow — `gate`/`unattended-untrusted` deny with this reason.
  | "path-outside-root";

/** Named, stable events the append-only log records (see `state.ts`). */
export type ImpactEvidenceLogEvent =
  | "injected"
  | "skipped-repeat"
  | "skipped-exempt"
  | "dampened"
  | "disabled-env"
  | "disabled-config"
  | "rollback-required"
  | "rollback-accepted"
  | "service-failed"
  // F11 (review round 1/2): the config's `impactEvidence` block is not
  // provably the operator's own — no checksum was ever recorded, or the
  // recorded one does not match — while the resolved block would otherwise
  // have disabled the gate or loosened it. The untrusted block was ignored in
  // favor of safe defaults. See `config.ts#resolveImpactEvidenceConfigTrusted`.
  // Renamed from "config-tampered" (round 1) to "config-untrusted" (round 2)
  // because an ABSENT checksum is not tampering, just never-sealed — the
  // record's `detail` field ("absent" | "mismatch") keeps the two
  // distinguishable.
  | "config-untrusted"
  // F14 (review round 1): a request named a file that normalizes outside
  // `root` — dropped rather than fed to the evidence builder. See
  // `provider.ts#normalizeRequestFiles`.
  | "path-rejected"
  // A harmless decision (a non-destructive shell command) that carries no
  // information worth appending to the durable log — present ONLY on the
  // in-memory `ImpactEvidenceDecision.record` returned to the caller, never
  // written to `log.jsonl` (see `provider.ts`). Kept in this union rather
  // than a second type so `record` always has one shape.
  | "not-applicable";

export interface ImpactEvidenceLogRecord {
  at: string;
  sessionId: string;
  event: ImpactEvidenceLogEvent;
  files: string[];
  detail?: string;
}

export interface AffectedEvidenceSection {
  status: "ok" | "not-indexed" | "index-incomplete";
  // The exact JSON text `buildAffectedReport`/`keryx gdgraph affected --json`
  // would print for this file, verbatim (AC9) — never re-serialized or
  // re-derived, so the two can never drift.
  json: string;
}

export interface RelatedTestsEvidenceSection {
  status: "complete" | "incomplete";
  // The exact JSON text `buildRelatedTestsReport` produces, verbatim.
  json: string;
}

export interface MemoryCaveatEntry {
  entry: string; // memory entry relativePath
  caveat: string;
}

export interface ImpactEvidence {
  file: string;
  importers: AffectedEvidenceSection;
  relatedTests: RelatedTestsEvidenceSection;
  memoryCaveats: MemoryCaveatEntry[];
}

export interface ImpactEvidenceRequest {
  root: string;
  sessionId: string;
  toolName: string;
  files: string[];
  command?: string;
  profile: ImpactEvidenceProfile;
  acknowledgement?: string;
  rollbackLine?: string;
  // Set by the caller when the PREVIOUS prompt for one of `files` was denied
  // — used for denial dampening (see `provider.ts`).
  denied?: boolean;
  env?: Record<string, string | undefined>;
  now?: Date;
}

export interface ImpactEvidenceDecision {
  hookId: "keryx.impact-evidence";
  hookClass: ImpactEvidenceHookClass;
  outcome: ImpactEvidenceOutcome;
  additionalContext?: string;
  reason?: ImpactEvidenceReason;
  warnings: string[];
  record: ImpactEvidenceLogRecord;
}

export const IMPACT_EVIDENCE_HOOK_ID = "keryx.impact-evidence" as const;
