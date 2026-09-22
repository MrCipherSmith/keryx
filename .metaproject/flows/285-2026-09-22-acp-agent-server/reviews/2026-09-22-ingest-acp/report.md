# Review — flow 285, ACP agent server (PR #646)

Three review passes ran over `src/acp/*`, `src/commands/acp.ts` and the harness seams they
touch. The first pass caught a CI-enforced contract break in the session-load path; the second
raised three defects in the bridge and the server; the third re-reviewed those fixes and found
no blocker, but caught three places where the code or its documentation said more than it could
back. All findings were acted on before merge. PR #646 merged as `57c2a37b` with 18/18 checks
green at head `6355b5c1`.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "CI guard (src/session/store.callers.test.ts) plus code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/session.ts",
    "quote": "openSession",
    "problem": "AcpSessionRegistry.load called openSession — which reaches loadContext, a reader that throws TranscriptUnreadableError — with no surrounding try, violating the repository's own caller guard.",
    "impact": "A session/load whose transcript could not be read threw out of the handler into the dispatcher's generic catch-all, giving the client an opaque internalError indistinguishable from an unknown session, with nothing actionable in it.",
    "suggested_fix": "Guard the call and rethrow an ACP-domain error carrying the session id and the original reason, then answer it as a named JSON-RPC error.",
    "evidence": "The flow's CI job `client matrix (cancel-resume)` failed on `every caller of a throwing transcript reader guards the throw`.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/session.ts AcpSessionRegistry.load"],
      "enumeration_method": "The guard test enumerates every caller of the five throwing readers across src/ and reports each un-exempt one; the ACP registry was the only new violation."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At the fix, load throws AcpSessionTranscriptUnreadableError and handleSessionLoad answers -32603 with sessionId, file and reason. A real-stdio test plants an oversized transcript, asserts the error shape, then completes a session/prompt on a second session over the SAME connection, proving the server stayed up. bun test src/session/store.callers.test.ts src/acp/session.test.ts 10 pass; test:client:cancel-resume 483 pass, 0 fail; CI 18/18 at 6355b5c1.",
      "verifier": "orchestrator re-run plus the third review pass"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the session-load guard and its two tests; merged to main in 57c2a37b via PR #646."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/agent-io.ts",
    "quote": "openToolCall",
    "problem": "A gated tool call was announced twice: the permission path minted a tool-call id, and the later onToolCall minted a second one, because the bridge's per-name queue could not tell an already-announced call from a new one.",
    "impact": "The second id was never closed — any ACP client would show a stray tool call permanently 'running' for the rest of the connection. Two concurrent approvals of the same tool also shared one id.",
    "suggested_fix": "Carry the id, the input and a claimed flag per queue entry; let an approval reuse or announce, let the later announcement adopt, and close the oldest claimed entry on a result.",
    "evidence": "The taint gate in src/commands/agent.ts calls the approver before io.onToolCall, and the bridge keyed only on tool name.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/agent-io.ts requestApproval", "src/acp/agent-io.ts onToolCall", "src/acp/agent-io.ts onToolResult"],
      "enumeration_method": "Enumerated every announcement and close site in the bridge and every approval call site in src/commands/agent.ts (onToolCall has exactly one call site, at the end of the gate), then walked each ordering the two can arrive in."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Reproduced against the pre-fix bridge: 2 tool_call updates for one call, 3 for two calls; 13 pass / 2 fail. After the fix 15/15, and the third pass walked all six orderings (approve-then-announce, announce-then-approve, refused-before-announcement, two calls of one tool, result with nothing pending, error result) finding no leak, no double close and no wrong adoption. Note recorded: the taint gate is not reachable through the shipped ACP tool roster today, so this was a latent contract break rather than a live symptom.",
      "verifier": "third review pass plus bun test src/acp/ (109 pass, 0 fail)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the claimed-entry queue in src/acp/agent-io.ts with four new tests; merged to main in 57c2a37b via PR #646."
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (acp)",
    "severity": "major",
    "file": "src/acp/server.ts",
    "quote": "activeTurns",
    "problem": "Nothing guarded a session against two concurrent turns: session/prompt registered its turn with no busy check, and session/load could replace the registry entry under an in-flight turn.",
    "impact": "Two turns mutated the same history array, session/cancel could only reach the second one, and the first turn's finally released the second turn's slot.",
    "suggested_fix": "Refuse a second prompt and a load for a busy session with a JSON-RPC error naming the condition, and release the slot only when the stored turn is this turn.",
    "evidence": "activeTurns.set ran unconditionally in handleSessionPrompt, and the finally deleted by session id alone.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/acp/server.ts handleSessionPrompt", "src/acp/server.ts handleSessionLoad", "src/acp/session.ts AcpSessionRegistry.load"],
      "enumeration_method": "Listed every entry point that writes a session's history or replaces its registry entry: the two handlers above are the only ones, and the registry load is the only replacement path."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Demonstrated pre-fix: with the guard patched out a second prompt sent while the first turn was parked on an open permission request ran to end_turn against the same history, and session/load for the busy session was served. After: -32600 with data.condition session-busy from both handlers. The third pass verified there is no check-then-act gap by reading the dispatcher — handleLine runs the handler synchronously and the prologue reaches activeTurns.set before the first await — and confirmed the busy check sits after the unknown-session check, so a client can still tell busy from no-such-session. src/acp/concurrent-turns.process.test.ts 3 pass (1 pass / 2 fail pre-fix).",
      "verifier": "third review pass plus the flow's own process tests"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "refuseIfBusy in src/acp/server.ts and the identity-checked slot release; merged to main in 57c2a37b via PR #646."
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (acp)",
    "severity": "minor",
    "file": "src/acp/conformance.process.test.ts",
    "quote": "agent_message_chunk",
    "problem": "The conformance test asserted that the streamed text arrived and concatenated correctly, but not that it arrived in pieces.",
    "impact": "A regression from incremental session/update to a single buffered flush at end of turn — the exact failure the flow exists to prevent — would have passed the test that claims to prove streaming.",
    "suggested_fix": "Compare the agent_message_chunk texts to the fixture's text_delta events one for one.",
    "evidence": "The mid-turn window asserted a chunk existed and the final text matched.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "The regression was simulated: the ACP AgentIO was wrapped to buffer and flush one chunk at end of turn, still before the prompt reply. Every pre-existing assertion passed; the new strict equality failed with one chunk against the two expected. Restored byte-identically afterwards.",
      "verifier": "third review pass"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "shared STREAMED_TEXT_DELTAS asserted per delta in src/acp/conformance.process.test.ts; merged to main in 57c2a37b via PR #646."
    }
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "src/acp/server.ts",
    "quote": "session-busy",
    "problem": "The busy refusal, and both CLI-reference rows, told the client to send session/cancel first — but cancel only aborts the turn; the slot is freed by the turn's own exit once it observes the abort.",
    "impact": "A client that followed the remedy literally — cancel, then prompt — would be refused a second time, and the documentation would have told it to.",
    "suggested_fix": "Say to wait for the cancelled turn's own session/prompt response, and say why the wait exists.",
    "evidence": "handleSessionCancel sets cancelled and aborts; only the turn's finally deletes the slot, which for a turn parked in a long tool call is seconds later.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "The refusal text and the session/prompt and session/load rows of docs/docs/cli-reference.md now name waiting for the cancelled turn's response and explain that cancel shortens the wait rather than ending it. concurrent-turns tests still 3 pass; typecheck and eslint clean; CI 18/18 at 6355b5c1.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the wording commit on top of the fixes; merged to main in 57c2a37b via PR #646."
    }
  },
  {
    "id": "F-006",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "src/acp/agent-io.ts",
    "quote": "findIndex",
    "problem": "The comment presented 'close the oldest claimed entry' as unconditionally correct; it is correct only because the call queue is never mixed — a claimed entry never sits ahead of the unclaimed entry a result belongs to.",
    "impact": "A future caller able to hold a claimed entry open ahead of an unclaimed one would close the wrong call, and the comment would have told the author the rule already covered them.",
    "suggested_fix": "State the precondition and what a concurrent caller would need instead of this ordering argument.",
    "evidence": "The batch loop in src/commands/agent.ts is sequential per tool name, and the only concurrent path leaves every entry unclaimed while it runs.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "The comment now names the precondition and the replacement a mixed queue would require. No behaviour changed; src/acp/ suite 109 pass, CI 18/18 at 6355b5c1.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the wording commit on top of the fixes; merged to main in 57c2a37b via PR #646."
    }
  },
  {
    "id": "F-007",
    "reviewer": "code-reviewer (acp, third pass)",
    "severity": "minor",
    "file": "src/acp/server.ts",
    "quote": "data.file",
    "problem": "The new session/load transcript error puts an absolute filesystem path on the wire, which diverges from the dispatcher's stated posture of withholding filesystem detail, and was undocumented.",
    "impact": "An intentional exception read as an oversight, and a client author had no way to know the field was deliberate.",
    "suggested_fix": "Document the disclosure and its reason in the session/load row.",
    "evidence": "src/acp/dispatch.ts withholds stack detail on this wire on purpose; the new error does not.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "The session/load row now records the error code, the fields, why it is not resourceNotFound or an empty replay, and that this is the one error naming a path — the transcript under the data directory the client itself launched the agent with. CI 18/18 at 6355b5c1.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the wording commit on top of the fixes; merged to main in 57c2a37b via PR #646."
    }
  }
]
```

## Coverage

Reviewed: the ACP protocol module and its version pin, framing, dispatch, the server's six
implemented methods and the seven refusals, the session registry, the permission path, the
capability matrix, the agent-IO bridge, and the docs. The third pass additionally re-derived the
dispatcher's synchrony from source rather than trusting the fix's own comment. Not reviewed:
the rest of the repository, unchanged by this flow.

## Outcome

Seven findings: three major, four minor, all acted on and re-verified; none dismissed. Two
limitations are recorded rather than fixed: two simultaneous calls of the same tool with
byte-identical input still share one announced id (the bridge's pre-existing ambiguity), and the
busy guard refuses rather than queues, which is a product decision the fix deliberately does not
hide.
