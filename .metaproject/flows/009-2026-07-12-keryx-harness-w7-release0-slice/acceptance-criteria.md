# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: R0-01 startup — an explicitly enabled Release 0 run starts over the harness runtime + fake provider only (no external coding-agent runtime, no network socket); with the harness disabled, deterministic command behavior is byte-identical to baseline and no provider is loaded; a missing required precondition (provider/credential/model/policy/role) yields a typed `environment_blocked` result with no partial provider request; a bounded context manifest with scope and fingerprints is written and the startup event persisted before the first model request. Covers `@task-R0-01` (SC_R01/R02/R14).
- AC2: R0-02 session — sessions are append-only (`session-manifest` + `session-entry`), reconstruct into a tree with a current leaf, resume does not duplicate accepted evidence, and a prior session schema migrates deterministically. Covers SC_R06_*.
- AC3: R0-02 policy — every tool call resolves to a deterministic allow/ask/deny `harness-policy-decision` over a `policy-profile`; a hard deny cannot be overridden; approval required in headless mode fails closed; an approval is invalidated after a fingerprint change; a role cannot grant itself authority; direct flow-file mutation is denied; stale or untrusted context never becomes policy. Covers SC_R05/R07/R08/R09.
- AC4: R0-02 completion — completion is produced ONLY when required gates pass and all required evidence references exist; evidence-free completion and completion with an undisposed blocker are rejected even if the model emitted a final message; protected content is redacted before persistence (only a redacted preview, hash, category, and provenance persisted; scan failure is a blocking state); exact metrics are never fabricated. Produces a `completion-gate-result` + evidence-linked `harness-run-output`. Covers SC_R10/R11.
- AC5: R0-03 run + transport + replay — a single run assembles context→provider(fake)→tool(fake)→policy→session→completion; a read-only tool executes and its malformed input / timeout / output-overflow are bounded with typed results; budget exhaustion and loop detection stop the run with typed `budget_exceeded`/`loop_detected`; CLI and JSONL/RPC (`rpc-jsonl-envelope`) produce semantically equivalent normalized events, policy results, and gate output and a transport cannot change a policy decision; offline replay is effect-free (no live provider/network/mutating tool) and emits a typed `replay-mismatch` on divergence. Covers SC_R04/R12/R13.
- AC6: No regression / reuse / scope — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 703 pass with the new tests green and 0 fail; the W4 validator, W5 ports, and W6 fakes are REUSED (not rewritten); all durable payloads are validated via `src/contracts`; no new production dependency (`dependencies` `{}`), no provider SDK, no network, no filesystem mutation; all new code lives under `src/harness/`; the frozen requirements package, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified.
