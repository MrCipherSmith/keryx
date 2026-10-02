# PRD: Telegram permissions parity with the shell

Status: operator answers received 2026-10-02; criteria frozen with this text. Flow 396.
Owner: MrCipherSmith. Origin: human-request (helyx-channel message 178829, 2026-10-02T19:14Z; decisions in poll 47).

## 1. Problem

The operator asked: "Why such restrictions? I said Telegram should be an interface giving, where possible, the full functionality of keryx shell. How are permissions done in helyx? It hardly asks me anything."

Observed in the topic geekom:keryx: a permission request for a Docker status check expired, and a run was cut with "Stopped: this run went over the time limit for runs started from Telegram."

What the code does today (investigated on origin/main, 0.3.63):

1. A line from Telegram runs inside the operator's own shell session (`RemoteBridge`, `src/remote/shell-bridge.ts`). It is governed by the shell's permission mode (`ask` | `trust` | `auto`, `src/commands/permission-mode.ts`), which defaults to `ask`. In `ask` only reads skip the prompt; every edit and every shell command asks. The remote profile names `remote-restricted` / `remote-read-only` (`src/harness/policy/profiles.ts`) belong to `keryx serve` HTTP turns (`src/lib/serve-runner.ts`) and do not apply to a Telegram turn. The first premise of the request (a Telegram profile that is stricter than the shell) was therefore only half right: the strictness comes from the shell default `ask`, plus the three gaps below.
2. During a Telegram turn `io.requestApproval` (`src/tui/tui-shell.ts`, ~line 5655) goes straight to the topic. It skips `evaluateShellApproval`, so the saved allowlist `~/.local/share/keryx/permissions.json` is never consulted for a Telegram turn. The local dock offers "Always allow" (exact or prefix); the Telegram prompt offers only Allow / Deny (`src/remote/http-surface.ts`, ~line 620), so nothing can ever be learned from Telegram. The allowlist holds about 20 one-off commands, so almost everything asks.
3. The approval wait is `DEFAULT_APPROVAL_TIMEOUT_MS` = 5 minutes (`src/remote/protocol.ts`), fixed in the shell bridge. An unanswered request is a denial.
4. The run limit is `runTimeoutMs` in the remote `config.json`, default 30 minutes (`src/remote/config.ts`), enforced by the bridge timer.
5. There is no way to stop a Telegram run from Telegram. The gateway refusal text for `/interrupt` says "use the Stop button on a message", but no such button exists in the code.

helyx, for comparison, has no policy of its own. It relays Claude Code permission prompts, honours `~/.claude/settings.local.json` allow patterns (`Bash(*)`, `Read(*)`, `Edit(*)`, ...), offers an "Always" button that persists a rule, and waits 10 minutes. Its quietness comes from broad allow rules plus "Always", not from a smarter policy.

## 2. Goals

Decisions of the operator (poll 47):

- G1. Default posture of a Telegram-started run is "like the shell": reads and edits inside the project without asking; dangerous things still ask.
- G2. Per-run limit for a run started from Telegram: none. A run is stopped with `/stop`.
- G3. Approval wait: 15 minutes.

Derived goals:

- G4. The Telegram approval prompt can say "Always allow", persisting a scoped rule, with the same safeguards as the local dock.
- G5. Everything is visible and revocable from the shell: settings rows, a sidebar line, a modal listing saved rules, a command and a CLI to remove one.
- G6. Nothing that works today breaks: existing `serve.json` profiles and existing remote `config.json` files keep their meaning.

## 3. Non-goals

