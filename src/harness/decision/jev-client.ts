// Jev ("System One") client — flow 306, PRD.md Phase 0
// (docs/requirements/keryx-jev-review/PLAN.md).
//
// A small, injectable-`fetch` HTTP client for TypeSafe's Jev model, reached
// through OpenRouter's `/api/v1/systemone` endpoint
// (https://openrouter.ai/docs/guides/community/typesafe-sdk). It is a
// DECISION PORT, not a provider: Jev's typed noul/choice answers share no
// method shape with a chat/completion stream, so this stays structurally
// separate from `ProviderPort`/`makeProvider` (src/harness/provider/**) on
// purpose — the parallel `keryx-jev-router` package (Open Question 2 of
// PLAN.md) is expected to reuse this exact module rather than write a second
// one, which is also why it lives under `src/harness/decision/` rather than
// under `src/review/`.
//
// Follows the exact injected-fetch shape `fetchProviderBalance` already
// established (`src/commands/providers.ts:779-810`, tested at
// `src/commands/providers.balance.test.ts:8-50`): a `typeof fetch` first
// argument, a `Response` returned from a fake in tests, no real network call
// in any test.
//
// CHOICE-ANSWER FINDING (AC7 of the frozen acceptance criteria asked this to
// be checked): OpenRouter's own TypeSafe SDK guide (fetched 2026-09-25) shows
// a worked `noul` answer, `{"type": "noul", "noul": 0.98}`, but shows NO
// worked example of a `choice` answer's shape — only the `choice` QUESTION
// shape (`{"type": "choice", "instructions": ..., "criteria": {...}}`). The
// sibling `docs/requirements/keryx-jev-router/PRD.md` (§13, researched the
// same day) records the same gap explicitly: "`choice` picks one of
// `criteria`. A `Score` type is mentioned by the vendor with no documented
// shape — not used by this design." No source available to this flow
// documents a `choice` answer carrying a probability per option. Callers that
// need a probability PER OPTION (this flow's CI-triage use, `src/review/
// ci-triage.ts`) therefore ask one `noul` question per option instead of one
// `choice` question — see that module's own header for the consequence.

import { estimateTokens } from "../../review/cost";
import { envWithSavedApiKeys } from "../../lib/shell-config";

/** `POST` target for every Jev/System-One call this client makes. */
export const JEV_ENDPOINT = "https://openrouter.ai/api/v1/systemone";

/** The two model ids OpenRouter's TypeSafe SDK guide names. */
export const JEV_MODEL_1_13 = "jev-1.13";
export const JEV_MODEL_LATEST = "jev-latest";

/**
 * The model a caller gets when it names none. Pinned to the numbered release
 * rather than `jev-latest`: a triage classifier whose accuracy nobody has
 * measured yet (PLAN.md's Phase 7 is the measurement) should not also drift
 * under callers that never pass `--model`.
 */
export const DEFAULT_JEV_MODEL: string = JEV_MODEL_1_13;

/** The combined `state`+`questions` token budget the vendor documents. */
export const JEV_TOKEN_BUDGET = 64_000;

export type JevQuestionType = "noul" | "choice";

export interface JevQuestion {
  readonly type: JevQuestionType;
  readonly instructions: string;
  /** Only meaningful for a `choice` question. */
  readonly criteria?: readonly string[];
}

export type JevQuestions = Readonly<Record<string, JevQuestion>>;

export interface JevRequestInput {
  /** Defaults to {@link DEFAULT_JEV_MODEL}. */
  readonly model?: string;
  readonly state: string;
  readonly questions: JevQuestions;
}

export type JevAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | { readonly type: "choice"; readonly choice: string };

export interface JevUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cost?: number;
}

export interface JevResult {
  readonly id?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: JevUsage;
}

/** AC2: a named, non-network error — no `OPENROUTER_API_KEY` and no saved `openrouterKey`. */
export class JevCredentialError extends Error {
  constructor(
    message = "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: " +
      "Jev needs an OpenRouter credential and refuses to send an unauthenticated request.",
  ) {
    super(message);
    this.name = "JevCredentialError";
  }
}

