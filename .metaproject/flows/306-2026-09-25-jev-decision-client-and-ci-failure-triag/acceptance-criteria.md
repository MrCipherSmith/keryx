# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/harness/decision/jev-client.ts` (a shared decision port the router will reuse) exports a function taking an injectable `fetch` (default `globalThis.fetch`) plus `{model, state, questions}` and returning the parsed `{answers, usage}` response, following the exact injected-fetch shape `fetchProviderBalance` already establishes (`src/commands/providers.balance.test.ts:8-50`) — no vendor SDK, no dependency on `ProviderPort`/`makeProvider`.
- AC2: The client reads its API key via the existing `OPENROUTER_API_KEY`/ `openrouterKey` resolution path (`src/lib/shell-config.ts:28,253-254`) and refuses with a named, non-network error when absent — it never silently sends an unauthenticated request.
- AC3: The client estimates the combined `state`+`questions` token count before sending (reusing `estimateTokens`, `src/review/cost.ts:42-44`) and refuses a request over the 64k budget with a named error identifying which side (state vs. questions) is over, rather than truncating either.
- AC4: `jev-1.13` and `jev-latest` are named exported constants; the default model is a single named constant referenced everywhere a call site needs one, never a literal string duplicated across files.
- AC5: Every test in this phase uses an injected fake `fetch` returning a canned `Response`; no test opens a real socket. Fixtures for a success response, a malformed-JSON response, a non-200 response, and a response missing `usage` each have their own test.
- AC6: A new, narrow port (following the live/fixture split `GitHubPort` already establishes — `createGhPort`/`createFixturePort`, `src/commands/review.ts:1120-1134`) fetches one failed job's log excerpt and this repository's recent run history for the same job name; no broader CI-API surface is added.
- AC7: Given a failed job's log excerpt and test name as `state`, a `choice` question (`criteria: ["flaky", "infra", "real-regression"]`) returns a probability per option. Output is advisory text (console or PR comment) naming the top option and its probability; it never triggers a rerun, a merge decision, or a status-check write.
- AC8: `keryx review ci-triage --run <id>` (or equivalent) prints the triage for a given failed run without requiring any other reviewer or a full round.
- AC9: A test proves no rerun/status-check/merge API call is made regardless of the triage output — the advisory path is the only path that exists.
- AC10: CI triage is opt-in per project (a `review.jev.ci_triage` switch, off by default) because the log excerpt leaves the machine; with it off, or with no OpenRouter key, `ci-triage` refuses with a message naming what is missing and makes no network call.
- AC11: The log excerpt sent as `state` is bounded (the failing test's output and the job's tail, within the 64k budget) and passed through `redactSensitiveText` first; a test proves a planted token never reaches the request body.
- AC12: The TUI shows CI triage: `/ci` (or the review surface) lists the latest failed runs of the current branch's PR with each job's triage and probabilities, and opens a job's detail in a modal; the flaky-vs-regression verdict is labelled advisory.
- AC13: `keryx review ci-triage` is in the command registry, `HELP_GROUPS` and the CLI reference, all text in English, and the docs state the limits (vendor-reported accuracy, advisory only, log leaves the machine).
- AC14: CI is green on the pull request and `keryx health run` passes before merge.
