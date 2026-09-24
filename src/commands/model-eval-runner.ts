// Flow 314, W4 Wave 4 — wires `keryx skills eval --runner <provider>[:<model>]`
// to a real single-turn model completion.
//
// WHY THIS LIVES HERE, NOT IN `src/gdskills/governance/`
//
// `src/gdskills` is a "core" zone module under `src/lib/import-zones.ts`'s
// `ZONE_TABLE`, and that table's rule has no exception: "A core owner never
// imports a client or adapter module." `runModelTurn` (this module's whole
// reason for existing) lives in `src/harness/provider/single-turn.ts`, which
// is `client` zone (`{ segment: "harness", zone: "client" }`). A module under
// `src/gdskills/governance/` that imported it would violate that direction on
// sight. `src/commands` is `adapter` zone, which — per the table's own
// comment — is "above both" core and client and may import either, so the
// runner factory belongs here instead. `eval.ts`'s `Runner`/`RunnerOutput`
// types stay exactly where they are (core, injectable) — this module just
// builds a value of that type and hands it to `evalSkill` from the CLI layer
// (`skills-governance.ts`), never the reverse.
//
// FAIL-CLOSED (per the eval workstream's own design note, `eval.ts`'s module
// doc): an unknown provider name, or a known provider with no credential,
// throws `RunnerBuildError` at BUILD time — before any scenario runs — rather
// than silently falling back to `FakeProvider` (what `makeProvider` itself
// does for an unrecognized name) or reporting a scenario as `"ran"` with
// empty/garbage output. The per-call closure re-checks `credentialAvailable`
// defensively (belt and suspenders — `runModelTurn` fails closed the same way
// on its own), so a runner that somehow gets invoked after its environment
// changed underneath it (a revoked key mid-run) still refuses rather than
// silently producing an empty completion that could be misread as "the model
// said nothing" (a plausible read for a `not-contains` grader).

import type { CatalogEntry } from "../gdskills/governance/catalog-index";
import type { Runner, RunnerOutput } from "../gdskills/governance/eval";
import { defaultModelFor, hasCredential, runModelTurn, type ProviderFactory } from "../harness/provider/single-turn";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { providerByName } from "./providers";

/** Thrown when `--runner <spec>` cannot be turned into a usable `Runner` — the CLI maps this to exit 1. */
export class RunnerBuildError extends Error {}

const KNOWN_BUILTIN_PROVIDERS = new Set(["anthropic", "openai", "gemini", "ollama"]);

/** Whether `provider` is recognized at all (built-in, or a registered OpenAI-compatible entry) — independent of whether a credential is present for it. */
function isKnownProviderName(provider: string): boolean {
  return KNOWN_BUILTIN_PROVIDERS.has(provider) || providerByName(provider) !== undefined;
}

/**
 * Split a `--runner` value at the FIRST `:` — provider, optional model.
 * Models routinely contain colons themselves (e.g. `ollama:llama3.1:latest`
 * names model `llama3.1:latest`), so only the first separator is meaningful;
 * everything after it is the model id verbatim, colons included.
 */
export function splitRunnerSpec(spec: string): { readonly provider: string; readonly model?: string } {
  const idx = spec.indexOf(":");
  if (idx === -1) return { provider: spec };
  const provider = spec.slice(0, idx);
  const model = spec.slice(idx + 1);
  return model.length > 0 ? { provider, model } : { provider };
}

export interface BuildEvalRunnerOptions {
  /** Credential/config source; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  /** Injectable provider construction — tests use this to avoid any network call. */
  readonly providerFactory?: ProviderFactory;
  /**
   * R1-9 (flow 314 review round 1): the `auth.json` directory
   * `envWithSavedApiKeys` reads from — defaults to the real
   * `~/.local/share/keryx` the same way `envWithSavedApiKeys` itself
   * defaults. Tests point this at a fixture directory instead, so the
   * build-time credential check can be exercised with an injected saved key
   * and never touches the real file.
   */
  readonly shellConfigDir?: string;
}