/** AC3: a named error identifying which side of the request is over the 64k budget. */
export class JevBudgetError extends Error {
  constructor(
    readonly side: "state" | "questions",
    readonly stateTokens: number,
    readonly questionsTokens: number,
  ) {
    super(
      `Jev request is ≈${stateTokens + questionsTokens} tokens (state ≈${stateTokens}, questions ≈${questionsTokens}), ` +
        `over the ${JEV_TOKEN_BUDGET}-token state+questions budget — the ${side} side is larger and is refused rather than truncated.`,
    );
    this.name = "JevBudgetError";
  }
}

/** A non-2xx response. */
export class JevRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Jev request to ${JEV_ENDPOINT} failed: HTTP ${status}${body.length > 0 ? ` — ${body.slice(0, 500)}` : ""}`);
    this.name = "JevRequestError";
  }
}

/** The response body was not valid JSON. */
export class JevResponseParseError extends Error {
  constructor(cause: unknown) {
    super(`Jev response body was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "JevResponseParseError";
  }
}

/** A parsed response was missing a required field (`answers` or `usage`). */
export class JevResponseShapeError extends Error {
  constructor(readonly missing: "answers" | "usage") {
    super(`Jev response is missing "${missing}" — refusing to treat a malformed response as an answer.`);
    this.name = "JevResponseShapeError";
  }
}

/**
 * AC2's resolution path: `OPENROUTER_API_KEY`, falling back to a saved
 * `openrouterKey` (`src/lib/shell-config.ts:28,253-254`) — the exact merge
 * `envWithSavedApiKeys` already performs for every other OpenRouter-keyed call
 * site. No new credential type.
 */
export function resolveJevApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dir?: string,
): string | undefined {
  return envWithSavedApiKeys(env as Record<string, string | undefined>, dir).OPENROUTER_API_KEY;
}

/** A stable, order-independent text of `questions`, for the token estimate only. */
function questionsEstimateText(questions: JevQuestions): string {
  return Object.entries(questions)
    .map(([key, q]) => `${key}:${q.type}:${q.instructions}:${(q.criteria ?? []).join(",")}`)
    .join("\n");
}

/**
 * AC3: estimate `state`+`questions` (reusing `estimateTokens`,
 * `src/review/cost.ts:42-44`) and throw {@link JevBudgetError} over budget,
 * naming whichever side estimates larger — nothing is ever truncated.
 */
export function preflightBudget(state: string, questions: JevQuestions): void {
  const stateTokens = estimateTokens(state);
  const questionsTokens = estimateTokens(questionsEstimateText(questions));
  if (stateTokens + questionsTokens > JEV_TOKEN_BUDGET) {
    throw new JevBudgetError(stateTokens >= questionsTokens ? "state" : "questions", stateTokens, questionsTokens);
  }
}

/**
 * `POST /api/v1/systemone`. AC1: injectable `fetch` (default
 * `globalThis.fetch`), `{model, state, questions}` in, parsed `{answers,
 * usage}` out — no vendor SDK, no `ProviderPort`/`makeProvider` dependency.
 */
export async function callJevSystemOne(
  fetchFn: typeof fetch = globalThis.fetch,
  input: JevRequestInput,
  opts?: { env?: Readonly<Record<string, string | undefined>>; dir?: string },
): Promise<JevResult> {
  const apiKey = resolveJevApiKey(opts?.env ?? process.env, opts?.dir);
  if (apiKey === undefined || apiKey.length === 0) {
    throw new JevCredentialError();
  }
  preflightBudget(input.state, input.questions);

  const body = {
    model: input.model ?? DEFAULT_JEV_MODEL,
    state: input.state,
    questions: input.questions,
  };
  const res = await fetchFn(JEV_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new JevRequestError(res.status, text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new JevResponseParseError(cause);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new JevResponseShapeError("answers");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.answers !== "object" || record.answers === null) {
    throw new JevResponseShapeError("answers");
  }
  if (typeof record.usage !== "object" || record.usage === null) {
    throw new JevResponseShapeError("usage");
  }
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    answers: record.answers as Record<string, JevAnswer>,
    usage: record.usage as JevUsage,
  };
}
