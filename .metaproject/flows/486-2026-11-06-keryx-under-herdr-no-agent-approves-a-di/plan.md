# Plan

Worktree `.worktrees/hc-delegation-safety`, branch `feat/hc-delegation-safety`, from `origin/main` (0.4.11). The main checkout is 367 commits behind, so nothing is read from it.

Five lanes with disjoint files, then a live check.

## L1 Dialog input guard (`src/tui/composer-choice.ts`, `src/tui/tui-shell.ts`)

While a choice is open, listen to the renderer's paste event. A paste in the list step: restart the accept delay, swallow the next Enter whatever the gap (a following deliberate Enter still works), hand the text to a sink. A paste in the text step belongs to the input, unchanged. The sink is registered once per dock, not on the 15+ call sites, and the shell queues the text as `origin: "agent-message"` so it is framed, never the user's words. No sink: the text is dropped with a notice, and Enter is still swallowed.

Under `HC_TERMINAL_ID`, a keyboard shell approval adds to the `approved (once)` line that the author is unverified. Remote and saved-rule approvals are unchanged.

## L2 Floors (`src/lib/command-risk.ts`, `src/commands/agent.ts`, `src/commands/permission-mode.ts`, `src/commands/shell-approval.ts`)

- `touchesHcDialogControl`: `hc keys`, `hc send` with `--force` in any position, and an `HC_TERMINAL_ID=` assignment on an hc command, through the same wrappers and quoting spellings as the other families. Joins `touchesHumanConfirmation`: asks in every mode, never remembered. `hc interrupt` stays out: it stops, it cannot approve.
- `hcAgentLaunchOf(command)`: the agent an `hc run` starts (`keryx`, `claude`, `codex`, `opencode`, `gemini`, `agy`, by base name and through `env`/path forms). A new escalating floor asks in every mode unless the agent is in the session's grant set; an approval adds it; a saved rule cannot answer the first ask. A template name is treated as a launch of that name only when it is one of these. Other `hc run` commands are untouched.

Known limit, stated in the plan on purpose: these inspect the command line, so a script is not covered.

## L3 Prompt and template (`src/tui/hc-message.ts`, `src/commands/herdr.ts`, `src/commands/shell.ts`)

Rewrite the section within the 1500-character ceiling: choice rule; report channel; never answer another terminal's dialog, `--force` and `keys` only on the operator's request; `hc kill` and `hc rm` after accepting work; verify a child's result yourself; a broken normal path is reported, not silently replaced. Takes the resolved keryx path and the bus name as inputs. Stays stable for the session. The herdr template reports over the bus first.

## L4 `keryx report` (`src/bus/*`, `src/commands/report.ts`, `src/cli-registry.ts`, `docs/requirements/keryx-agent-bus/schemas/`)

New origin `external` (older readers skip the record, which is the bus's rule for unknown records). `keryx report --to @name [--from <name>] "<text>"`: body bound 2048 bytes with an error that says to put the text in a file and send the path; own rate limit, counted from the log; cannot pause or resume; refused inside a keryx tool call, as `keryx bus send` is; a clear non-zero exit when the bus is unavailable or the name is unknown. Delivery uses the existing drain sites, with a banner stating an external agent, unverified sender, not the user's words. Designed so a future external bus peer writes the same event.

## L5 Child env (`src/security/credential-shape.ts` or `src/harness/external/env-deny.ts`)

Sweep `HC_` and `HERDR_` from the external child env. `hc` can still find its default socket, so this removes identity, not access.

## Verification

Focused tests per lane, typecheck, then the live stand as its own task.

## Decisions

Operator, this session: ask once per agent per session; `hc keys` and `--force` always ask; paste goes to the queue marked unknown author; `keryx report` for non-keryx children; hard boundary later.

State × event matrix for the dialog (L1):

| state \ event | paste | Enter within delay | Enter after delay | Esc |
|---|---|---|---|---|
| list step, no paste yet | text to sink, armed | ignored | approves highlighted | cancels |
| list step, armed by paste | text to sink, stays armed | ignored | ignored once, disarms | cancels, disarms |
| text step | goes to the input | sends text | sends text | back to list |
| closed | composer's normal paste | n/a | n/a | n/a |
