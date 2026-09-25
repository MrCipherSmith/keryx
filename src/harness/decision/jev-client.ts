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
// `security` is a CORE zone; `harness` (this module) is CLIENT — a client
// importing a core, deterministic redactor is the allowed direction
// (`src/lib/import-zones.ts`'s directional table; only core->client is
// forbidden). The same helper `../../review/ci-triage.ts` uses over its log
// excerpt, reused here so a vendor error body gets the identical redaction
// floor before it is embedded in an Error message (flow 307 review, item 4).
import { redactSensitiveText } from "../../security/redact";

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

/**
 * Default wall-clock ceiling for one `/systemone` call. Without this a hung
 * request hung the CLI forever and left a TUI item stuck at "triaging…" with
 * no way out (flow 306 review, MEDIUM). Same order of magnitude as
 * `fetchProviderBalance`'s own `BALANCE_FETCH_TIMEOUT_MS`
 * (`src/commands/providers.ts`), the precedent this mirrors.
 */
export const DEFAULT_JEV_TIMEOUT_MS = 30_000;

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

/**
 * A non-2xx response. `body` is redacted (`redactSensitiveText`) BEFORE it is
 * embedded — same order `buildCiTriageState` uses for its own log excerpt:
 * redact first, then slice, so truncation can never cut a secret in half and
 * leave the redactor unable to see the half that remained (flow 307 review,
 * item 4). An error body can legitimately echo back the very credential that
 * was rejected (some gateways do this for "invalid key" responses); without
 * this, that credential would land verbatim in an Error message a CLI
 * printer or a TUI panel could show, or that could be logged.
 */
export class JevRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    const redactedBody = redactSensitiveText(body);
    super(`Jev request to ${JEV_ENDPOINT} failed: HTTP ${status}${redactedBody.length > 0 ? ` — ${redactedBody.slice(0, 500)}` : ""}`);
    this.name = "JevRequestError";
  }
}

/** Where the OpenRouter credential this request used came from. */
export type JevApiKeySource = "env" | "saved" | "none";

function sourceLabel(source: JevApiKeySource): string {
  if (source === "env") return "the OPENROUTER_API_KEY environment variable";
  if (source === "saved") return "the saved OpenRouter key in the keryx shell config";
  return "no credential";
}

/** True when `key` has the `sk-or-` prefix every real OpenRouter key carries. */
export function looksLikeOpenRouterKey(key: string): boolean {
  return key.startsWith("sk-or-");
}

/**
 * AC7: OpenRouter rejected the credential (HTTP 401). A subclass of
 * {@link JevRequestError} — `instanceof JevRequestError` still holds for
 * every caller that only distinguishes "non-2xx" — that additionally names
 * WHERE the rejected key came from and flags a missing `sk-or-` prefix,
 * without ever printing the key itself.
 */
export class JevAuthRejectedError extends JevRequestError {
  constructor(
    readonly source: JevApiKeySource,
    status: number,
    body: string,
    keyLooksValid: boolean,
  ) {
    const from = sourceLabel(source);
    const prefixNote = keyLooksValid
      ? ""
      : ` That key does not look like an OpenRouter key — an OpenRouter key starts with "sk-or-".`;
    // Redacted here too (not only inherited from `JevRequestError`'s own
    // redaction of the composed message): a 401 body is the shape most
    // likely to echo the rejected credential back verbatim, which is exactly
    // the case this fix targets.
    const redactedBody = redactSensitiveText(body);
    super(status, `credential from ${from} was rejected.${prefixNote}${redactedBody.length > 0 ? ` (${redactedBody.slice(0, 300)})` : ""}`);
    this.name = "JevAuthRejectedError";
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
 * The request was aborted before a response arrived — by the internal
 * `timeoutMs` ceiling, or by a caller-supplied `signal` firing first (flow
 * 306 review). Named so a caller (the CLI's generic error printer, the TUI's
 * per-item state) can react to "this never came back" differently from "it
 * came back malformed".
 */
export class JevTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Jev request to ${JEV_ENDPOINT} did not complete within ${timeoutMs}ms and was aborted.`);
    this.name = "JevTimeoutError";
  }
}

/**
 * One requested answer key came back missing, wrongly typed, or out of
 * range. Raised rather than silently defaulted: a caller that clamped a
 * malformed `noul` to `0` (the shape `computeCiTriageVerdict`'s own
 * defensive fallback used, for input that never went through this client)
 * would read a vendor error as "definitely not this bucket", which skews the
 * verdict instead of surfacing the problem (flow 306 review, INFO).
 */
export class JevAnswerValidationError extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Jev response's answer "${key}" is malformed: ${reason}`);
    this.name = "JevAnswerValidationError";
  }
}

/** {@link resolveJevApiKey}'s key, plus which of the two sources it came from (AC7). */
export interface JevApiKeyResolution {
  readonly key: string | undefined;
  readonly source: JevApiKeySource;
}

