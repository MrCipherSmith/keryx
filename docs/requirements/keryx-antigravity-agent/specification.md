# Specification: Keryx Antigravity Agent

Version: 0.1.0

## 0. Status

**Implemented (read-only), flow 357, 2026-09-28.** Everything below is now
implemented as specified except where the two deliberate deviations are
called out: `--print-timeout <n>s`'s value comes from `ExternalRunInput.
printTimeoutSeconds` (set by `runtime.ts` from the run's own `timeoutMs`, not
from a dedicated `externalAgents.agents["antigravity-cli"].printTimeoutSeconds`
config knob — the frozen acceptance criteria did not ask for that override,
so it was not added); and `buildStreamingArgv`/`encodeStdinMessage` are not
implemented (registry `streamingInput: true` records the CLI's own
`--input-format stream-json` support, not a codec capability this release
ships — the NDJSON message shape that mode expects is unverified against a
real run, mirroring codex's identical absence for its own no-streaming-input
agent). The `/external` block-list and the consent gate are checked on both
dispatch paths — `keryx agents external run` and a model-initiated dispatch.

## 1. Module identity

No new module. One registry row in `src/harness/external/registry.ts`
*(exists: file)*, one codec `src/harness/external/codec/antigravity-cli.ts`
added to `EXTERNAL_CODECS` in `codec/index.ts` *(exists: file)*, one entry in
`EXTERNAL_RUNTIME_CREDENTIAL_ALLOW` (`src/harness/external/env.ts` *(exists)*)
with an empty list.

## 2. Storage structure

- Run records as today for external children *(exists)*.
- Live fixtures: `fixtures/external/live/antigravity-cli/<YYYY-MM-DD>/{transcript.jsonl, outcome.json, versions.json}`.
- Consent record: `externalAgents.consent["antigravity-cli"] = { acceptedAt, keryxVersion }` in the keryx user config.

## 3. Manifest / config shape

- `externalAgents.enabled` *(exists)* — unchanged gate.
- `externalAgents.agents["antigravity-cli"].model` (optional slug; else `agy`'s default).
- `externalAgents.agents["antigravity-cli"].printTimeoutSeconds` (default = the runtime's `defaultTimeoutMs`).
- `external-providers.json` *(exists; `src/lib/external-providers.ts`)*: the built-in `providers` list gains `{ id: "antigravity-cli", reason: "Google Antigravity CLI — Google collects prompts and agent actions (Interactions) by default." }` *(planned)*.

## 4. CLI / skill surface

- `keryx agents external list|probe|run antigravity-cli` *(commands exist)*.
- `spawn_subagent` with `runtime: { kind: "external", agent: "antigravity-cli", sandbox }` *(seam exists)*.
- `/delegate antigravity-cli …` in the shell *(exists for other agents)*.

## 5. Registry row

```ts
{
  id: "antigravity-cli",
  label: "Antigravity",
  binary: "agy",
  detect: ["--version"],
  versionPattern: "(\\d+\\.\\d+\\.\\d+)",
  knownGoodRange: { min: "<version of the first recorded live run>" },
  sandboxModes: ["read-only", "worktree-write"],
  streamingInput: true,      // --input-format stream-json
  resumable: true,           // --conversation <id>
  reportsCost: false,        // usage has tokens, no price
  budgetFlag: false,
  notes: "Headless print mode, official binary only; keryx never reads Google credentials. " +
         "A tool that needs approval it cannot get is soft-denied and the run still exits 0.",
}
```

## 6. Codec

### 6.1 Argv

```
agy -p <assembled prompt>
    --output-format stream-json
    --print-timeout <n>s
    [--model <slug>]
    [--sandbox]                 # read-only mode
    [--conversation <id>]       # resume
