# Acceptance Criteria

P1 of `docs/requirements/keryx-mcp-servers/implementation-plan.md`: remote
`url` servers. The specification assigns AC3, AC8 and AC19 to this phase;
they are restated here so the flow is checkable on its own, with the
specification's numbering kept in brackets.

Every criterion is verified by RUNNING the thing it describes, against a
LOCAL mock — no live third-party network in CI, per spec AC3.

## What P0's review changed about how these are written

P0 shipped with 51 findings across four adversarial reviewers and four
rounds of post-fix verification. The last of them, F-051, was not a defect:
each round found the previous fix correct at the site it was given and
wrong one step to the side, because the acceptance criterion in use was
"does the reported reproduction now pass". That cannot converge.

So three of the criteria below are about the SHAPE of the evidence rather
than about behaviour, and they are frozen alongside the behavioural ones
deliberately. Writing them afterwards is what cost P0 four rounds.

- AC1: [spec AC3] Connecting to a LOCAL mock streamable-HTTP MCP server completes the handshake and lists tools, through the same `search_tool`/`use_tool` path stdio uses. Asserted against a real HTTP listener on a loopback port, not a stubbed transport — the transport is the part that has never run.
- AC2: A `url` server reaches the catalog, the shell's tool list and `use_tool` exactly as a stdio one does. The two transports differ in `client.ts` and nowhere above it; asserted by driving the same assertions over both.
- AC3: [spec AC19] `headers.Authorization = "Bearer ${TOKEN}"` with `TOKEN` set reaches the transport as a real header, verified by reading what the mock server RECEIVED rather than what keryx believes it sent.
- AC4: [spec AC19] With `TOKEN` unset, the server does NOT connect with an empty or literal-`${TOKEN}` bearer. It is `failed` or `needs_auth`, `doctor` names the missing variable, and the mock server records that no request carrying a hollow credential arrived. A request that is sent and rejected is not the same as one that was never sent; the criterion is the latter.
- AC5: `bearer_token_env_var` produces an `Authorization: Bearer <value>` header, obeys the same unset rule as AC4, and loses to an explicit `headers.Authorization` if both are given — with the precedence asserted, not assumed.
- AC6: [spec AC8] The publisher surface is untouched: `keryx serve-mcp`, `keryx integrate`, every retired spelling, and the existing tests for them, all still pass. `keryx mcp list` still does not start a server.
- AC7: `doctor` reports an HTTP server truthfully — reachable, unreachable, wrong status, non-MCP endpoint, and TLS failure are five distinct outcomes with five distinct messages, not one "failed". A remote server is no longer `not-attempted`.
- AC8: Secrets do not reach any report. `doctor --json`, `doctor` text and `keryx mcp list` print header NAMES and `set`/`unset`, never a token — asserted with a real token value planted in the environment and searched for in every output stream.
- AC9: A remote server is subject to every control a stdio one is: the trust gate for project scope, the approval gate on `use_tool`, `untrusted` marking on results, the result cap, and the per-tool timeout. Asserted over the HTTP path, not inherited from P0's stdio assertions.
- AC10: **Class coverage, not example coverage.** Each new rule (URL validation, header construction, transport selection, failure classification) is tested by a TABLE whose rows are the CLASS and its BOUNDARY — including members nobody reported — with meta-assertions that no class may carry fewer than three rows or no boundary row. This is F-051's remedy and it is frozen here so it cannot be deferred.
- AC11: **State coverage for every new reader or connector.** Anything that can be absent, empty, malformed, unreachable or slow is exercised once per state with the same assertions, not once on its success path.
- AC12: **No new bare `JSON.parse`, no `process.once` on a signal, and no new unbounded wait.** Extended from P0's `invariants.test.ts` to cover the HTTP path, so the properties hold over the module rather than over the sites someone remembered.
- AC13: `bun test`, `tsc --noEmit`, `bun run lint` and `keryx skills verify --bundled` are clean, all run FROM SOURCE.
