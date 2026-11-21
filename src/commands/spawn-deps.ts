// The one place a session's `spawn_subagent` dependencies are assembled
// (Keryx Desktop Client M2a, D-12).
//
// `keryx shell` (`makeAgentDeps`) and `keryx acp --profile shell` (`acp/shell-roster.ts`) both
// offer `spawn_subagent`; they differ in what surrounds it — a TUI sidebar or a JSON-RPC
// notification, a terminal's operator or a desktop client — not in how the parent model, the
// provider factory, the routing hints, the hook runtime and the slate are wired. This function is
// that wiring, extracted from `makeAgentDeps` rather than copied, so a change to it reaches both.
//
// A host passes what is its own: where fleet events go, which providers are detected, and whether
// the external runtime exists (`nativeOnly` for a host without one).

import { loadRankHints } from "../harness/routing/model-profile";
import { createTierRankHost } from "../harness/routing/tier-rank-agent";
import type { ProviderPort } from "../harness/provider/types";
import type { SpawnSubagentToolDeps } from "../harness/tool/builtin/spawn-subagent-tool";

export interface SessionSpawnDepsInput {
  /** The session's working directory (parent-scoped: routing config, budget ledger, ephemeral slate). */
  readonly cwd: string;
  /** The parent's model, read at spawn time: a `/model` switch mid-session is followed. */
  readonly getParentModel: SpawnSubagentToolDeps["getParentModel"];
  /** The host's provider factory; a child on the parent's provider inherits the parent's endpoint. */
  readonly providerFactory: (providerId: string, modelId: string, baseUrl?: string) => ProviderPort;
  /** Credentialed providers a child may route to, with their models (see `getDetectedProviders`). */
  readonly refreshRoutingProviders?: SpawnSubagentToolDeps["refreshRoutingProviders"];
  readonly getDetectedProviders: SpawnSubagentToolDeps["getDetectedProviders"];
  readonly onFleetEvent?: SpawnSubagentToolDeps["onFleetEvent"];
  readonly hooks?: SpawnSubagentToolDeps["hooks"];
  readonly onLedgerReady?: SpawnSubagentToolDeps["onLedgerReady"];
  readonly getSlateSession?: SpawnSubagentToolDeps["getSlateSession"];
  /** Absent: a dispatch asking for an external runtime is refused. */
  readonly runExternal?: SpawnSubagentToolDeps["runExternal"];
  /** A host with no external runtime says so; the tool then refuses `runtime.kind: "external"` by name. */
  readonly nativeOnly?: boolean;
}

/** The `SpawnSubagentToolDeps` for one session. */
export function buildSessionSpawnDeps(input: SessionSpawnDepsInput): SpawnSubagentToolDeps {
  const baseUrlFor = (providerId: string, childBaseUrl: string | undefined): string | undefined =>
    childBaseUrl ?? (providerId === input.getParentModel().providerId ? input.getParentModel().baseUrl : undefined);
  return {
    cwd: input.cwd,
    ...(input.nativeOnly === true ? { nativeOnly: true } : {}),
    ...(input.onFleetEvent !== undefined ? { onFleetEvent: input.onFleetEvent } : {}),
    // Flow 306 (W6 T13): the session's own hook runtime, so `SubagentStart`/`SubagentStop` fire and
    // the native child's own tool calls run under `hooks.forChild(...)`.
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
    ...(input.onLedgerReady !== undefined ? { onLedgerReady: input.onLedgerReady } : {}),
    getParentModel: input.getParentModel,
    makeProvider: (providerId, modelId, childBaseUrl) =>
      input.providerFactory(providerId, modelId, baseUrlFor(providerId, childBaseUrl)),
    describeProvider: (providerId, modelId, childBaseUrl) =>
      input.providerFactory(providerId, modelId, baseUrlFor(providerId, childBaseUrl)).describe(),
    getDetectedProviders: input.getDetectedProviders,
    ...(input.refreshRoutingProviders ? { refreshRoutingProviders: input.refreshRoutingProviders } : {}),
    getRankHints: (providerId) => loadRankHints(providerId),
    // Flow 358: when the size words and version cannot settle a `model_tier`, a one-shot call on
    // the provider's light tier orders the discovered models; any failure keeps the session model.
    tierRank: createTierRankHost(),
    ...(input.getSlateSession !== undefined ? { getSlateSession: input.getSlateSession } : {}),
    ...(input.runExternal !== undefined ? { runExternal: input.runExternal } : {}),
  };
}

/**
 * The detected providers with the session's own provider always present (it is the one a child
 * inherits), a detected entry replacing the placeholder in place so detection order is kept.
 * `models` is carried through, never flattened to names: `buildTierMap` ranks exactly these ids,
 * and a names-only list starves discovery so every tier resolves to the session model.
 */
export function withSessionProvider(
  sessionProviderId: string,
  detected: readonly { readonly name: string; readonly models?: readonly string[] }[],
): { name: string; models: readonly string[] }[] {
  const byName = new Map<string, { name: string; models: readonly string[] }>();
  byName.set(sessionProviderId, { name: sessionProviderId, models: [] });
  for (const entry of detected) byName.set(entry.name, { name: entry.name, models: entry.models ?? [] });
  return [...byName.values()];
}