```
Never `--dangerously-skip-permissions`. Spawned with `cwd` = the disposable worktree.

### 6.2 Events (from Google's headless docs)

| `event` | Maps to | Notes |
|---|---|---|
| `init` | run started; record `cwd`, model | fires once |
| `step_update` | progress / tool activity in the live transcript | shape per step; unknown sub-shapes → parse-skip |
| `result` | terminal outcome | `status`, `response`, `error?`, `duration_seconds`, `num_turns`, `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`, `conversation_id` |

### 6.3 Outcome classification

| Condition | Outcome |
|---|---|
| `status: SUCCESS`, no `denied_actions` | `completed` |
| `status: SUCCESS` + non-empty `result.denied_actions` | `completed-with-denials`: reported `Denied`, each action listed, any response kept as partial output |

Measured on 1.2.12 (`fixtures/external/live/antigravity-cli/2026-09-28/tool-denied.*`):
the soft denial is carried structurally as `result.denied_actions` (`[{action,
display_name}]`), with a free-text stderr notice beside it. The codec reads the
field, not the stderr text. Tool calls arrive as `step_update` with `step_type:
"tool"` (`ACTIVE` then `DONE`/`ERROR`) and map to `tool_call`/`tool_result`.
| `status: WAITING` | `blocked-on-approval` |
| `status: ERROR` + auth message / non-TTY auth exit | `not-logged-in` (fix: run `agy` once) |
| `status: ERROR` otherwise | `failed` with `error` |
| `CANCELED` / `INTERRUPTED` | `cancelled` |
| `INVALID` (e.g. unknown model) | `invalid-request` |
| no `result` before timeout | `timed-out` |

## 7. Environment and credentials

- `buildExternalChildEnv({ runtimeId: "antigravity-cli" })` *(exists)* with
  `EXTERNAL_RUNTIME_CREDENTIAL_ALLOW["antigravity-cli"] = []`: every
  credential-shaped variable is stripped; `HOME` and `PATH` pass, which is how
  `agy` finds its own login.
- No code path reads `~/.gemini/antigravity-cli/**`; a test spawns with a fake
  port and asserts the file-access log for the run contains no such path.

## 8. Privacy gate and consent

- Dispatch order: `externalAgents.enabled` → the `/external` block-list does
  not block `antigravity-cli` (or `/external` is on) → consent recorded →
  spawn. Each refusal names its reason: `external-runtime-disabled`, the
  existing `ExternalBlockedError` message, `consent-required`.
- Consent prompt (once, TTY only; non-TTY without consent → refused): states
  the terms-of-service residual risk and Google's default Interactions
  collection, links the Antigravity terms and the setting that disables
  collection.

## 9. Data contracts

- Run outcome: the existing `ExternalRunOutcome` *(exists)* plus
  `conversationId`, `usage.{thinking, cacheRead}` and `denials[]`.
- Fixture `versions.json`: `{ agy, keryx, os, recordedAt }`.

## 10. Integration points

- External runtime supervision (`superviseExternalRun`) *(exists)* — line-stream path.
- `/external` switch *(exists)* — one new block-list entry in the built-in defaults.
- TUI external-agent surfaces *(exist)* — new row, no new component.
- P0 W1 live-run harness (`bun run external:live antigravity-cli`) *(planned in W1)*.

## 11. Acceptance criteria

- AC1: `keryx agents external list` shows `antigravity-cli` with `binary-missing` when `agy` is absent and `available` with the parsed version when present; `probe` never reads a credential.
- AC2: codec unit tests over a recorded stream-json transcript produce the expected events and outcome; an unknown event increments parse-skip and does not fail the run.
- AC3: argv for read-only contains `--sandbox` and `--output-format stream-json`, never `--dangerously-skip-permissions`; resume adds `--conversation <id>`.
- AC4: every row of §6.3 is covered by a test with a recorded or synthetic line.
- AC5: the child environment for `antigravity-cli` contains no credential-shaped variable (test with a synthetic parent env containing Google, OpenAI and GitHub keys); `HOME` and `PATH` pass.
- AC6: with `/external off` and `antigravity-cli` on the block-list, dispatch is refused before spawn with `ExternalBlockedError`; without consent in non-TTY it is refused with `consent-required`; consent is recorded once and not asked again.
- AC7: a `worktree-write` dispatch to `antigravity-cli` is refused with `not-implemented` while today `worktree-write` is implemented only for ACP agents (`IMPLEMENTED_ACP_SANDBOX_MODES`); line-stream (codec) agents refuse it with `not-implemented`; `read-only` runs in the disposable worktree and produces no patch artifact.
- AC8: a live read-only run is recorded (plus worktree-write once line-stream write mode ships) under `fixtures/external/live/antigravity-cli/<date>/` and replay green; the operator guide and `docs/docs/harness.md` describe install, login, consent, data collection and limits.