/**
 * Build an eval `Runner` for `--runner <provider>[:<model>]`: one single-turn
 * completion per scenario prompt via `runModelTurn`, the skill's full
 * `SKILL.md` (`skill.body`) as the system prompt, no tools. Throws
 * `RunnerBuildError` for an unknown provider name or a known provider with no
 * credential available — never returns a `Runner` that would silently run
 * against `FakeProvider` or report empty output as a real completion.
 */
export function buildEvalRunner(runnerSpec: string, options: BuildEvalRunnerOptions = {}): Runner {
  const { provider, model } = splitRunnerSpec(runnerSpec);
  if (provider.length === 0) {
    throw new RunnerBuildError(`--runner ${JSON.stringify(runnerSpec)}: empty provider name`);
  }
  const env = options.env ?? process.env;

  // A test injecting its own `providerFactory` supplies its own (fake, deterministic,
  // offline) construction and does not need a real credential to exist — the same
  // shape `runModelTurn` itself uses (`credentialAvailable` is only load-bearing
  // when no factory was injected).
  if (options.providerFactory === undefined) {
    if (!isKnownProviderName(provider)) {
      throw new RunnerBuildError(`--runner ${JSON.stringify(runnerSpec)}: unknown provider "${provider}"`);
    }
    // R1-9 (flow 314 review round 1): `runModelTurn` itself merges
    // `envWithSavedApiKeys` (a key saved once via `keryx shell`,
    // `~/.local/share/keryx/auth.json`) before it ever checks credentials —
    // this build-time check used to look at raw `env` only, so `--runner
    // <provider>` was refused for a provider whose key the user had already
    // saved, even though the actual model call a moment later would have
    // succeeded. Checking the SAME merged env here keeps this fail-fast
    // check consistent with what `runModelTurn` will actually see.
    if (!hasCredential(provider, envWithSavedApiKeys(env, options.shellConfigDir))) {
      throw new RunnerBuildError(`--runner ${JSON.stringify(runnerSpec)}: no credential available for provider "${provider}"`);
    }
  }

  const resolvedModel = model ?? defaultModelFor(provider);

  return async (prompt: string, skill: CatalogEntry): Promise<RunnerOutput> => {
    const result = await runModelTurn({
      provider,
      model: resolvedModel,
      system: skill.body,
      user: prompt,
      env,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.providerFactory !== undefined ? { providerFactory: options.providerFactory } : {}),
      requestId: `skills-eval-${skill.id}`,
    });
    // `credentialAvailable` is only load-bearing when no `providerFactory` was
    // injected — an injected factory (tests) legitimately runs with
    // `credentialAvailable: false` while still returning real assembled text
    // (see `single-turn.test.ts`'s "assembles text from an injected
    // provider"); this mirrors that contract instead of treating it as a
    // failure.
    if (!result.credentialAvailable && options.providerFactory === undefined) {
      throw new RunnerBuildError(`--runner ${JSON.stringify(runnerSpec)}: no credential available for provider "${provider}"`);
    }
    if (result.error) {
      throw new RunnerBuildError(`--runner ${JSON.stringify(runnerSpec)}: provider error: ${result.error.message}`);
    }
    // R1-8 (flow 314 review round 1): a completion turn that reports no
    // error but whose assembled text is empty/whitespace-only (a
    // reasoning-only stream, a truncated stream, a model that emits nothing)
    // used to flow straight through as `{ output: "" }` — a plausible pass
    // for a `not-contains` grader that checked nothing. This module's own
    // doc comment already promises the credential re-check exists so output
    // is "never silently producing an empty completion that could be
    // misread as 'the model said nothing'"; this closes the other way that
    // same misread could happen.
    if (result.text.trim().length === 0) {
      throw new RunnerBuildError(`--runner ${JSON.stringify(runnerSpec)}: provider returned an empty completion`);
    }
    return { output: result.text };
  };
}
