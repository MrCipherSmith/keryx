# Review — flow 287, ACP live-client fixes / real provider (PR #648)

Three review rounds ran over the flow 287 diff: `src/commands/acp.ts`, `src/commands/shell.ts`
(the shared resolution path), `src/acp/session-mcp.ts`, `src/acp/server.ts`,
`src/mcp-servers/tools.ts`, the echo-server test fixture, and the CLI-reference/README ACP
sections. The first pass raised seven findings against the initial T5–T11 implementation
(provider/model resolution, session/new refusal when unconfigured, client-supplied stdio
`mcpServers`, docs); one of the seven — a question about whether `allow_always` could ever be
offered for a client MCP tool — was investigated and found not to be a defect. The second pass
raised five findings against the T13 fixes, plus a follow-up defect discovered while verifying
fix (3) — a timed liveness probe would have killed a server merely busy in a long call. The third
pass found no defects. All fixed findings were acted on before merge. PR #648 merged as squash
commit `4aba62bc` into `main`, CI 18/18 green at head `a559059d84ae10c20d92bc3f1366cfa0a530ff6e`.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/commands/acp.ts",
    "quote": "resolveTuiStartup",
    "problem": "`keryx acp`'s provider resolution called `resolveTuiStartup` directly without first refreshing saved OAuth grants, unlike `keryx shell`'s own startup order, which refreshes grants before resolving the selection.",
    "impact": "A session started against a provider whose saved grant had expired would build the provider from the STALE token instead of a refreshed one, producing an auth failure the operator could not explain from the ACP error alone.",
    "suggested_fix": "Call the same grant-refresh step `keryx shell` calls, before `resolveTuiStartup`, and thread it through as an option rather than duplicating the refresh logic.",
    "evidence": "`src/commands/shell.ts` refreshes grants before its own `resolveTuiStartup` call (line ~3626); `src/commands/acp.ts`'s call (then line ~172) had no such step ahead of it.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/acp.ts (resolveTuiStartup call site)", "src/commands/shell.ts resolveTuiStartup (the shared resolver)"],
      "enumeration_method": "resolveTuiStartup has exactly two callers in src/commands/ (shell.ts and acp.ts); shell.ts's caller already refreshed grants first, acp.ts's did not — the class has one member."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix adds `shellGrantRefresh()` (src/commands/acp.ts:247) passed as `refreshGrants` into `resolveTuiStartup` (line 273), refreshing BEFORE resolution — the shell's own order. src/commands/acp.test.ts describe('T13 — the shell's order: saved grants are refreshed BEFORE the selection is resolved') test 'an expiring grok grant: the provider is built with the REFRESHED token, not the stale one' passes (stubbed token endpoint + expiring grant asserts the built provider carries the refreshed token). CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round) plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "shellGrantRefresh() ordering fix in commit 2ce9f0b2 (fix(acp): refresh grants first, share server sets, stop servers on signals, scrub what servers return); merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/server.ts",
    "quote": "startServers",
    "problem": "Every `session/new` (and `session/load`) with an `mcpServers` list started its OWN set of server processes, even when an identical list was already running for another session on the same connection.",
    "impact": "N sessions with the same client MCP configuration spawned N times the server processes, multiplying resource use and start-up latency, and making 'is this server already running' unanswerable from the session layer.",
    "suggested_fix": "Key running server sets by the content of the parsed mcpServers list (command/args/env/cwd) and share one set, refcounted, across every session that sends the same list on a connection.",
    "evidence": "`src/acp/session-mcp.ts` `startServers`/`defaultConnect` were called fresh from each `session/new`/`session/load` handler with no lookup against already-running sets.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/server.ts handleSessionNew", "src/acp/server.ts handleSessionLoad", "src/acp/session-mcp.ts startServers/defaultConnect"],
      "enumeration_method": "both ACP handlers that bind mcpServers to a session (session/new, session/load) call into session-mcp.ts's start path; neither consulted a shared registry before the fix — the class has two call sites feeding one shared defect."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix adds `acpMcpSetKey` (src/acp/session-mcp.ts:243) hashing the parsed list, and a per-connection registry refcounted by session binding (src/acp/server.ts:160, 'SHARED per connection'). src/acp/session-mcp.test.ts describe('T13 — the set key') test 'the same list gives the same key; a different env value, command or root does not' passes. src/acp/server-mcp.test.ts describe('T13 — one running set per distinct list, shared by the sessions that send it') tests 'two session/new with the same list start the working servers once; both sessions report its failures' and 'a set still used by another session survives one session's rebind; the last rebind stops it' both pass. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round) plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "acpMcpSetKey + shared refcounted server sets in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/server.ts",
    "quote": "SIGTERM",
    "problem": "`keryx acp` had no SIGTERM/SIGINT handlers, and its read loop's cleanup ran only on a normal stdin EOF; a signal killed the keryx process without stopping the client MCP server processes it had started.",
    "impact": "Killing an editor's ACP subprocess (the common case when the editor itself exits or restarts the agent) left every stdio MCP server process it had spawned running as an orphan, consuming resources indefinitely.",
    "suggested_fix": "Add SIGTERM/SIGINT handlers that abort a shared `shutdown` signal, race it against the stdin read loop, and stop every session-mcp set in the same bounded-grace path `keryx shell` already uses; put the read loop's cleanup in try/finally so it also runs on the signal path.",
    "evidence": "The read loop only closed session-mcp sets in the code path reached by stdin ending; no `process.on('SIGTERM'|'SIGINT', ...)` existed in `keryx acp`.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/acp.ts (process signal handlers)", "src/acp/server.ts runAcpServer read loop / shutdown", "src/acp/session-mcp.ts close"],
      "enumeration_method": "enumerated every way the keryx acp process can end: stdin EOF, SIGTERM, SIGINT, SIGKILL; before the fix only stdin EOF reached the session-mcp close path — SIGKILL remains unreachable by any handler and is documented as such, not claimed fixed."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix wraps the read loop in try/finally, races a `shutdown` AbortSignal against stdin, and adds SIGTERM/SIGINT handlers in `keryx acp` that exit 143/130 after stopping servers within the shell's bounded grace. src/acp/mcp-servers.process.test.ts describe('T13 — a server that only a signal stops (ECHO_SERVER_IGNORE_EOF=1)') tests 'stdin closes: keryx stops it (EOF is not enough) before exiting' and 'SIGTERM to keryx: it stops the server, then exits 143' both pass. src/acp/server-mcp.test.ts describe('T13 — shutdown stops the servers without waiting for stdin to end') test 'aborting `shutdown` resolves runAcpServer with every server closed, input still open' passes. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round) plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "try/finally read loop, shutdown AbortSignal, SIGTERM/SIGINT handlers in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/session-mcp.ts",
    "quote": "scrub",
    "problem": "Tool results and errors returned by a client-supplied MCP server were not scrubbed for secrets, and the parent process env passed to spawned servers still carried keryx's own saved credential env vars by name.",
    "impact": "A malicious or buggy client MCP server could echo back a secret (its own configured credential, or one of keryx's own saved credentials leaking through the inherited env) into a tool result, and it would reach the model, the transcript and the session record unredacted.",
    "suggested_fix": "Scrub every configured mcpServers env/header value out of tool results and error text before they leave the session-mcp layer, and strip keryx's own saved credential env keys from the child process env by name rather than relying on the server not to read them.",
    "evidence": "No scrub call existed on the tool-result/tool-error path in session-mcp.ts before the fix, and the spawned server's env was a superset of keryx's own env.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/session-mcp.ts tool result path", "src/acp/session-mcp.ts tool error path", "src/acp/session-mcp.ts spawn env construction"],
      "enumeration_method": "walked every place a client MCP server's output or environment reaches something outside the server process itself: the tool result returned to the model, the error text on a failed call, and the env the child process is spawned with."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix adds a scrub over tool results/errors (ignoring values under 8 chars) and strips keryx's saved credential env keys from the MCP parent env by name. src/acp/mcp-servers.process.test.ts describe('T13 — AC6 against a server that echoes its own credential') test 'the leaked value is redacted in the tool result, and appears in no artifact' passes. src/acp/session-mcp.test.ts describe('T13 — tool output is scrubbed too (AC6)') test 'a server that echoes its credential in a result or an error reaches the model redacted' and describe('T13 — keryx's saved credentials never reach a client server's environment') test 'every variable keryx loaded from its saved config is removed by name, whatever it is called' both pass. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round) plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "tool result/error scrub + stripped credential env keys in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/mcp-servers.process.test.ts",
    "quote": "toBeDefined",
    "problem": "Two of the round-1 process tests asserted only that a tool result or a stderr line was present, not that it carried the specific content the AC required — they would still pass with the guarded behaviour reverted.",
    "impact": "A future regression in the exact behaviour those tests were meant to pin (which secret is redacted, which condition is reported) would go undetected because the assertions were vacuous.",
    "suggested_fix": "Tighten each assertion to the specific content the AC requires, then confirm by reverting the fix and watching the test fail.",
    "evidence": "The two tests used a presence check where a content check was needed, so a revert of the underlying fix left them green.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Both tests were tightened to assert specific redacted/reported content. Journal T13 note: 'Mutation runs: each guarded fix reverted makes its test fail' — confirmed by reverting each of findings F-001 through F-004's fixes in turn and observing the corresponding test go red. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "tightened assertions in commit 2ce9f0b2, confirmed by mutation (revert-and-rerun); merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-006",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/session-mcp.ts",
    "quote": "allow_always",
    "problem": "Question raised: could a client ever be offered `allow_always` for a call to a client-supplied MCP tool, bypassing the per-call permission ask AC4 requires?",
    "impact": "If reachable, a one-time allow could silently become a standing allow for a tool whose behaviour keryx does not control, undermining AC4's per-call guarantee.",
    "suggested_fix": "N/A — investigate whether the code path can offer allow_always for a client MCP tool call before treating this as a defect.",
    "evidence": "`use_tool` calls into the same taint/approval gate as local tool calls; whether that gate ever offers allow_always for an untrusted-origin call was unverified.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Read `executeCall` and the taint gate: every `use_tool` call carries `meta.destructive: true` unconditionally, and the destructive branch never offers allow_always — only a one-time allow or a deny. This is pinned by the AC7 process test (src/acp/mcp-servers.process.test.ts describe('AC3/AC5/AC6/AC7...') test 'started with its env, tool offered, asked, run on allow; failures reported by name; secrets nowhere; process gone after close') and by src/acp/session-mcp.test.ts test 'use_tool is destructive, so every call reaches the agent's approval branch (AC4)', both of which pass against the merged code. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round)"
    },
    "disposition": {
      "state": "dismissed-incorrect",
      "evidence": "no allow_always path exists for a client MCP tool call — use_tool is unconditionally destructive, so this finding's premise does not hold. No code change was needed; confirmed against the code merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-007",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/commands/acp.ts",
    "quote": "modelParams",
    "problem": "Per-turn settings (`modelParams`, `maxOutputTokens`, `reasoningEffort`) that `keryx shell` resolves from the saved selection were not threaded into ACP turns — every ACP turn ran with defaults regardless of what was saved.",
    "impact": "A user who tuned these settings through `keryx shell` would see different turn behaviour (different sampling, different output cap, different reasoning effort) over ACP than they configured, with no indication why.",
    "suggested_fix": "Resolve these settings the same way keryx shell resolves them and pass them into the ACP turn construction.",
    "evidence": "The ACP turn-construction call omitted modelParams/maxOutputTokens/reasoningEffort, unlike the equivalent call in keryx shell.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix resolves modelParams/maxOutputTokens/reasoningEffort via the shell's own resolvers and passes them into ACP turn construction; docs record the one remaining gap (in-session overrides). src/commands/acp.test.ts describe('T13 — per-turn settings resolved the way keryx shell resolves them') test 'saved modelParams, maxOutputTokens and reasoningEffort reach the turn settings' passes. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "orchestrator (second review round) plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "turn-settings resolution wired into ACP turns in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-008",
    "reviewer": "code-reviewer (acp, third pass over the T13 fixes)",
    "severity": "major",
    "file": "src/acp/session-mcp.ts",
    "quote": "scrub",
    "problem": "The F-004 scrub matched a secret's RAW form in tool results/errors, but a result serialised through JSON.stringify (as most MCP tool results are) escapes characters like `\"` and `\\`, so the escaped form of a secret containing them did not match and was not redacted.",
    "impact": "A secret containing a quote or backslash — a realistic shape for a generated credential — would still leak through a JSON-serialised tool result despite F-004's fix, defeating AC6 for exactly the values most likely to need it.",
    "suggested_fix": "Match each secret both raw and in its JSON-escaped form, and apply the scrub after serialisation rather than before.",
    "evidence": "The round-2 review planted a credential containing a quote and a backslash and drove it through a real tool call; the raw-only scrub let the escaped form through.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/session-mcp.ts scrub function", "src/mcp-servers/tools.ts (tool result/error serialisation path)"],
      "enumeration_method": "traced every transformation a tool result undergoes between the server's raw response and the text that could reach the model: raw value, JSON.stringify escaping, then truncation — the scrub ran before escaping and so covered only the first form."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix matches each secret raw AND JSON-escaped, and moves the scrub into the tool pair via a `redact` hook in src/mcp-servers/tools.ts, applied after serialisation and before sanitise/truncate. src/acp/session-mcp.test.ts describe('T14 — the scrub survives JSON escaping and the truncation cap') test 'a secret with a quote and a backslash (db\"pass\\\\word42) is redacted in its escaped form' passes. src/acp/mcp-servers.process.test.ts describe('T14 — escaped secrets, and a shared set that recovers') test asserting a credential with a quote and backslash is redacted in the JSON-escaped result passes. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "third review pass plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "raw+escaped scrub matching via the tools.ts redact hook in commit a559059d (fix(acp): scrub secrets where server text is produced, and restart only servers that died); merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-009",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "src/mcp-servers/tools.ts",
    "quote": "truncate",
    "problem": "Truncation of an oversized tool result ran BEFORE the scrub, so a secret straddling the truncation boundary could have its trailing bytes cut off before the scrub's match ran, leaving an unredacted prefix of the secret in the truncated output.",
    "impact": "A secret longer than roughly the truncation cap, or unluckily positioned across it, would leak its leading bytes even though the same secret would be fully redacted if it appeared earlier in the result.",
    "suggested_fix": "Run the scrub before truncation, not after, so the match sees the complete value.",
    "evidence": "The pipeline order was serialise -> truncate -> scrub; a secret whose match spanned the truncation point never matched.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix reorders the pipeline so `redact` runs after serialisation and before the sanitise/truncate step. src/acp/session-mcp.test.ts describe('T14 — the scrub survives JSON escaping and the truncation cap') test 'a secret straddling the 20,000-byte cap leaves no prefix behind' passes. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "third review pass plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "redact-before-truncate ordering in commit a559059d; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-010",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "src/acp/session-mcp.ts",
    "quote": "revive",
    "problem": "F-002's shared server set had no recovery: once a server in a shared set failed to start (or died), every later session that bound to that set kept reporting the same stale failure — nothing redialled it.",
    "impact": "One transient failure at the FIRST session/new for a given mcpServers list would permanently deny that server's tools to every later session on the connection, even after whatever caused the failure was gone.",
    "suggested_fix": "When a new session binds to an existing shared set, redial any server in it that is known to be dead (failed to start, or its transport closed) before handing the set to the new session.",
    "evidence": "The shared-set registry returned the same failed server record to every subsequent binder with no redial attempt.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix adds `AcpSessionMcp.revive()`, called when a session binds to a running set, redialling servers that failed to start or whose transport closed. src/acp/mcp-servers.process.test.ts test 'a server that failed its first start is redialled when the next thread binds, and its tool works there' passes. src/acp/session-mcp.test.ts describe('T14 — revive: a shared set recovers a server known to be dead, and only that') tests 'a server that failed its first start is redialled, and its tool becomes reachable' and 'a connected server whose transport has closed (process exited) is redialled' pass. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "third review pass plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "AcpSessionMcp.revive() in commit a559059d; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-011",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "src/acp/server.ts",
    "quote": "shutdown",
    "problem": "After F-003's shutdown signal handling was added, a session/new, session/load or session/prompt racing the shutdown signal could still start work — including dialling a new client MCP server set — that the shutdown path would not wait for or clean up.",
    "impact": "A signal delivered while a request was in flight could leave a server set started AFTER the shutdown sequence began, orphaning it exactly as F-003 was meant to prevent, just on a narrower race window.",
    "suggested_fix": "Set a `stopping` flag on the shutdown abort (and again in the finally, to close the window between abort and cleanup) and refuse session/new, session/load and session/prompt with a named condition once it is set.",
    "evidence": "The shutdown abort stopped already-bound sets but did not prevent a request arriving after the abort from starting new work.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fix sets a `stopping` flag on the abort and in the finally, refusing session/new, session/load and session/prompt with `condition: \"shutting-down\"` (src/acp/server.ts:360-361). src/acp/server-mcp.test.ts describe('T14 — no session work once shutdown has begun') test 'a session/new dispatched after the abort is refused and dials nothing' passes, asserting `reply.error?.data?.[\"condition\"]` is `\"shutting-down\"`. Journal notes mutations M8b (both stopping assignments removed) fails the test; M8 (abort-only) survives because the finally assignment also closes the window — the double-assignment is load-bearing. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "third review pass plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "stopping flag (set on abort and in finally) in commit a559059d; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-012",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "docs/docs/cli-reference.md",
    "quote": "secrets",
    "problem": "The docs' description of the F-004/F-008 scrub overclaimed its coverage: it did not state the 8-character minimum, that only configured mcpServers env/header values are matched (not arbitrary secret-shaped text), or that a value the model itself copies elsewhere is not retroactively redacted.",
    "impact": "An operator reading the docs could believe the scrub is a general secret-detection mechanism and rely on it for values it does not cover, rather than treating it as the specific, bounded guarantee it is.",
    "suggested_fix": "State exactly what is scrubbed and its limits: the 8-character minimum, that it matches configured mcpServers env/header values (raw and JSON-escaped) only, and that a model-authored copy of a leaked value elsewhere in the transcript is not covered.",
    "evidence": "The pre-fix docs paragraph described the scrub in general terms with no stated limits.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "docs/docs/cli-reference.md's secrets paragraph (acp section) now states exactly what is scrubbed and its limits: the 8-char minimum, transformed (JSON-escaped) values, and model-authored copies as the stated gap. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "third review pass"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "cli-reference secrets paragraph rewritten in commit a559059d; merged to main in 4aba62bc via PR #648."
    }
  },
  {
    "id": "F-013",
    "reviewer": "code-reviewer (acp, third pass — follow-up while verifying F-010)",
    "severity": "minor",
    "file": "src/acp/session-mcp.ts",
    "quote": "REVIVE_PROBE_MS",
    "problem": "F-010's initial `revive()` used a timed liveness probe (a `tools/list` call with a timeout, REVIVE_PROBE_MS) to decide whether a shared server was dead. A server merely busy handling a long-running call would fail to answer the probe within the timeout and be treated as dead, then redialled and killed out from under an in-flight call.",
    "impact": "A server executing a legitimately slow tool call could be killed and restarted by an unrelated session binding to the same shared set, corrupting or failing the in-flight call for no reason related to the server's actual health.",
    "suggested_fix": "Drop the timed probe. Redial only servers KNOWN dead by a factual signal: failed to start, or the SDK's transport reported `onclose` (the child's pipes closed) — never by 'did not answer fast enough'.",
    "evidence": "The probe's timeout window overlapped with the echo-server fixture's HOLD_TOOL behaviour (a call held open deliberately), which the probe would have misclassified as dead.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "The timed `tools/list` probe (REVIVE_PROBE_MS) was removed; `revive()` now redials only servers with a known-dead signal: failed to start, or an `isClosed()` flag set by the stdio client from the SDK's `Protocol.onclose`. The echo-server fixture gained `ECHO_SERVER_HOLD_TOOL` (a `hold` tool handling one call at a time) to test this. src/acp/mcp-servers.process.test.ts describe('T14 — revive redials only servers known to be dead') tests 'a server whose process exited is redialled on the next bind' and 'a server busy in a long call is NOT redialled when another thread binds; the call completes' both pass. src/acp/session-mcp.test.ts describe('T14 — revive: a shared set recovers a server known to be dead, and only that') tests 'a live server that is slow to answer is NOT redialled — slowness is not death' and 'a healthy set is not redialled' pass. Journal: mutations M9 (probe restored), M10 (closed flag ignored), M11 (client never records close) each fail their tests. CI 18/18 green on PR #648 at head a559059d; merged to main in 4aba62bc.",
      "verifier": "third review pass plus the flow's own test suite"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "REVIVE_PROBE_MS removed, isClosed()-based revive in commit a559059d; merged to main in 4aba62bc via PR #648."
    }
  }
]
```

## Coverage

Reviewed: `src/commands/acp.ts` and `src/commands/shell.ts`'s shared resolution path (provider,
model, grants, turn settings), `src/acp/server.ts` (session lifecycle, shutdown, signal handling),
`src/acp/session-mcp.ts` (client-supplied stdio MCP servers: start, share, scrub, revive, stop),
`src/mcp-servers/tools.ts` (the redact hook applied to every tool result/error), the echo-server
test fixture, and the ACP sections of `docs/docs/cli-reference.md` and `README.md`. Round 1
covered the initial T5–T11 implementation; round 2 covered the T13 fixes; round 3 re-reviewed the
T14 fixes and found no defects. Not reviewed: the rest of the repository, unchanged by this flow.

## Outcome

Thirteen findings recorded across three rounds: six major, six minor, one refuted as not a
defect (F-006, `allow_always` is unreachable for a client MCP tool call — `use_tool` is
unconditionally destructive). Twelve findings were acted on and re-verified against the code
merged to main in `4aba62bc` via PR #648; none were dismissed as wont-fix or out of scope. The
third review round, re-checking the T14 fixes, found no further defects.
