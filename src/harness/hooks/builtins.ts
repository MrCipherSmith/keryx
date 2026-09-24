// Keryx's five built-in hook declarations + their extension ports (flow 306,
// W6, T5). Fixed order, `keryx.`-namespaced ids so a project/user id can never
// collide with them (`config.ts` enforces that at load).
//
// Three are spawned commands (ctx-guard, the two security scans); two
// (`keryx.learning-observer`, `keryx.impact-evidence`) are the only
// `builtin`-handler-kind hooks in the runtime — invoked in-process through an
// injectable port so W3/W8 plug in without a process boundary. Never
// user/project-configurable: a project file can only disable them by id.
import path from "node:path";
import type { HookEventName, HookRegistration } from "./types";

/** The seven events `keryx.learning-observer` is registered on, mapped to W3's observation kind. */
export const LEARNING_OBSERVER_EVENT_KIND: Readonly<
  Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "UserPromptSubmit" | "SessionStart" | "Stop" | "SessionEnd", LearningObservation["kind"]>
> = {
  PreToolUse: "tool-start",
  PostToolUse: "tool-complete",
  PostToolUseFailure: "tool-failed",
  UserPromptSubmit: "user-prompt",
  SessionStart: "session-start",
  Stop: "turn-stop",
  SessionEnd: "session-end",
};

const LEARNING_OBSERVER_EVENTS: readonly HookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SessionEnd",
];

/** One redacted, bounded observation record W3's Observe stage consumes. */
export interface LearningObservation {
  kind: "tool-start" | "tool-complete" | "tool-failed" | "user-prompt" | "session-start" | "turn-stop" | "session-end";
  sessionId: string;
  runId: string;
  timestamp: string;
  payload: unknown;
}

/** W3's extension point: writes data only, never rules/skills/memory (W3 D-3). */
export interface LearningObservationSink {
  record(observation: LearningObservation): Promise<void> | void;
}

/** Default port: writes nothing. */
export const NOOP_LEARNING_OBSERVATION_SINK: LearningObservationSink = {
  record(): void {
    // Intentionally empty — a real sink is injected by W3.
  },
};

export interface ImpactEvidenceInput {
  sessionId: string;
  filePath: string;
  toolName: string;
  projectRoot: string;
  /** Whether this is the session's first edit of `filePath` (the only time the provider is consulted). */
  firstEditInSession: boolean;
}

export interface ImpactEvidenceResult {
  additionalContext?: string;
  /** Present only when W8 strict mode wants to escalate this edit to an approval ask. */
  decision?: "ask";
}

/** W8's extension point: importers/tests/memory caveats for a first edit of a file. */
export interface ImpactEvidenceProvider {
  evidenceFor(input: ImpactEvidenceInput): Promise<ImpactEvidenceResult> | ImpactEvidenceResult;
}

/** Default port: no context, no escalation. */
export const NOOP_IMPACT_EVIDENCE_PROVIDER: ImpactEvidenceProvider = {
  evidenceFor(): ImpactEvidenceResult {
    return {};
  },
};

export interface ResolveKeryxArgvOptions {
  /** Overrides `process.execPath` (injectable for tests). */
  execPath?: string;
  /** Overrides `process.argv[1]` (the running cli script, when running from source). */
  scriptPath?: string;
}

/** Basenames `process.argv[1]` may hold when it genuinely is the keryx CLI entry. */
const KERYX_ENTRY_BASENAMES = new Set(["cli.ts", "cli.js"]);

/**
 * Replace a leading `"keryx"` argv[0] with the binary that can actually run
 * it. Three shapes, in order:
 *
 * 1. Running from source / the built bundle: `process.argv[1]` (or the
 *    injected `scriptPath`) is the keryx entry itself (basename `cli.ts` or
 *    `cli.js`) — spawn `[execPath, scriptPath, ...rest]`, same interpreter
 *    and entry this process was started with.
 * 2. A compiled single-file `keryx` binary: `execPath`'s basename is `keryx`
 *    — that binary IS the CLI, so spawn `[execPath, ...rest]` alone; passing
 *    a second "script" argv would be handed to keryx as its first CLI arg.
 * 3. Neither: `process.argv[1]` is something else entirely — a test runner
 *    (`bun test`'s own entry), a REPL, whatever this process happens to be
 *    embedded in. Re-exec'ing THAT as if it were keryx is exactly the bug
 *    this guards against (flow 306, W6, T16): under `bun test`,
 *    `process.argv[1]` is the test runner, so the naive
 *    `[execPath, argv[1], ...rest]` spawn crashed and the gate hook failed
 *    closed, denying every prompt/tool call. Fall back to plain `"keryx"`
 *    and let the child process's own `PATH` resolve it — correct whenever
 *    this process is embedded in something else, and a clear "command not
 *    found" rather than a silent wrong-binary spawn when it is not.
 */
