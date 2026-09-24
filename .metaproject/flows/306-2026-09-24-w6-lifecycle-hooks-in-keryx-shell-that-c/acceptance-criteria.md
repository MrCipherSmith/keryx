# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: (W6-AC1) A PreToolUse gate hook returning {"decision":"ask"} for a call decide() would allow yields a final ask through run.ts's decision pipeline, and deny when interactive is false; covered by a test that drives runOffline.
- AC2: (W6-AC2, Wave-1 exit criterion) No hook or combination of hooks turns a decide() deny into allow or ask; a guard test registers hooks returning allow (and ask, and malformed output) against a hard-denied risk and a baseline-denied risk and asserts the final decision stays deny with hardDeny true preserved.
- AC3: (W6-AC3) A gate hook exceeding timeoutMs produces deny with reason hook-timeout under all three profiles and is recorded as a hook_invocation session record.
- AC4: (W6-AC4) An observe hook that crashes or times out does not block, is not waited on past its own timeout, does not alter the observed tool result, and records a hook-observer-failed warning.
- AC5: (Failure-semantics matrix) Tests cover every class x failure x profile cell of the W6 failure table: gate timeout/crash deny in all profiles; gate malformed output silent-approves unless decide() said ask, in which case deny; gate-advisory fails open with hook-advisory-failed in read-only-review and monitored-trusted-local and fails closed in unattended-untrusted; observe, context and SessionStart fail open with a recorded warning in every profile.
- AC6: (W6-AC5) keryx hooks validate rejects a project or user hook id colliding with a built-in (hook-id-collides-with-builtin) and rejects any file not conforming to hook-config.schema.json, with a non-zero exit under --ci; the runtime schema copy is proven identical to docs/requirements/keryx-agent-platform-expansion/schemas/hook-config.schema.json by a test.
- AC7: (W6-AC6) A spawned external subagent (deps.runExternal path) fires SubagentStart with inheritedHookIds equal to exactly the enabled hook ids whose appliesToChildAgents is true or unset, and a SubagentStart deny prevents the external run; SubagentStop fires when it resolves.
- AC8: (W6-AC6b) An internal child spawned through spawnChild() fires SubagentStart and SubagentStop with the same inheritance and deny semantics; a SubagentStart deny yields no usable extension (ok false).
- AC9: (W6-AC7) Hook invocations from unattended entry points (keryx trigger run / keryx schedule via AgentDeps.unattended, and runOffline with interactive false) carry interactive false, and a gate hook whose composed outcome would be ask resolves to deny.
- AC10: (W6-AC8) keryx hooks list --json with no config files present lists exactly the five built-ins keryx.ctx-guard, keryx.security-check-input, keryx.security-check-output, keryx.learning-observer, keryx.impact-evidence with enabled true.
- AC11: Built-ins are registered through the runtime with the W6 events/matchers/classes; keryx.learning-observer (observe, exactly seven events) and keryx.impact-evidence (gate-advisory, PreToolUse Write|Edit) are stubs whose behaviour comes from injectable ports (an observation sink for W3, an evidence provider for W8) whose defaults write nothing and return no context.
- AC12: keryx hooks test, enable and disable work: test runs one hook against a synthetic or file payload and reports decision/exit code/stdout/stderr/duration; enable/disable flip enabled in .metaproject/hooks.json (or ~/.keryx/hooks.json with --user), maintain _keryxManaged.managedHookIds, and never modify hand-authored entries they do not manage.
- AC13: Execution contract: hooks are spawned with argv (no shell), stdin JSON payload carrying the W6 camelCase fields plus Claude-Code-style snake_case aliases, a fixed env allowlist plus command.env only, per-hook timeout (default 5000, max 60000) with kill, sandbox wrapping through the existing src/harness/process/sandbox layer with network none by default and fail-closed when the sandbox is unavailable; deterministic order built-in then user then project (file order, ties by id); gate hooks sequential with first deny short-circuiting the decision, observe hooks parallel.
- AC14: The I/O codec honours decision only for gate and gate-advisory classes on gate-capable events, ignores and records an anomaly for decisions from observe/context hooks, drops updatedInput and records hook-attempted-input-rewrite once per session, accepts exit 2 as deny with stderr as reason, and caps additionalContext with a named truncation reason.
- AC15: With no hooks dependency supplied, runOffline and runAgentTurn behave byte-identically to before (existing run/replay/agent tests pass unchanged), and keryx shell's runAgentTurn applies PreToolUse tighten-only (hook deny refuses the call; hook ask forces an operator approval even in auto/trust modes; hook allow never skips an approval).
- AC16: Targeted tests of every touched module, typecheck and lint pass locally, and GitHub CI is green on the PR(s); an adversarial review round reports no finding at minor or above.
