// Flow 305 — resolving `{kind:"provider-default"}` (PRD §5) to a concrete
// model id, for the two callers that need a real `modelId` rather than a bare
// provider name: the `subagents` category's `ChildModelRequest` construction
// (`child-model-request.ts`, AC6) and `keryx routing list`/`/routing`'s display
// of what a provider-default entry currently resolves to.
//
// PRD §5: "provider-default" resolves to that provider's own notion of a
// default model — `OLLAMA_COMPAT_IDENTITY.defaultModel.modelId` for `ollama`
// (the only provider with a documented default today), or the first entry of
// that provider's curated `models` list for a compat-registry entry (itself
// documented as "a fallback only" ahead of a live `/models` fetch). Flagged in
// the PRD (§15) as repurposing a field not designed for this — kept exactly
// that narrow here, not extended.
import { providerByName } from "../../commands/providers";

/** `OLLAMA_COMPAT_IDENTITY.defaultModel.modelId` (`make-provider.ts`), not exported there — kept in sync by `provider-default.test.ts`. */
const OLLAMA_DEFAULT_MODEL_ID = "llama3.1:latest";

/**
 * The concrete model id a provider's "provider default" row resolves to, or
 * `undefined` when the provider is unknown or has no curated model to fall
 * back to. Pure and synchronous — reads only the static provider registry,
 * never the network.
 */
export function resolveProviderDefaultModelId(providerId: string): string | undefined {
  if (providerId === "ollama") return OLLAMA_DEFAULT_MODEL_ID;
  const provider = providerByName(providerId);
  if (provider === undefined) return undefined;
  return provider.models[0];
}
