// Flow 316, T6 — wires `keryx skills eval --judge <provider>[:<model>]` /
// `keryx skills judge-check` to a real single-turn model completion, the
// judge-side counterpart to `./model-eval-runner.ts`'s `buildEvalRunner`.
//
// WHY THIS LIVES HERE, NOT IN `src/gdskills/governance/`
//
// Same reasoning as `model-eval-runner.ts`'s own module doc: `src/gdskills`
// is a "core" zone module (`src/lib/import-zones.ts`'s `ZONE_TABLE`) and a
// core owner never imports a client/adapter module — `runModelTurn` lives in
// `src/harness/provider/single-turn.ts` (client zone). `src/commands` is
// adapter zone, above both, so the judge-building factory belongs here.
// `judge.ts`'s `Judge`/`JudgeRequest`/`JudgeVerdict`/`buildJudgePrompt`/
// `parseJudgeVerdict` types stay exactly where they are (core, injectable,
// pure) — this module just builds a value of that `Judge` type and hands it
// to `evalSkill`/`gradeScenarioAnswer` from the CLI layer, never the reverse.
//
// FAIL-CLOSED, mirroring `buildEvalRunner`: an unknown provider name, or a
// known provider with no credential, throws `JudgeBuildError` (a
// `RunnerBuildError` — the same class the CLI already catches for `--runner`)
// at BUILD time, before any scenario is graded, rather than silently
// returning a `Judge` that would call `FakeProvider` or fabricate a verdict.
//
// RETRY: a judge call is graded, not a fact lookup — an LLM occasionally
// emits prose around its JSON, or an empty stream. `buildJudgePrompt`'s
// system prompt is strict about "exactly one JSON object", so a genuine
// parse failure is retried exactly once (the OWNER's rubric decision, not
// this module's own judgment call) before giving up and reporting `fail`
// with `error` set — never silently treated as a pass, and never retried a
// second time (an LLM that fails to follow the format twice in a row is
// reported, not hammered).
//
// The judge is a SEPARATE build and separate calls from the runner under
// test — even when both use `--judge deepseek:deepseek-chat --runner
// deepseek:deepseek-chat` (the pinned gate policy), each request carries its
// own `requestId` stem (`skills-eval-judge-<skillId>`, vs. the runner's
// `skills-eval-<skill.id>`) so the harness's own request logs never conflate
// "the model under test answered" with "the judge graded that answer".
//
// The key is never printed — `runModelTurn`/`envWithSavedApiKeys` resolve it
// internally; this module never logs `env` or any resolved credential.

import type { Judge, JudgeRequest, JudgeVerdict } from "../gdskills/governance/judge";
import { buildJudgePrompt, parseJudgeVerdict } from "../gdskills/governance/judge";
import { defaultModelFor, hasCredential, runModelTurn, type ProviderFactory } from "../harness/provider/single-turn";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { providerByName } from "./providers";
import { RunnerBuildError, splitRunnerSpec } from "./model-eval-runner";

/** Thrown when `--judge <spec>` cannot be turned into a usable `Judge` — a `RunnerBuildError` so existing `error instanceof RunnerBuildError` handling (the CLI's `--runner` catch block) also catches this without change. The CLI maps either to exit 1. */
export class JudgeBuildError extends RunnerBuildError {}

/** The judge's output budget — a verdict is `{"verdict":"pass"|"fail","reason":"<=300 chars"}`, never a long completion, so a generous multi-thousand-token budget (the runner's default) would only let a misbehaving model ramble past the point of being parseable. ~400 tokens comfortably covers the JSON shape plus a 300-character reason. */
const JUDGE_MAX_OUTPUT_TOKENS = 400;

const KNOWN_BUILTIN_PROVIDERS = new Set(["anthropic", "openai", "gemini", "ollama"]);

function isKnownProviderName(provider: string): boolean {
  return KNOWN_BUILTIN_PROVIDERS.has(provider) || providerByName(provider) !== undefined;
}

export interface BuildEvalJudgeOptions {
  /** Credential/config source; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  /** Injectable provider construction — tests use this to avoid any network call. */
  readonly providerFactory?: ProviderFactory;
  /** The `auth.json` directory `envWithSavedApiKeys` reads from — defaults to the real `~/.local/share/keryx`, mirroring `buildEvalRunner`'s own option. Tests point this at a fixture directory. */
  readonly shellConfigDir?: string;
  /** The skill id this judge is being built for — stamped into every request's `requestId` as `skills-eval-judge-<skillId>` (see this module's doc comment on why judge/runner requestIds are kept distinct). Defaults to `"skill"` when omitted (a caller that grades scenarios not tied to one particular skill id). */
  readonly skillId?: string;
}

