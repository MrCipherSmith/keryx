// Core types for the `keryx shell` lifecycle hook runtime (flow 306, W6, T5).
//
// Pins the shape workstreams/W6-shell-hooks.md and
// docs/requirements/keryx-agent-platform-expansion/schemas/hook-config.schema.json
// describe: ten named lifecycle events, a resolved (post-merge) hook
// registration, per-event stdin payload shapes, the session-record invocation
// entry, and the named warning/anomaly reasons the rest of this package
// produces. Deliberately side-effect-free: no clock, randomness, network, or
// filesystem surface is exposed here.
import type { PolicyOutcome, PolicyProfileId } from "../policy/types";

/** The ten lifecycle events `keryx shell`'s hook runtime fires. */
export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "SessionEnd";

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
];

/**
 * Events whose composed hook decision can tighten the surrounding outcome
 * (W6-AC1 / Design > "Composition with the policy engine"). Every other event
 * is observe/context-only: a `decision` field from a hook on one of those is
 * dropped and recorded as `hook-decision-ignored`.
 */
export const GATE_CAPABLE_EVENTS: readonly HookEventName[] = [
  "PreToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
];

/** Events whose `matcher` is a regex over a tool name (all others must be `"*"`). */
export const PER_TOOL_EVENTS: readonly HookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
];

/**
 * `gate`: fail-closed in every profile, decision honoured on a gate-capable
 * event. `gate-advisory`: same tightening power when it runs, profile-aware
 * failure semantics. `observe`: side-effect-only, decision never honoured,
 * always fail-open. `context`: may add `additionalContext`, never a decision,
 * always fail-open.
 */
export type HookClass = "gate" | "gate-advisory" | "observe" | "context";

/** Where a resolved registration came from, in merge precedence order. */
export type HookScope = "builtin" | "user" | "project";

/** A hook spawned as an external command (argv only, never shell-interpolated). */
export interface HookCommandHandler {
  kind: "command";
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * A built-in hook whose behaviour is invoked in-process through a port
 * (`builtins.ts`). Never user/project-configurable — only the five built-in
 * declarations use this handler kind.
 */
export interface HookBuiltinHandler {
  kind: "builtin";
  name: string;
}

export type HookHandler = HookCommandHandler | HookBuiltinHandler;

/**
 * A fully resolved hook registration, after config-file parsing and merge
 * (`config.ts`). This is the runtime shape `runtime.ts` selects and executes
 * from — distinct from the raw `hook-config.schema.json` document shape.
 */
export interface HookRegistration {
  /** Unique within one event's list after merge (`keryx.<name>` for built-ins). */
  id: string;
  event: HookEventName;
  /** Regex source over the tool name for per-tool events; `"*"` otherwise. */
  matcher: string;
  class: HookClass;
  handler: HookHandler;
  timeoutMs: number;
  runsIn: "sandbox" | "unsandboxed";
  network: "none" | "restricted";
  appliesToChildAgents: boolean;
  /** Empty/omitted means active under every profile. */
  profiles: PolicyProfileId[];
  enabled: boolean;
  scope: HookScope;
  /** Deterministic tie-break within (scope, event): builtin fixed order, then file order. */
  order: number;
  description?: string;
}

/** Fields every hook stdin payload carries, regardless of event. */
export interface HookPayloadBase {
  schemaVersion: string;
  timestamp: string;
  hookId: string;
  event: HookEventName;
  sessionId: string;
  runId: string;
}

export interface SessionStartPayload extends HookPayloadBase {
  event: "SessionStart";
  projectRoot: string;
  policyProfile: string;
  contextHash?: string;
  provider?: string;
  model?: string;
}

export interface UserPromptSubmitPayload extends HookPayloadBase {
  event: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUsePayload extends HookPayloadBase {
  event: "PreToolUse";
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  risk?: string;
  policyProfile: string;
}

export interface PostToolUsePayload extends HookPayloadBase {
  event: "PostToolUse";
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  policyDecision?: string;
}

export interface PostToolUseFailurePayload extends HookPayloadBase {
  event: "PostToolUseFailure";
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  error: { message: string; code?: string };
}

export interface PreCompactPayload extends HookPayloadBase {
  event: "PreCompact";
  reason: "auto" | "manual";
  tokenCount?: number;
}

export interface StopPayload extends HookPayloadBase {
  event: "Stop";
  stopReason?: string;
}

export interface SubagentStartPayload extends HookPayloadBase {
  event: "SubagentStart";
  subagentId: string;
  parentSessionId: string;
  spawnKind: "external" | "internal";
  inheritedHookIds: string[];
}

export interface SubagentStopPayload extends HookPayloadBase {
  event: "SubagentStop";
  subagentId: string;
  outcome: string;
  escalationStop?: string;
}

export interface SessionEndPayload extends HookPayloadBase {
  event: "SessionEnd";
  endReason: string;
}

export type HookPayload =
  | SessionStartPayload
  | UserPromptSubmitPayload
  | PreToolUsePayload
  | PostToolUsePayload
  | PostToolUseFailurePayload
  | PreCompactPayload
  | StopPayload
  | SubagentStartPayload
  | SubagentStopPayload
  | SessionEndPayload;

/** Why a hook invocation did not produce a usable exit-0 decision. */
export type HookFailureKind =
  | "timeout"
  | "crash"
  | "malformed"
  | "sandbox-unavailable"
  | "refused";

/**
 * One append-only record of a single hook invocation, mirrored into the
 * session-record stream as a `hook_invocation` entry (run.ts integration,
 * outside this module's scope).
 */
export interface HookInvocationRecord {
  hookId: string;
  event: HookEventName;
  class: HookClass;
  scope: HookScope;
  /** The hook's own decision, or `"none"` when it produced no decision. */
  outcome: PolicyOutcome | "none";
  failure?: HookFailureKind;
  reason?: string;
  durationMs: number;
  /** Whether this hook's decision changed the composed outcome. */
  changedOutcome: boolean;
  exitCode?: number;
}

/** Named warning/anomaly reasons this package can produce. */
export type HookAnomalyName =
  | "hook-timeout"
  | "hook-crashed"
  | "hook-malformed-output"
  | "hook-advisory-failed"
  | "hook-observer-failed"
  | "hook-context-failed"
  | "hook-decision-ignored"
  | "hook-attempted-input-rewrite"
  | "hook-context-truncated"
  | "hook-sandbox-unavailable"
  | "hook-id-collides-with-builtin";

export const HOOK_ANOMALY_NAMES: readonly HookAnomalyName[] = [
  "hook-timeout",
  "hook-crashed",
  "hook-malformed-output",
  "hook-advisory-failed",
  "hook-observer-failed",
  "hook-context-failed",
  "hook-decision-ignored",
  "hook-attempted-input-rewrite",
  "hook-context-truncated",
  "hook-sandbox-unavailable",
  "hook-id-collides-with-builtin",
];
