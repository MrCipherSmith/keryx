// Flow 327 (Routing A2) — curated, hand-maintained model-id lists for the
// three providers with no live `/models` listing endpoint: anthropic/openai/
// gemini, each a native `ProviderPort` adapter (`make-provider.ts:88-113`,
// `describe().modelListing === false`). Split out of `select.ts` so
// `src/harness/routing/model-profile.ts`'s curated price/context/tier seed
// table (PRD §6.1, `docs/requirements/keryx-jev-router/PRD.md`) can read the
// SAME three lists `detectProviders()` already offers, without importing
// `select.ts` (and, through it, `../commands/providers`) back into the
// routing module — `providers.ts` itself imports `model-profile.ts` (AC2), so
// `model-profile.ts -> select.ts -> providers.ts` would be a cycle. One
// source of truth for the three ids, zero import cycle: both `select.ts` and
// `model-profile.ts` import from here, and neither of THIS file's exports
// import anything at all.
//
// Update these three lists when a provider's lineup moves on; `model-profile.
// ts`'s curated seed table (`CURATED_SEED`) is keyed off the exact ids here,
// so a model added/removed here should get a matching seed entry there.

/** Static `claude-*` model list surfaced when `ANTHROPIC_API_KEY` is present. */
export const ANTHROPIC_MODELS: readonly string[] = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];

/**
 * Static OpenAI model list surfaced when `OPENAI_API_KEY` is present (flow
 * 183 T9). No live listing endpoint is wired — this curated set mirrors
 * `ANTHROPIC_MODELS`'s pattern exactly.
 */
export const OPENAI_MODELS: readonly string[] = ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"];

/**
 * Static Gemini model list surfaced when `GEMINI_API_KEY`/`GOOGLE_API_KEY` is
 * present (flow 183 T9). No live listing endpoint is wired — mirrors
 * `ANTHROPIC_MODELS`'s pattern.
 */
export const GEMINI_MODELS: readonly string[] = ["gemini-3.7-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"];