/**
 * AC2/AC7's resolution path: `OPENROUTER_API_KEY`, falling back to a saved
 * `openrouterKey` (`src/lib/shell-config.ts:28,253-254`) — the exact merge
 * `envWithSavedApiKeys` already performs for every other OpenRouter-keyed call
 * site. No new credential type. Checks the RAW env var first (rather than
 * reading it back out of the merged map) so `source` reports "env" only when
 * the caller's own environment actually set it, never when the merge helper
 * happened to leave an env-shaped key in place.
 */
export function resolveJevApiKeyResolution(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dir?: string,
): JevApiKeyResolution {
  const fromEnv = env.OPENROUTER_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { key: fromEnv, source: "env" };
  }
  const merged = envWithSavedApiKeys(env as Record<string, string | undefined>, dir);
  const fromSaved = merged.OPENROUTER_API_KEY;
  if (typeof fromSaved === "string" && fromSaved.length > 0) {
    return { key: fromSaved, source: "saved" };
  }
  return { key: undefined, source: "none" };
}

/** `resolveJevApiKeyResolution(...).key`, kept for every existing caller that only wants the key. */
export function resolveJevApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dir?: string,
): string | undefined {
  return resolveJevApiKeyResolution(env, dir).key;
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
 * Validate one answer against the question that asked it (flow 306 review,
 * INFO): every key the caller asked about must come back with the right
 * `type` and, for `noul`, a finite probability in `0..1`. A key that is
 * missing, mistyped, or out of range throws {@link JevAnswerValidationError}
 * rather than being handed to a caller that might clamp it to `0` and read a
 * vendor error as a confident "not this bucket".
 */
function validatedAnswer(key: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (typeof raw !== "object" || raw === null) {
    throw new JevAnswerValidationError(key, `expected a "${question.type}" answer, got ${JSON.stringify(raw)}`);
  }
  const a = raw as Record<string, unknown>;
  if (question.type === "noul") {
    if (a.type !== "noul") {
      throw new JevAnswerValidationError(key, `expected type "noul", got ${JSON.stringify(a.type)}`);
    }
    const noul = a.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new JevAnswerValidationError(key, `"noul" must be a finite number in 0..1, got ${JSON.stringify(noul)}`);
    }
    return { type: "noul", noul };
  }
  if (a.type !== "choice") {
    throw new JevAnswerValidationError(key, `expected type "choice", got ${JSON.stringify(a.type)}`);
  }
  const choice = a.choice;
  if (typeof choice !== "string" || choice.length === 0) {
    throw new JevAnswerValidationError(key, `"choice" must be a non-empty string, got ${JSON.stringify(choice)}`);
  }
  return { type: "choice", choice };
}

/**
 * `POST /api/v1/systemone`. AC1: injectable `fetch` (default
 * `globalThis.fetch`), `{model, state, questions}` in, parsed `{answers,
 * usage}` out — no vendor SDK, no `ProviderPort`/`makeProvider` dependency.
 *
 * `timeoutMs` (default {@link DEFAULT_JEV_TIMEOUT_MS}) always applies, even
 * when the caller passes no `signal` at all — a CLI invocation gets a bound
 * with zero extra wiring. `signal`, when given, aborts the SAME request: a
 * caller (the TUI closing its modal) can cancel early without waiting out
 * the timeout. Either firing raises {@link JevTimeoutError}.
 */
export async function callJevSystemOne(
  fetchFn: typeof fetch = globalThis.fetch,
  input: JevRequestInput,
  opts?: { env?: Readonly<Record<string, string | undefined>>; dir?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<JevResult> {
  const keyResolution = resolveJevApiKeyResolution(opts?.env ?? process.env, opts?.dir);
  const apiKey = keyResolution.key;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new JevCredentialError();
  }
  preflightBudget(input.state, input.questions);

  const body = {
    model: input.model ?? DEFAULT_JEV_MODEL,
    state: input.state,
    questions: input.questions,
  };

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = opts?.signal;
  let onExternalAbort: (() => void) | undefined;
  if (external !== undefined) {
    if (external.aborted) {
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      external.addEventListener("abort", onExternalAbort);
    }
  }

  let text: string;
  let status: number;
  let ok: boolean;
  try {
    const res = await fetchFn(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = res.status;
    ok = res.ok;
    text = await res.text();
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new JevTimeoutError(timeoutMs);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    if (onExternalAbort !== undefined) {
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  if (!ok) {
    // AC7: a 401 means OpenRouter rejected THIS credential specifically —
    // named by source, with a prefix check, rather than the generic
    // "request failed" text every other non-2xx status gets.
    if (status === 401) {
      throw new JevAuthRejectedError(keyResolution.source, status, text, looksLikeOpenRouterKey(apiKey));
    }
    throw new JevRequestError(status, text);
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
  const rawAnswers = record.answers as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(input.questions)) {
    answers[key] = validatedAnswer(key, question, rawAnswers[key]);
  }
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    answers,
    usage: record.usage as JevUsage,
  };
}