/**
 * Build a `Judge` for `--judge <provider>[:<model>]`: one single-turn
 * completion per grading request via `runModelTurn`, the system/user prompt
 * pair from `buildJudgePrompt(request)` (deterministic, no tools). Throws
 * `JudgeBuildError` for an unknown provider name or a known provider with no
 * credential available — never returns a `Judge` that would silently call a
 * fake provider or fabricate a verdict.
 */
export function buildEvalJudge(judgeSpec: string, options: BuildEvalJudgeOptions = {}): Judge {
  const { provider, model } = splitRunnerSpec(judgeSpec);
  if (provider.length === 0) {
    throw new JudgeBuildError(`--judge ${JSON.stringify(judgeSpec)}: empty provider name`);
  }
  const env = options.env ?? process.env;

  // Mirrors `buildEvalRunner`'s build-time fail-closed check: a test
  // injecting its own `providerFactory` supplies its own offline
  // construction and needs no real credential.
  if (options.providerFactory === undefined) {
    if (!isKnownProviderName(provider)) {
      throw new JudgeBuildError(`--judge ${JSON.stringify(judgeSpec)}: unknown provider "${provider}"`);
    }
    if (!hasCredential(provider, envWithSavedApiKeys(env, options.shellConfigDir))) {
      throw new JudgeBuildError(`--judge ${JSON.stringify(judgeSpec)}: no credential available for provider "${provider}"`);
    }
  }

  const resolvedModel = model ?? defaultModelFor(provider);
  const skillId = options.skillId ?? "skill";
  const requestId = `skills-eval-judge-${skillId}`;

  async function callOnce(system: string, user: string): Promise<string> {
    const result = await runModelTurn({
      provider,
      model: resolvedModel,
      system,
      user,
      env,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      // Fix 1 / R1-4: a judge grading the same input must not flip verdicts
      // on sampling noise — temperature 0 is the closest a provider gets to
      // deterministic decoding. Only reaches the wire for providers that
      // serialize `options.temperature` (see `single-turn.ts`'s own note);
      // still requested uniformly so the judge is as stable as the provider
      // allows.
      temperature: 0,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.providerFactory !== undefined ? { providerFactory: options.providerFactory } : {}),
      requestId,
    });
    // Defensive re-check, same rationale as `buildEvalRunner`: only
    // load-bearing when no `providerFactory` was injected (tests legitimately
    // run with `credentialAvailable: false` while returning real assembled
    // text from a stub provider).
    if (!result.credentialAvailable && options.providerFactory === undefined) {
      throw new JudgeBuildError(`--judge ${JSON.stringify(judgeSpec)}: no credential available for provider "${provider}"`);
    }
    if (result.error) {
      // A provider error is not a grading ambiguity — it is a real failure to
      // reach the judge at all, so it throws rather than being retried or
      // folded into a manufactured "fail" verdict (that would be
      // indistinguishable from the judge genuinely grading the answer fail).
      throw new JudgeBuildError(`--judge ${JSON.stringify(judgeSpec)}: provider error: ${result.error.message}`);
    }
    return result.text;
  }

  return async (request: JudgeRequest): Promise<JudgeVerdict> => {
    const { system, user } = buildJudgePrompt(request);

    const text = await callOnce(system, user);
    const firstAttempt = text.trim().length === 0 ? { error: "judge returned an empty completion" } : parseJudgeVerdict(text);
    if (!("error" in firstAttempt)) return firstAttempt;

    // ONE retry (owner decision, plan.md section 5) — a fresh call, not a
    // re-parse of the same text: a transient formatting slip is exactly the
    // kind of thing a second attempt at the SAME prompt can self-correct.
    const retryText = await callOnce(system, user);
    const secondAttempt = retryText.trim().length === 0 ? { error: "judge returned an empty completion" } : parseJudgeVerdict(retryText);
    if (!("error" in secondAttempt)) return secondAttempt;

    return { verdict: "fail", reason: "judge returned an unparseable verdict", error: secondAttempt.error };
  };
}
