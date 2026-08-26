# Catch Dispositions
Version: 1.0.0

Status: **audit complete — production remediation not implemented**.

This is the canonical inventory of the fourteen validated production
comment-only catches. The targeted tests named below are the RED-phase
assertions to add or extend; no production behavior is changed by this audit.

Allowed dispositions are `intentional-fallback` for a parser/cleanup fallback
with a proven observable result, and `observable-degraded` for a typed degraded
result or contextual redaction-safe diagnostic. Raw untrusted content, secrets,
and source-text copies are forbidden.

| ID | File:line | Disposition | Observable outcome | Targeted test |
|---|---|---|---|---|
| C-01 | src/harness/provider/compat/openai-compat-provider.ts:393 | intentional-fallback | Non-2xx response emits typed `provider_error` with a generic HTTP-status message when the body is not JSON; no `model_end`. | MISSING (RED): `src/harness/provider/compat/openai-compat-provider.test.ts` — non-JSON HTTP error retains status-only `provider_error`. |
| C-02 | src/harness/provider/single-turn.ts:130 | intentional-fallback | Auto-provider resolution continues with keyed environment candidates or deterministic default when saved-shell configuration cannot be read; returned provider remains observable. | MISSING (RED): `src/harness/provider/single-turn.test.ts` — `loadShellConfig` failure falls through to keyed candidate/default. |
| C-03 | src/harness/provider/anthropic/anthropic-provider.ts:372 | intentional-fallback | Non-2xx response emits typed `provider_error` with generic Anthropic HTTP-status message; raw body and `model_end` are absent. | MISSING (RED): `src/harness/provider/anthropic/anthropic-provider.test.ts` — non-JSON HTTP body uses generic status. |
| C-04 | src/harness/provider/openai/openai-provider.ts:424 | intentional-fallback | Non-2xx response emits typed `provider_error` with generic OpenAI HTTP-status message; raw body and `model_end` are absent. | MISSING (RED): `src/harness/provider/openai/openai-provider.test.ts` — non-JSON HTTP body uses generic status. |
| C-05 | src/harness/external/supervise-mcp.ts:365 | intentional-fallback | Already-computed MCP outcome and emitted child events are returned even if post-call connection cleanup rejects. | MISSING (RED): `src/harness/external/supervise-mcp.test.ts` — connection close rejection preserves computed outcome. |
| C-06 | src/harness/tool/builtin/shell-exec-tool.ts:353 | intentional-fallback | SIGTERM against an already-exited process is ignored; timeout still returns bounded output and a redaction-safe timeout notice. | MISSING (RED): `src/harness/tool/builtin/shell-exec-tool.test.ts` — SIGTERM cleanup is fail-soft. |
| C-07 | src/harness/tool/builtin/shell-exec-tool.ts:359 | intentional-fallback | SIGKILL escalation against an already-exited process is ignored; timeout still returns bounded output and notice. | MISSING (RED): `src/harness/tool/builtin/shell-exec-tool.test.ts` — SIGKILL cleanup is fail-soft. |
| C-08 | src/harness/tool/builtin/shell-exec-tool.ts:384 | intentional-fallback | A killed stream preserves bytes collected before teardown in the bounded timeout result; reader exception does not escape. | MISSING (RED): `src/harness/tool/builtin/shell-exec-tool.test.ts` — stream-read rejection preserves prior output. |
| C-09 | src/harness/tool/builtin/background-job-registry.ts:219 | intentional-fallback | A killed background pipe stops its pump without throwing; prior output and terminal status remain available. | MISSING (RED): `src/harness/tool/builtin/background-job-registry.test.ts` — pipe-read rejection preserves output and terminal status. |
| C-10 | src/harness/tool/builtin/background-job-registry.ts:243 | intentional-fallback | Kill after process exit is ignored; registry remains terminal and no cleanup exception escapes. | MISSING (RED): `src/harness/tool/builtin/background-job-registry.test.ts` — kill-after-exit cleanup is fail-soft. |
| C-11 | src/harness/tool/builtin/workspace-lifecycle-tool.ts:100 | observable-degraded | Workspace remains created/listable when lazy Slate binding fails; binding is omitted without raw session data and needs an explicit redaction-safe degraded indicator. | MISSING (RED): `src/harness/tool/builtin/workspace-lifecycle-tool.test.ts` — rejected `writeSlate` returns created workspace with degraded-binding indication. |
| C-12 | src/harness/process/sandbox/network-run.ts:125 | intentional-fallback | `proxyWorkerUrl()` selects bundled `.js` sibling when source `.ts` worker is unavailable or unreadable. | MISSING (RED): `src/harness/process/sandbox/worker-resolution.test.ts` — `existsSync` failure selects `proxy-worker.js`. |
| C-13 | src/harness/process/sandbox/proxy.ts:144 | intentional-fallback | Invalid absolute HTTP URL falls back to a redaction-safe Host-header target; no usable host returns no target rather than throwing. | MISSING (RED): `src/harness/process/sandbox/proxy.test.ts` — malformed absolute URL uses Host-header fallback. |
| C-14 | src/harness/process/sandbox/proxy.ts:346 | intentional-fallback | Invalid absolute URL falls back to its parsed request path/query value; parser exception does not escape. | MISSING (RED): `src/harness/process/sandbox/proxy.test.ts` — malformed absolute URL preserves path fallback. |

