// Release 0 harness startup slice (flow 009, W7 / S1, R0-01).
//
// `startRun` is the deterministic, OFFLINE entry point that decides whether a
// run may begin. It never opens a socket, issues a provider request, mutates
// the filesystem, or reads a clock/RNG directly — all non-determinism is
// injected via `deps`. Three outcomes:
//
//   - `disabled`             — `config.enabled === false`: a byte-identical
//                              no-load floor. Nothing else is constructed.
//   - `environment_blocked`  — a required provider precondition (provider,
//                              model, or credential reference) is missing after
//                              resolving config defaults. No partial request.
//   - `started`              — a bounded, trusted context manifest plus a
//                              startup event carrying the context and policy
//                              fingerprints.
import { type ContextManifest, MAX_CONTEXT_BYTES, MAX_CONTEXT_TOKENS, buildContextManifest } from "./context/manifest";
import type { HarnessConfig } from "./config";
import type { HarnessRunInput } from "./types";

/**
 * Emitted once when a run starts. Carries the context fingerprint (equal to
 * `manifest.contextHash`) and the policy fingerprint (`policyProfile`) so
 * downstream consumers can bind the run to its trusted context and policy
 * before the first model request.
 */
export interface StartupEvent {
  schemaVersion: number;
  eventId: string;
  createdAt: string;
  contextHash: string;
  policyProfile: string;
  /** Alias accessor for the policy fingerprint; consumers may read either key. */
  policy?: string;
  role: string;
  provider: string;
  model: string;
}

export type StartupResult =
  | { kind: "disabled" }
  | { kind: "environment_blocked"; reason: string; missing: string[] }
  | { kind: "started"; manifest: ContextManifest; startupEvent: StartupEvent };

export interface StartupDeps {
  clock: () => string;
  idSeq: () => string;
}

export function startRun(input: HarnessRunInput, config: HarnessConfig, deps: StartupDeps): StartupResult {
  // Capability floor: disabled means a deterministic no-load. Return exactly
  // `{ kind: "disabled" }` — build no manifest, no event, touch no provider.
  if (!config.enabled) {
    return { kind: "disabled" };
  }

  // Resolve provider/model from the run input, falling back to config defaults.
  const provider = input.provider ?? config.defaultProvider;
  const model = input.model ?? config.defaultModel;
  const credentialRef = input.credentialRef;

  const missing: string[] = [];
  if (provider === undefined || provider.length === 0) missing.push("provider");
  if (model === undefined || model.length === 0) missing.push("model");
  if (credentialRef === undefined || credentialRef.length === 0) missing.push("credentialRef");

  if (!provider || !model || !credentialRef) {
    return {
      kind: "environment_blocked",
      reason: `Startup blocked: missing required provider precondition(s): ${missing.join(", ")}.`,
      missing,
    };
  }

  // Build the bounded, trusted context manifest. In Release 0 startup no source
  // files are loaded; declared scope paths are recorded as not-yet-loaded so
  // the manifest still carries scope + content fingerprints.
  const scopePaths = input.scope?.paths ?? [];
  const manifest = buildContextManifest(
    {
      projectRoot: input.projectRoot,
      sources: scopePaths.map((scopePath) => ({
        kind: "scope-path",
        path: scopePath,
        available: false,
        skipReason: `scope path ${scopePath} declared but not loaded during Release 0 startup`,
      })),
      limits: { maxBytes: MAX_CONTEXT_BYTES, maxTokens: MAX_CONTEXT_TOKENS },
    },
    { clock: deps.clock },
  );

  const startupEvent: StartupEvent = {
    schemaVersion: 1,
    eventId: deps.idSeq(),
    createdAt: deps.clock(),
    contextHash: manifest.contextHash,
    policyProfile: input.policy,
    policy: input.policy,
    role: input.role,
    provider,
    model,
  };

  return { kind: "started", manifest, startupEvent };
}
