# PRD: Keryx Antigravity Agent

Version: 0.1.0

## Problem

An operator who pays for Google AI Pro or Ultra cannot spend that
subscription through keryx. keryx's Google delegation path is `gemini-acp`,
and Gemini CLI stopped serving consumer subscriptions on 2026-06-18. The only
sanctioned client for those subscriptions is Google's Antigravity CLI (`agy`),
and Google forbids third-party tools from using its OAuth token. The
[BRD](brd.md) records why keryx must drive `agy` rather than log in itself.

## Goal

`antigravity-cli` becomes a fourth external agent: dispatchable from
`keryx agents external run`, `spawn_subagent` and `/delegate`, supervised and
recorded like the others, with Google's data collection behind the `/external`
gate and no Google credential ever handled by keryx.

## Users

- **Subscription holders** who want delegated work done under their Google
  plan (primary).
- **Operators comparing agents** on one task (W1 live runs).
- **Reviewers** checking that keryx added no credential handling.

## Requirements

### R1 — Registry and detection
- R1.1 A registry entry `antigravity-cli` (label "Antigravity", binary `agy`,
  detect `--version`, sandbox modes `read-only` and `worktree-write`,
  `streamingInput: true` (stdin stream-json), `resumable: true`
  (`--conversation`), `reportsCost: false` (tokens only), `budgetFlag: false`).
- R1.2 `keryx agents external list|probe` report it with the same three
  availability states; `binary-missing` names the install page.

### R2 — Codec
- R2.1 A line-stream codec that builds argv for `agy -p <prompt>
  --output-format stream-json --print-timeout <n>s [--model <slug>]
  [--sandbox] [--conversation <id>]` and never passes
  `--dangerously-skip-permissions`.
- R2.2 It parses `init`, `step_update` and `result` events into the external
  runtime's event contract; unknown events increment the parse-skip counter.
- R2.3 It classifies the terminal `status` (`SUCCESS`, `ERROR`, `CANCELED`,
  `INTERRUPTED`, `INVALID`, `WAITING`) and a soft-denied tool (stderr notice,
  exit 0) into distinct outcomes; `WAITING` or a soft denial is never reported
  as success.
- R2.4 An authentication failure (headless exits with an auth error when no
  cached login exists) is classified `not-logged-in` with the fix "run `agy`
  once interactively".

### R3 — Isolation and environment
- R3.1 Every run happens in a disposable worktree. Release 1 is read-only:
  today `worktree-write` is implemented only for ACP agents (`IMPLEMENTED_ACP_SANDBOX_MODES`); line-stream (codec) agents refuse it with `not-implemented`. When line-stream `worktree-write` lands (P0 W1, `--write --apply`),
  `antigravity-cli` gets it with no entry change — diffs leave as a
  never-applied patch artifact (external-runtime D-04).
- R3.2 `read-only` adds `--sandbox`; neither mode relaxes `agy`'s own
  permission settings.
- R3.3 The child environment is built by `buildExternalChildEnv` with
  `runtimeId: "antigravity-cli"`; its credential allowlist entry is **empty**
  — the subscription lives in `agy`'s own config directory, reached through
  `HOME`, never through an environment variable.
- R3.4 keryx never opens, reads, copies, refreshes or forwards anything under
  `~/.gemini/antigravity-cli/` or any Google OAuth store; a test asserts no
  such path is touched.

### R4 — Privacy and consent
- R4.1 `/external` works from a block-list of provider ids and model
  patterns (`src/lib/external-providers.ts`, file
  `<keryx config dir>/external-providers.json`). The built-in defaults gain the
  id `antigravity-cli` with the reason "Google collects prompts and agent
  actions by default"; with `/external off`, a dispatch to `antigravity-cli`
  is refused before spawning through the same `ExternalBlockedError` the
  other gated destinations raise. Existing operators, whose file keryx never
  overwrites, get a one-line notice on first dispatch that the id is not on
  their list.
- R4.2 First use per operator shows a one-time acknowledgement of the
  terms-of-service residual risk and Google's default data collection; the
  acknowledgement is recorded in the keryx user config.

### R5 — Accounting and resume
- R5.1 `usage` from the `result` event (input, output, thinking,
  cache-read tokens) is recorded on the run; cost stays `missing` (not zero).
- R5.2 `conversation_id` is recorded; `resume` uses `--conversation <id>`.

### R6 — Surfaces
- R6.1 TUI: the agent appears in the external-agent picker, the live
  transcript, the Work/Meta modal and the sidebar marker like the others.
- R6.2 Docs: operator guide section (install, one-time login, consent, data
  collection, limits); `docs/docs/harness.md` external-agents list.

### R7 — Live proof
- R7.1 One recorded live run per implemented sandbox mode under
  `fixtures/external/live/antigravity-cli/<date>/`, replayed by the offline
  tests (P0 W1 AC1).

## Success criteria

- Offline: codec tests over recorded stream-json pass; parse-skip 0.
- Live: a recorded read-only run with the outcome and usage as expected; a
  worktree-write run once line-stream write mode exists.
- Security: review finds no credential access; `/external` off → refusal
  before spawn; consent recorded once.
- No regression in the other three external agents' tests.

## Risks

See [brd.md](brd.md) §6. The product-level one: Google may change the
stream-json schema without notice; the parse-skip counter and the weekly live
job (W1) are the detection, the advisory version range is the signal.

## Recommendation

Implement after the operator installs and logs in to `agy` and accepts the
residual risk. Ship as one flow; fold the live run into P0 W1 so both
subscriptions (Codex, Claude) and Google are proven in the same place.
