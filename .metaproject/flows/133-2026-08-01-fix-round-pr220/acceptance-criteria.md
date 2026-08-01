# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `startServeListener` assembles the turn runner, so a listener the CLI can start answers `POST /v1/turns` with 202 rather than 503. Proven over a REAL SOCKET — a listener bound on port 0, a real HTTP request, a real bearer token — not through a synthetic `ServeContext`.
- AC2: The same real-socket test covers the read routes and the terminal result, so the parity flow 131 claimed through an injected runner is claimed again through the listener: submit, poll the turn, read the events, and see the same values.
- AC3: The turn store reads through a bound of its own, sized and justified for a file that grows with content, and no longer through the config bound. A test writes an event log past the config bound and asserts every event reads back.
- AC4: `too-large` and `unreadable` are caller-visible outcomes of reading the turn store, never an empty list or a null record standing in for them. The SSE and record routes report the failure rather than answering 200-with-nothing or 404-for-a-turn-that-exists, and `finishTurn` cannot silently no-op.
- AC5: A prompt-injection finding stops conversion into a turn. All four canonical injection prompts return `rejected: true` at the `scanPrompt` boundary, and the decision is not left to a confidence threshold that the install directory's absent configuration can never change.
- AC6: There is ONE profile permissiveness ranking in the codebase. `compareProfiles` ranks `trustMode`, and a probe with `trustMode` widened returns a refusal rather than `{ok: true, widened: []}`. A guard fails if a second ranking table appears.
- AC7: The idempotency key is claimed only after everything that can reject the request has passed, so a 422-rejected prompt leaves no claim behind and the legitimate prompt still runs. Asserted against the key index, not only against `listTurnIds`.
- AC8: `sessionId`, `approvalId` and `turnId` are distinct values in production. Asserted by inequality through the real submission path, not by shape.
- AC9: The stream always closes with a terminal event. Past the backlog bound the terminal event is still recorded and the caller is told the record stopped growing, which is a different thing from the turn ending.
- AC10: An HTTP handler cannot leak an internal error. A writer that throws EACCES/ENOSPC/EROFS produces a stated 500 carrying no message, no stack and no filesystem path, driven through a real listener with a real failing writer.
- AC11: The two decorative source-level guards are rebuilt from the `config-dir` template: each self-check drives the same seam as its tree assertion, each asserts the scan reached the tree, and each has a non-zero numerator. The dead `localBaseline` clause matches what it claims to match, proven by a planted offender.
- AC12: The AC10 inventory test cannot pass on an empty fixture: it plants a file, asserts the plant, and detects a MODIFIED file and not only a created one.
- AC13: The throttle test asserts what its title claims, and the underlying eviction defect is fixed — a peer in cooldown is not preferred for eviction, proven by flooding the table and finding the cooldown intact.
- AC14: `bun test` is green on the whole suite, typecheck is clean, and the health gate passes.
- AC15: The fix round is reviewed before it merges, and the review is recorded as a managed review package. A fix round is new code; this repository has paid three times for treating it as though it were not.
</content>