- No new harness policy profile and no change to `resolveRemoteProfile`, `localBaselineProfile` or `serve.json`. (The idea of a "remote-shell" profile was dropped: the profiles gate `keryx serve` HTTP turns, a different surface; the Telegram turn already runs under the shell's own mode, and the ceiling rule of flow 131 D5 is satisfied by construction because the remote posture can never exceed `trust`.)
- No `auto` mode from Telegram configuration: the config key accepts `ask` and `trust` only. (`/mode auto` typed in the topic already works as in the shell, through a button confirm and then the shell's own confirm; the shell mode then follows it. Unchanged, see section 4.2.)
- No change to who may talk to the bot: `allowedUserIds` stays the only gate.
- No new network sandbox for Telegram turns. The shell has none for local turns either; parity means the same classifier floors (see section 5).
- No change to the HTTP `serve` approval broker or `serve.json approval.expirySeconds` (decision 4, section 8). The 15-minute wait applies to Telegram only.

## 4. Design

### 4.1 One setting block, in the existing remote `config.json`

Three optional keys, validated by the existing closed schema (unknown keys still rejected):

| key | values | default when absent | note |
|---|---|---|---|
| `permissionMode` | `ask` \| `trust` | `trust` | The mode a Telegram-started turn starts with while nobody has changed the shell's mode in this session (section 4.2). `auto` is not accepted here. `ask` restores today's behaviour. |
| `runTimeoutMs` | `0` = none, or 1..604800000 | `0` (none) | today default 1800000. An explicit positive value in an existing file still applies. |
| `approvalTimeoutMs` | 30000..3600000 | `900000` | delivered to the shell at registration, like `runTimeoutMs`. |

Default change is deliberate (operator decision) and applies to existing installs that never set the keys. Rollout note in section 7.

### 4.2 Effective mode for a Telegram turn

There is one permission mode per shell session, and `/mode` typed in the topic changes it exactly as `/mode` typed in the shell does. There is no separate Telegram-only mode. The config key `permissionMode` is only the starting value for Telegram-started turns. Precisely:

- The shell tracks a flag "mode changed this session", set whenever `/mode` commits a new mode, whether typed in the shell or in the topic (and whether or not it was saved to the project).
- Flag not set: a Telegram-started turn runs under the config `permissionMode` (default `trust`); the operator's own turns run under the shell mode as before (default `ask`).
- Flag set: the shell's mode wins for every turn, Telegram-started or not; the config value is ignored for the rest of the session.
- `/mode ask|trust|auto` from the topic keeps its present gateway behaviour (`ask` runs directly; `trust` and `auto` need a button press, and `auto` also the shell's own confirm). After it succeeds the shell mode is that value and the flag is set. `auto` is therefore reachable from Telegram only through that existing confirmed path, never through configuration.
- Display: the running shell (sidebar line, `/settings` rows, `/remote-policy` with no arguments) shows the mode in force and its source: `trust (Telegram default)` or `ask (shell /mode)`. `keryx serve status` is a separate process with no view of a running shell, so it prints the config default and says that a running shell's `/mode` overrides it. `/remote-policy mode <m>` changes the saved config default (and the running shell's copy of it, so it applies at once) and never touches the shell's own mode or the "changed this session" flag. The three policy values reach a shell at registration (`RegisterResponse` carries `permissionMode`, `approvalTimeoutMs` and `runTimeoutMs`).

The risk gate in `agent.ts` is untouched, so every floor the shell has still holds: `/plan` read-only denies all non-read calls; credentials, SAC/`flow confirm` confirmation, a `git-publish` lease, a `PreToolUse` hook ask and untrusted external content force a prompt; `destructive` (command classifier and patch classifier) asks under `trust`. Auto-approved Telegram calls are printed in the transcript (`◇ auto-approved (trust)`) and mirrored as an `approval` event in the remote panel, with the Telegram user id.

### 4.3 Allowlist parity

For a Telegram turn the `shell_exec` approver first runs `evaluateShellApproval` (same function the local dock uses), so a saved or session pattern auto-approves exactly as in the shell, with the same exclusions.

### 4.4 "Always allow" on the Telegram prompt

- The approval request body gains an optional `remember` offer: the pattern the shell would store (`suggestShellPatterns`: exact, or prefix when the prefix is allowed). It is offered only when the local dock would offer it (not destructive, not credentials, not SAC confirmation, no publish lease, no hook ask, no untrusted origin, `validateShellPattern` ok). Command prefixes the shell already bans from "prefix" grants (`docker *`, `git *`, `npm *`, ...) stay banned; for such a command only the exact form is offered.
- Keyboard: `Allow | Always: <pattern> | Deny`. `ApprovalDecision` gains `always`. The callback is validated like today (id generated by the server, this topic, inside the window); a press by a user not in `allowedUserIds` is ignored.
- On `always` the shell stores the pattern with `allowShellPattern`, approves this call, and the message ends with "Remembered: <pattern>". If the store refuses the pattern, the call is approved once and the message says it was not remembered.
- The pattern comes from the shell's own classification of the command that was shown, never from model text.

### 4.5 Stopping a run: `/stop`

New topic command (kind `builtin`). It cancels the turn only when that turn was started from Telegram; if no turn runs, or the running turn is the operator's own, it replies and does nothing (the router rule "a command from the topic must not stop a turn" stays true for the operator's own work). The reply of a stopped run says "Stopped by you." The wrong refusal text for `/interrupt` is corrected to point at `/stop`. `/stop` appears in `/help` and in the bot command menu. It is built before the limit default changes, because "no limit" is only acceptable with a way to stop.

### 4.6 Visibility and revocation (TUI for every function)

- `/settings`: new group "Telegram" with rows Permission mode, Run limit, Approval wait; scope label `saved`; actions run the new command `/remote-policy [mode ask|trust] [limit none|<minutes>] [wait <minutes>]`. `/remote-policy` and `/permissions` stay refused from the topic (they change safety; use the shell).
- Sidebar remote panel: one posture line (`trust · no limit · wait 15m`) and the count of saved rules; clicking opens `/permissions`.
- `/permissions`: modal listing saved allow patterns (active, inactive-with-reason) and session grants, with remove. `keryx permissions list|remove <pattern>` is the CLI twin. A removal takes effect on the next approval in a running shell (the allowlist is re-read per call).
- `keryx serve status` (and `--json`): prints the effective Telegram posture block: permission mode, run limit, approval wait, number of saved rules, number of allowed Telegram users. No ids, no token.
- The readline `/settings` table shows the same rows.

## 5. Security model

Unchanged gate: only `allowedUserIds` can send a line, press a button, or `/stop`. The bot token and shell token handling is untouched.

Still asks in a Telegram turn under `trust` (same as the shell, by construction):

- destructive shell commands and patches (classifier in `command-risk.ts`, `patch-risk.ts`: deletes, `.git`, many files, privilege escalation, downloaders and similar);
- anything touching the agent's own credential/permission files, `flow confirm` and SAC confirm-review, a peer's `git-publish` lease;
- a call that follows untrusted external content (web fetch) and any call a `PreToolUse` hook asked about;
- MCP `use_tool` calls (always destructive by classification);
- `apply_patch` outside the project root stays refused by the patch boundary;
- `/plan` (read-only) still denies every mutation.

Why: these are the floors the shell applies to the operator's own session, each one exists because a classifier miss or injected content could otherwise hand the agent authority nobody approved. Telegram adds a second channel, not a weaker policy.

New exposure and its limits:

- `trust` means an allowed Telegram user (and prompt-injection that reaches the agent through the model) can run non-destructive commands and edit project files without a tap. Mitigations: `allowedUserIds`, the floors above, per-call transcript lines, `permissionMode: ask` as a one-key rollback, `/plan`.
- "Always" can widen the allowlist from a phone. Mitigations: same validators as the local dock, no prefix for interpreters/runners, nothing offered on a floored call, every grant is recorded and listed, one command revokes it.
- No limit on a run: cost and runaway risk. Mitigation: `/stop`, and the operator can set `runTimeoutMs` back to a number.
- Not covered, same as the local shell (decision 3, section 8: parity, no Telegram-only floor): a non-destructive shell command that reads outside the project or reaches the network (for example a plain `curl` to an API) is not gated by `trust` beyond the classifier. The shell's own floors stay.

## 6. Test strategy

Unit and e2e against the fake bot API (`src/remote/fake-bot-api.ts`), no live agents and no live Telegram. Table-driven test pinning that a Telegram `trust` turn and a local `trust` turn give the same decision for the same call across every floor. Live acceptance is operator-only.

## 7. Rollout

One release, version bump above main at merge time. The three keys are optional; installs without them move to `trust`, no limit, 15 minutes. Release note says so and names the rollback (`permissionMode: "ask"`, `runTimeoutMs: 1800000`, `approvalTimeoutMs: 300000` in `~/.local/share/keryx/remote/config.json`, or `/remote-policy`). README and docs site (answer-remote-approvals, drive-keryx-remotely, cli-reference, commands-by-task, limitations) updated in the same PR. No live external agents; the operator confirms in the topic `geekom:keryx`.

## 8. Decisions (operator, 2026-10-02)

1. `/mode` typed in the topic changes the shell's permission mode, as it does locally; it is not a separate Telegram-only mode. The config `permissionMode` is the starting mode of a Telegram-started turn until `/mode` has changed the shell's mode in this session; after that the shell's mode wins. Section 4.2 states the interplay with display. `auto` stays unavailable from configuration; the shell's `/mode auto` already works from the topic (button, then shell confirm) and is followed as is.
2. No Telegram-only floor for network or outside-project commands: parity with the shell. The shell's own floors stay.
3. The 15-minute approval wait is Telegram only (`approvalTimeoutMs`). The HTTP serve expiry (`serve.json approval.expirySeconds`) is not changed.
4. `Always: <pattern>` shows the pattern in the button. Telegram limits button text; long patterns are cut to fit, the full pattern is in the message body.

The draft had recommended a separate Telegram-only mode for decision 1; the operator chose the opposite and this PRD follows the operator.