export function resolveKeryxArgv(argv: readonly string[], opts: ResolveKeryxArgvOptions = {}): string[] {
  if (argv.length === 0 || argv[0] !== "keryx") {
    return [...argv];
  }
  const rest = argv.slice(1);
  const execPath = opts.execPath ?? process.execPath;
  const scriptPath = opts.scriptPath ?? process.argv[1];

  if (scriptPath !== undefined && KERYX_ENTRY_BASENAMES.has(path.basename(scriptPath))) {
    return [execPath, scriptPath, ...rest];
  }
  if (path.basename(execPath) === "keryx") {
    return [execPath, ...rest];
  }
  return ["keryx", ...rest];
}

function builtin(reg: Omit<HookRegistration, "scope">, order: number): HookRegistration {
  return { ...reg, scope: "builtin", order };
}

const CTX_GUARD: HookRegistration = builtin(
  {
    id: "keryx.ctx-guard",
    event: "PreToolUse",
    matcher: "Bash",
    class: "gate",
    handler: { kind: "command", argv: ["keryx", "ctx", "hook", "claude"] },
    timeoutMs: 5000,
    runsIn: "sandbox",
    network: "none",
    appliesToChildAgents: true,
    profiles: [],
    enabled: true,
    order: 0,
    description: "Routes Bash tool calls through the gdctx routing guard (keryx ctx hook claude).",
  },
  0,
);

const SECURITY_CHECK_INPUT: HookRegistration = builtin(
  {
    id: "keryx.security-check-input",
    event: "UserPromptSubmit",
    matcher: "*",
    class: "gate",
    handler: {
      kind: "command",
      argv: ["keryx", "security", "check-input", "--source", "untrusted-external", "--runtime", "claude"],
    },
    timeoutMs: 5000,
    runsIn: "sandbox",
    network: "none",
    appliesToChildAgents: true,
    profiles: [],
    enabled: true,
    order: 1,
    description: "Scans a submitted prompt for injection/secret patterns before it reaches the model.",
  },
  1,
);

const SECURITY_CHECK_OUTPUT: HookRegistration = builtin(
  {
    id: "keryx.security-check-output",
    event: "PreToolUse",
    matcher: "Write|Edit",
    class: "gate",
    handler: { kind: "command", argv: ["keryx", "security", "check-output", "--runtime", "claude"] },
    timeoutMs: 5000,
    runsIn: "sandbox",
    network: "none",
    appliesToChildAgents: true,
    profiles: [],
    enabled: true,
    order: 2,
    description: "Scans a Write/Edit's content before it executes.",
  },
  2,
);

const LEARNING_OBSERVER: HookRegistration[] = LEARNING_OBSERVER_EVENTS.map((event, index) =>
  builtin(
    {
      id: "keryx.learning-observer",
      event,
      matcher: "*",
      class: "observe",
      handler: { kind: "builtin", name: "learning-observer" },
      timeoutMs: 5000,
      runsIn: "sandbox",
      network: "none",
      appliesToChildAgents: true,
      profiles: [],
      enabled: true,
      order: 3 + index,
      description: "Appends a redacted, bounded observation record for W3's Observe stage.",
    },
    3 + index,
  ),
);

const IMPACT_EVIDENCE: HookRegistration = builtin(
  {
    id: "keryx.impact-evidence",
    event: "PreToolUse",
    matcher: "Write|Edit",
    class: "gate-advisory",
    handler: { kind: "builtin", name: "impact-evidence" },
    timeoutMs: 5000,
    runsIn: "sandbox",
    network: "none",
    appliesToChildAgents: true,
    profiles: [],
    enabled: true,
    order: 3 + LEARNING_OBSERVER.length,
    description: "On a session's first edit of a file, injects impact evidence (affected importers, related tests, memory caveats).",
  },
  3 + LEARNING_OBSERVER.length,
);

/** The fixed-order built-in declarations, merged first (lowest precedence) by `config.ts`. */
export const BUILTIN_HOOK_REGISTRATIONS: readonly HookRegistration[] = [
  CTX_GUARD,
  SECURITY_CHECK_INPUT,
  SECURITY_CHECK_OUTPUT,
  ...LEARNING_OBSERVER,
  IMPACT_EVIDENCE,
];

/** The five distinct built-in ids (learning-observer counts once despite seven registrations). */
export const BUILTIN_HOOK_IDS: readonly string[] = [
  "keryx.ctx-guard",
  "keryx.security-check-input",
  "keryx.security-check-output",
  "keryx.learning-observer",
  "keryx.impact-evidence",
];
