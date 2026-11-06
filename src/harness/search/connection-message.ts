import type { SearchConnectionResult } from "./types";

/**
 * Operator-facing wording for a FAILED provider connection test.
 *
 * These failure kinds are not interchangeable and must not read alike. Every
 * kind except a missing credential used to print the same "connection
 * validation failed" string, so an operator could not tell a provider refusing
 * this machine (`rate-limited`) from a dropped connection
 * (`transport-failed`) — and the obvious response to the first one, retrying,
 * is precisely the one that cannot work.
 */
export function describeConnectionFailure(reason: SearchConnectionResult["reason"], providerId?: string): string {
  switch (reason) {
    case "missing-credential":
      return "missing credential";
    case "invalid-credential":
      return "the API key was rejected — replace it with a valid key";
    case "rate-limited":
      // Two different limits wear this reason: DuckDuckGo's bot page (retrying
      // cannot help) and a provider's QPS limit (waiting is the fix).
      return providerId === "deepseek"
        ? "rate limited — DeepSeek's QPS limit; wait a few minutes and re-test"
        : "rate limited — the provider served its bot page to this machine; retrying will not help";
    case "incompatible-response":
      return "the endpoint answered, but not with search results";
    case "insufficient-balance":
      return "insufficient balance — the key works, but the account has no credit for a paid search; top up and retest";
    case "transport-failed":
    default:
      return "connection validation failed";
  }
}

/**
 * The same refusal worded for a SEARCH rather than for a connection test.
 *
 * The wording above invites one retry; a search has already spent its ladder by
 * the time this is thrown, so it must not read as an invitation to try again.
 * The useful half is "wait a few minutes": measured from this machine, a deeply
 * tripped limiter still refused after 10 minutes of quiet, and every extra
 * request of ours extended it. It is also what the one other agent that scrapes
 * this same endpoint tells its model — its rate-limit error reads
 * "Do not retry or rephrase; wait a few minutes or fetch known URLs directly" —
 * and it is the opposite of what a bare "search failed" invites.
 */
/** DeepSeek's 429 is a QPS limit, never a bot page: its own words, never the DuckDuckGo string. */
export const DEEPSEEK_RATE_LIMIT_ERROR =
  "rate limited by DeepSeek (HTTP 429): wait a few minutes, then retry; do not rephrase the query";

export const RATE_LIMITED_SEARCH_ERROR =
  "rate limited: DuckDuckGo served its bot-check page instead of results, even after retrying. Do not retry or rephrase; wait a few minutes or fetch a known URL directly";
