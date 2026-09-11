# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A provider built by `makeProvider("grok", …)` reports a non-2xx response with a message beginning with its registry label — `xAI (Grok) API returned HTTP <status>` — and never `Ollama`, while `describe().descriptor.providerId` is still `"ollama"`; a test covers it.
- AC2: A compat non-2xx response whose body is JSON surfaces the server's reason together with the status — from `error.message`, `error` as a string, top-level `message`, or top-level `detail` — passed through `redactSensitiveText` and at most 300 characters of reason; a non-JSON body keeps the status-only message (the C-01 invariant the OpenAI and Anthropic adapters share); an empty or reasonless body yields exactly `<Label> API returned HTTP <status>`; each shape has a test.
- AC3: The compat engine classifies 401 and 403 as `authentication` (not retryable), 429 as `rate_limit` with `retryAfterMs` taken from `Retry-After`, 5xx as `unavailable`, and other 4xx as `invalid_request`; each has a test.
- AC4: `search_code` given a `path` prints repository-relative paths (no output line contains the absolute project root), invokes ripgrep with a 400-column cap, and a clipped result states how many lines were shown out of how many; each has a test.
- AC5: `buildInteractiveAgentTools` for a cwd without `.metaproject/` omits an explicit, test-pinned list of tools whose backend reads `.metaproject/` and keeps `search_code`; for a cwd with `.metaproject/` the roster equals the list pinned before this change.
- AC6: `read_file` accepts an optional 1-based `start_line`, returns content from that line bounded by `MAX_READ_BYTES`, names the next `start_line` when it truncates, and returns output identical to today when `start_line` is absent and the file is under the cap; a test reads a line located past the first 20,000 bytes.
- AC7: `makeKeryxRunner` spawns the running keryx (the current executable and entry script) rather than resolving `keryx` from PATH; a test proves the argv it builds does not depend on PATH.
- AC8: `bun run typecheck` passes, every test file related to the changed sources passes, and a full `bun test` shows no failure that the base commit `9fba208` does not also show.
