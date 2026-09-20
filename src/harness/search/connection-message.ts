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
export function describeConnectionFailure(reason: SearchConnectionResult["reason"]): string {
  switch (reason) {
    case "missing-credential":
      return "missing credential";
    case "rate-limited":
      return "rate limited — the provider served its bot page to this machine; retrying will not help";
    case "incompatible-response":
      return "the endpoint answered, but not with search results";
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
 * this same endpoint tells its model — crush's errSearchRateLimited reads
 * "Do not retry or rephrase; wait a few minutes or fetch known URLs directly" —
 * and it is the opposite of what a bare "search failed" invites.
 */
export const RATE_LIMITED_SEARCH_ERROR =
  "rate limited: DuckDuckGo served its bot-check page instead of results, even after retrying. Do not retry or rephrase; wait a few minutes or fetch a known URL directly";
