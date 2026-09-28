# BRD: Keryx Antigravity Agent

Version: 0.1.0

## 1. Business context

keryx already delegates to three vendors' coding CLIs as child agents
(`codex-cli`, `claude-cli`, `gemini-acp`). For Google, the delegation path is
Gemini CLI over ACP. On **18 June 2026 Google moved Google AI Pro, Ultra and
unpaid users off Gemini CLI to the closed-source Antigravity CLI** (`agy`);
Gemini CLI keeps serving only Code Assist Standard/Enterprise, Workspace and
API-key users. An operator who pays for Google AI Pro or Ultra therefore can no
longer spend that subscription through `gemini-acp`.

The operator's request (2026-09-28): use the Google subscription inside keryx.
Two routes were examined:

| Route | What it does | Verdict |
|---|---|---|
| A. Subscription login inside keryx (reuse Gemini CLI / Antigravity OAuth) | keryx obtains and uses the Google OAuth token itself, like `openai-codex` | **Rejected.** Google's terms name this exact act as a breach; Google mass-suspended accounts for it in February 2026, including paying Ultra subscribers. |
| B. Drive Google's own `agy` binary in headless mode | the operator logs in to `agy` once; keryx spawns `agy -p` and reads its JSON output; the token never leaves Google's client | **Chosen**, with the residual risk in §6. |

## 2. Stakeholders

| Who | Interest |
|---|---|
| Operator (subscription holder) | Spend an already-paid Google AI subscription on delegated work; keep the Google account safe; keep private work private. |
| keryx maintainers | One more external agent without a new transport; the external-runtime contract unchanged. |
| Reviewers of keryx | No credential handling added; the privacy gate enforced, not documented only. |

## 3. Objectives

1. An operator with a Google AI Pro / Ultra subscription and `agy` logged in
   can run `keryx agents external run antigravity-cli --task "…"` and
   `spawn_subagent` with `runtime: { kind: "external", agent: "antigravity-cli" }`.
2. The run lives under keryx's policies exactly as the other external agents
   do: depth marker, credential-stripped environment, disposable worktree,
   bounded time, recorded outcome, visible in the TUI.
3. No Google credential is ever read, stored, refreshed or forwarded by keryx.
4. Private work does not reach Google unless the operator's `/external`
   setting allows it.

## 4. Success metrics

- One recorded live run per sandbox mode (read-only, worktree-write) committed
  under `fixtures/external/live/antigravity-cli/<date>/`, replaying green in
  the offline tests.
- Parse-skip counter at 0 on the recorded runs (every stream-json line the
  codec sees is understood or deliberately ignored).
- `keryx security` / review of the PR finds no path where keryx touches
  `~/.gemini/antigravity-cli/` credentials or Google OAuth tokens.
- With `/external` off for Google, a dispatch to `antigravity-cli` is refused
  before spawning, with the reason named.

## 5. Constraints

- **Terms of service.** Antigravity Additional Terms: *"Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach of this Agreement."* keryx must never be the
  thing that "accesses the Service"; Google's own binary must be.
- **Documented headless mode only.** `agy -p`, `--output-format
  stream-json|json`, `--model`, `--sandbox`, `--print-timeout`,
  `--conversation`, `--dangerously-skip-permissions` (never used by keryx), per
  https://antigravity.google/docs/cli/headless/. No undocumented flags, no
  scraping the TUI.
- **Authentication is the operator's.** Headless mode *"uses your cached
  credentials. Authenticate once with an interactive `agy` session first."*
  keryx cannot and must not check login state beyond running the binary.
- **Data collection.** Antigravity CLI collects "Interactions" (prompts and the
  agent's actions) by default. That is a destination-of-data fact the `/external`
  switch exists to govern.
- **No ACP.** Stream-json is one-way per turn (plus stdin stream-json input), so
  keryx cannot approve individual tool calls; containment is the disposable
  worktree plus `--sandbox`, as for the other line-stream agents (D-08).

## 6. Risk analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google classifies keryx-driven `agy` runs as "third-party access" and restricts the account | low–medium (terms are silent on running the official binary from another program; headless docs say the mode is *"designed for scripting, CI pipelines, and programmatic control"*) | high (account suspension) | Opt-in per operator with an explicit acknowledgement shown once; never run by default, never in CI unattended without the operator's opt-in; keryx never touches tokens; document the residual risk in the operator guide. |
| Private code sent to Google via default data collection | high if ungated | high | `/external` gate enforced at dispatch; guide explains Google's collection setting. |
| Unstable event schema (closed-source CLI, weekly releases) | high | medium | Parse-skip counter, advisory version range, recorded fixtures, weekly live job (W1). |
| Quota exhaustion shared with the operator's IDE use | medium | low | Report usage per run; `--print-timeout` bound; budget stops at keryx's own ceiling. |
| `agy` soft-denies a tool it cannot get approval for and exits 0 | high | medium | Codec reads the stderr notice and the `status` field; a soft-denied run is reported as such, never as success. |

## 7. Decision

Proceed with route B as a draft package. Implementation starts only after:
(1) the operator installs `agy` and logs in once; (2) the operator confirms the
residual-risk acknowledgement in §6 applies to their account. Route A stays
rejected; revisit only if Google publishes a sanctioned third-party access path.

## 8. Sources

- Antigravity CLI headless mode — https://antigravity.google/docs/cli/headless/
- Antigravity Additional Terms of Service — https://antigravity.google/terms/
- Transition of Gemini CLI to Antigravity CLI — https://github.com/google-gemini/gemini-cli/discussions/27274
- Gemini CLI authentication (Antigravity replacement notice) — https://geminicli.com/docs/get-started/authentication/
- Abuse mitigation / third-party OAuth — https://github.com/google-gemini/gemini-cli/discussions/22970
- ACP feature request — https://github.com/google-antigravity/antigravity-cli/issues/31
- The New Stack coverage — https://thenewstack.io/google-antigravity-cli/
