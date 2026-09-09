// The model-turn seam: core DECLARES the capability, the client SUPPLIES it.
//
// WHY THIS EXISTS
//
// AFC-19 (`docs/requirements/keryx-agent-first-core/specification.md`, §"В core
// нет provider registry, выбора модели, credentials, LLM-вызовов"): a core-only
// install must not carry the model runtime. Measured before this module existed:
// building the public SAC facade (`./service.ts`) in isolation with the real
// release flags put 15 client/adapter modules in the artifact — six providers,
// `make-provider`, `single-turn`, the SSE reader, `tool-call-linking`, the
// policy engine, the mutation guard, `workspace-lifecycle-tool`, and
// `src/commands/providers.ts` — every one of them reached through ONE function,
// `runModelTurn`, statically imported by exactly three SAC modules
// (`workspace-resolve.ts`, `machine-wrap-up.ts`, `decision-dedup.ts`).
//
// A lazy `await import("../harness/provider/single-turn")` would NOT have fixed
// it. `src/gdgraph/treesitter/adapter.ts` already records the measurement: a
// LITERAL dynamic import still bundles (only a runtime-variable specifier does
// not, which for an internal module would then fail to resolve inside
// `dist/cli.js`). The bundler resolves specifiers; the only way out of a module
// graph is not to name the module.
//
// THE SHAPE, AND WHY IT MATCHES THE ONE ALREADY HERE
//
// This mirrors `src/capability/seam.ts`, the project-wide optional-dependency
// substrate: core states the contract and holds no implementation, the
// implementation is injected from outside, and an unsatisfied seam is handled
// explicitly rather than pretended away. Two differences, both deliberate:
//
//   * `resolveCapability` gates on `metaproject.json` + an optional npm
//     dependency. There is no npm dependency here — the model runner is this
//     repository's own source (`src/harness/provider/`), which is why the seam
//     is a supplied function rather than an `await import(spec)`.
//   * `runCapabilityOrFallback` degrades to a DETERMINISTIC FALLBACK. There is
//     no deterministic fallback for "ask a model to judge this", so the
//     degradation here is a REFUSAL that the caller must handle and that says
//     which of the two reasons it was — never an empty answer that reads like a
//     real one. The same discipline `specification.md` applies to a missing
//     limits profile: "запрос без применимого profile даёт
//     `configuration-incomplete`, а не unlimited."
//
// HOW THE CLIENT SUPPLIES IT
//
// Per call, by passing `modelTurn` (what the co-located tests do), or once per
// process, by registering a default:
//
//   import { runModelTurn } from "../harness/provider/single-turn";
//   import { setModelTurnPort } from "../sac/model-turn-port";
//   setModelTurnPort(async (request) => runModelTurn(request));
//
// `runModelTurn`'s input and result are supersets of `ModelTurnRequest`/
// `ModelTurnOutcome`, so that adapter is the whole of the client's obligation.
// Until some client entry point registers it, every SAC call site below refuses
// — see `model-turn-port.test.ts`, which pins the refusal of each of the three.
//
// This module imports one dependency-free shared helper and nothing else, so it
// cannot itself put anything in a core artifact.

import { warnOnce } from "../capability/warn-once";

/**
 * A single bounded model turn, as core needs it. Structurally a subset of
 * `runModelTurn`'s `ModelTurnInput` (`src/harness/provider/single-turn.ts`) so
 * the client adapter is a pass-through; core never names a provider registry, a
 * model list, a credential or a transport.
 */
export interface ModelTurnRequest {
  /** Trusted system instruction. */
  system: string;
  /** The user message (project content). */
  user: string;
  /** Correlation id stem. */
  requestId: string;
  /** Output token budget; the port's default applies when omitted. */
  maxOutputTokens?: number;
  /**
   * The already-active provider/model of the calling session, passed through
   * verbatim. Core does not choose or validate these — it only forwards what
   * its caller was already authenticated with.
   */
  provider?: string;
  model?: string;
  /** Environment the port should read credentials from, if it reads any. */
  env?: Record<string, string | undefined>;
}

/**
 * The result of a supplied turn. `credentialAvailable: false` with empty text
 * is the port's own fail-closed answer ("I exist, but I have no credential") —
 * distinct from the port being absent entirely, which never produces a result
 * at all.
 */
export interface ModelTurnOutcome {
  credentialAvailable: boolean;
  text: string;
}

/** The injected capability. */
export type ModelTurnPort = (request: ModelTurnRequest) => Promise<ModelTurnOutcome>;

let registered: ModelTurnPort | undefined;

/**
 * Register the process-wide default port. Called by a CLIENT entry point (the
 * CLI, the MCP server, a test), never by core. Passing `undefined` clears it,
 * which is what a test that wants to observe the refusal does.
 */
export function setModelTurnPort(port: ModelTurnPort | undefined): void {
  registered = port;
}

/** The registered default, if any. */
export function getModelTurnPort(): ModelTurnPort | undefined {
  return registered;
}

/**
 * The port a call site should use: an explicitly passed one wins over the
 * process default, and `undefined` means "refuse" — never "carry on".
 */
export function resolveModelTurnPort(explicit?: ModelTurnPort): ModelTurnPort | undefined {
  return explicit ?? registered;
}

/**
 * Say once, on stderr, that a named core call site refused for want of a port.
 * Uses the same process-scoped warn-once discipline the capability seam uses
 * (`src/capability/warn-once.ts`), with its own wording: this is a refusal, not
 * a fallback, and the message must not claim a fallback happened.
 */
export function warnModelTurnUnavailable(callSite: string): void {
  warnOnce(
    `sac.model-turn:${callSite}`,
    `[sac] ${callSite}: no model-turn port supplied — refused. Core does not carry a provider ` +
      `registry (AFC-19); a client must supply one per call or register one with setModelTurnPort().`,
  );
}
