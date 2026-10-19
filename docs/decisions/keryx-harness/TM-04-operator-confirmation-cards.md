# TM-04: Operator Confirmation Cards

## Decisions Only the Operator May Take, Asked as a Card in `keryx shell`, and What a Card Does Not Prove

**Status**: Implemented
**Frozen**: 2026-10-15
**Task**: flow 456
**Depends on**: TM-03 (terminal confirmation token). This record changes where the operator answers, not what the answer is worth. Flow 295 (`schedule_create`) is the pattern it generalises.
**Reviewer Track**: architecture

---

## 1. Purpose

Nineteen keryx decisions are the operator's alone: lifting a review pass ceiling, confirming a review plan, deciding a held finding's premise, closing a review round, posting a review to GitHub, waiving unreviewed files or a readiness item, minting a flow completion token, landing an external agent's patch, accepting, promoting or graduating a learned pattern, and changing or running a schedule. Each CLI path refuses unless stdin and stdout are terminals. Inside `keryx shell` the agent runs commands through `shell_exec`, which has no terminal, so it stopped and told the operator to open another terminal and type a long command.

This record replaces that hand-off. In `keryx shell` each decision is a native tool. The tool shows the operator a card (what is decided, the exact effect, the subject) and takes a yes or no. The terminal paths stay exactly as they were.

## 2. The tools

| Tool | Same effect as |
|---|---|
| `review_chunks_answer` | `keryx review chunks estimate --answer yes\|no` |
| `review_confirm_plan` | `keryx review confirm-plan` |
| `review_decide_premise` | `keryx review decide-premise` |
| `review_complete` | `keryx review complete` (closes the round after every gate passes; the head is the recorded manifest head, not one the model supplies) |
| `review_publish` | `keryx review publish` |
| `review_waive_coverage` | `keryx review complete --waive-coverage` (records the waiver only) |
| `review_waive_readiness` | `keryx review complete --waive <item>` (records the waiver only) |
| `flow_confirm` | `keryx flow confirm <id> [--merged]` |
| `external_apply` | `keryx agents external apply <run-id>` |
| `learn_accept`, `learn_promote`, `learn_graduate` | `keryx learn accept`, `promote`, `graduate apply` |
| `schedule_create`, `schedule_resume`, `schedule_run`, `schedule_pause`, `schedule_remove` | `keryx schedule add`, `resume`, `run`, `pause`, `remove` |

The framework is `src/commands/operator-confirm-tools.ts`. The specs are in `operator-confirm-review.ts` and `operator-confirm-other.ts`.

**How a call runs.**
1. `buildCard` reads the real state on disk and builds the card. A card is never built from the model's input alone. A refusal (nothing to confirm) ends the call without asking.
2. The tool declares a confirmation, so the approval gate treats it as a hard floor: every permission mode asks (`auto` included), review-auto never grants it, no saved pattern or MCP trust grant applies, and an unattended run is denied.
3. The card's single-use token lives in the shell process's memory. It reaches `invoke` only after the operator's yes. A declined or denied card drops it; a replay finds nothing.
4. On yes, `apply` calls the same library function the CLI calls, in process, and re-checks that the state did not move between the card and the yes.
5. The decision is stored with `confirmedVia`: `tui-card` when the operator answered in this shell, `remote-card` when they answered in the session's remote topic. The quote is the card title plus `: yes`.

## 3. What a card proves

A person pressed yes, in this keryx shell session or in its remote topic, on a card whose text was built from the state that the decision then changed. For the remote topic, "a person" means an account on the remote allowlist (`src/remote/config.ts`) answering in the session's own topic, the same rule that governs every other remote approval. A card is never weaker than an existing `alwaysAsk` approval.

## 4. What a card does not prove

- **Who.** Nothing identifies the person. The shell session belongs to whoever sits at it, and a remote answer belongs to whichever allowlisted account pressed the button.
- **That they read it.** The card shows the decision; keryx cannot tell that anyone looked.
- **That a same-user process cannot forge the stores.** The stores are plain files in the project and under `~/.keryx`. An agent with an unrestricted shell as the same user can still write a waiver, a learning record or a token hash directly. TM-03 §5 applies unchanged. The card closes the honest path, not the dishonest one.
- **That `flow_confirm`'s token stays private.** The tool returns the minted token to the agent so it can run `flow complete --confirm-token`. The token is therefore visible to the agent. That is delegation (TM-03 §4): the operator pressed yes on a card that said what the token completes.

## 4a. What `flow_confirm` changes against TM-03

TM-03's token was minted by one verb that demanded a typed challenge on `/dev/tty`. `flow_confirm` mints the same token behind a weaker proof:

- **The challenge is one keypress or one button.** The operator presses Yes on the card in the shell, or an allowlisted Telegram account presses the button in the session's topic. No typed text, no `/dev/tty`.
- **A remote allowlisted press can mint.** The flow completion token can be minted from the remote topic, by whoever is on the allowlist and answers first.
- **The agent sees the token.** The tool returns it so the agent can run `flow complete --confirm-token`. In TM-03 the operator held it.
- The mint sites are now two: the CLI verb and the `flow_confirm` card tool. The CLI verb is unchanged.

Every other bypass in TM-03 §5 still applies.

## 4b. Safeguards the framework adds

- **Apply re-checks the state for every card.** The card is built from the state on disk, and `apply` reads it again before it writes. The binding per card: `review_publish` the target, event and body; `flow_confirm` the flow checksum and target; `learn_accept`, `learn_promote` and `learn_graduate` the content hash; `review_chunks_answer` the chunks plan; `review_waive_coverage` the coverage list; `review_waive_readiness` the readiness detail; `external_apply` the patch hash. A state that moved between the card and the yes applies nothing.
- **Schedule decisions are written to an audit log**, with the card and where the yes came from.
- **No is the default selection.** The card dialog opens with No highlighted, so an Enter typed as the dock opens declines. Yes needs a deliberate move or a click.
- **A long card is not answered remotely.** A card the topic would cut gets no remote buttons. The topic is told the card is too long and must be answered in the shell, where the dialog still answers it.
- **A nested shell refuses every card.** A keryx started from an agent's `shell_exec` carries `KERYX_TOOL_CALL=1`; an agent can type into it through a pseudo-terminal. Such a shell refuses every operator card tool, not only schedules.

## 4c. Threat model of the review operator gates (flow 457)

The review gates flow 457 added (the review cards, the terminal-only CLI paths, the plan confirmation and the operator-decision records) are aimed at a cooperating agent. They stop it from cutting corners on its own say (waiving the mutation pass, narrowing the reviewer set, running an over-threshold plan) and make every such decision visible in the package and attributable to a card or a terminal.

They do not stop a hostile agent running as the same user. Such an agent can fake a terminal with a pseudo-terminal, or write the JSON records (operator decisions, plan confirmation, run profile) directly. That is the same boundary TM-03 §5 and §4 above state, not a new one.

The package manifest carries the operator-gate stamp that `review start|attach` writes, so deleting `run-profile.json` does not make a package read as pre-457: a stamped package without its run profile is refused. The autonomous runner's exemption from the mutation gate (`src/review/coverage.ts`, `mutationErrors`) predates flow 457 and is kept on purpose: nobody is at the keyboard there to waive anything.

## 4d. Which previous round a delta round may trust (flow 458)

A delta round reviews only prevHead..head, so a forged previous round would make a round review nothing. A pull request author can commit any file to the branch, including a review package under `.metaproject/reviews/` that claims this pull request was reviewed at its base. So `review start` cuts a delta only from a round it can attribute to this pipeline:

- a `keryx:round` block on the pull request authored by our own `gh` login (a pull request author cannot post as us); or
- a package in the working tree with completion evidence (published.json, a ledger with `scopeReviewed`, or a closed status) that no commit of merge-base..head added or changed — typically an untracked one, the user's own; or
- a package read from git history whose commit is merged into the base branch (an ancestor of it): a local branch may be anybody's checked-out pull request, so an unmerged one counts for nothing on its own; or
- a package the branch did commit (keryx commits flow review packages on the PR branch by design), or an unmerged one from history, whose manifest identity (target, head, flow, mode, start's stamps — not lifecycle fields such as status), findings.json and round.json hash to an entry of the machine-local round registry. `review ingest` (of a round past its draft), `review complete` and `review publish` append that entry under the user's keryx directory (`keryxConfigDir()/review-rounds/<repo>.jsonl`), outside the repository; the file is compacted to the newest entry per package past 512 KB. `sourcesTried` says "trusted: local registry".

Anything else is a full round (`fallback-first`) with the candidate's findings attached as context only, and `sourcesTried` says why it was not trusted. On another machine the registry has no entry, so a committed package is trusted only through our own round block.

The registry moves the boundary to the user, as everywhere else in this document: it stops a pull request author, who cannot write the reviewer's home directory, from committing a fake previous round. It does not stop a hostile agent running as the same user, which can append an entry exactly as it can write any other user-owned file, or the operator-decision records of §4c. The round record itself (`round.json`, `prior_findings.json`) is hashed into the manifest at start and refused by slice, ledger build and complete when edited, which catches a cooperating agent's careless edit, not a determined one.

## 5. Why child-process proofs were rejected

The first idea was to let the CLI accept an environment variable, a file or a socket that proves "the shell's operator said yes", so the existing commands could stay the only implementation. It was rejected. `shell_exec` runs whatever command line the model writes, in an environment the model controls (`sh -c`), as a user who can read and write everything the operator can. Anything handed to that child can be read, copied or replayed by the model, so the proof would prove only that the model ran the command.

The in-process tool has no such surface. The decision never leaves the shell process: no argument, environment variable, file or socket carries it. `ask_user` was rejected for a different reason: it can be answered by review-auto, the arbiter or an answers file, and its answer returns through the model.

## 6. Remote answering

A card raised while the remote topic is active is mirrored to the topic like any other approval. The first answer wins: a press in the topic closes the dock, an answer in the dock removes the buttons in the topic. When the topic answers, the gate records `confirmedVia: "remote-card"`, so a record always says where the yes came from. Silence in the topic never ends the dock.

### 6a. What a Telegram answer proves, and what it does not

Flow 464 puts the four review acts that used to need a terminal (`review confirm-plan`, `review decide-premise`, `review complete --waive` and `--waive-coverage`, `review complete`) behind cards: `review_confirm_plan`, `review_decide_premise`, `review_waive_readiness` / `review_waive_coverage`, and `review_complete`. A card the topic answers is accepted only when all of these hold: the press comes from a Telegram user id in the binding's `allowedUserIds` (a binding with none refuses every remote answer), it carries this question's token, the token is unused, and it is under one hour old. Each refusal leaves the token spent. The record keeps `pressedBy` (the Telegram user id) and `pressedAt` (the shell's clock, not Telegram's) beside `confirmedVia: "remote-card"`. A card answered in the shell has neither field. If the topic cannot be reached, the card says "Telegram mirror not delivered" and is answered in the shell.

What the press proves: someone logged in to an allowed Telegram account pressed yes on this card, within the hour, once.

What it does not prove:

- **That a person pressed.** An agent running as the same OS user can write the stores the shell reads (the confirmation records, the review package JSON) without any card, exactly the limit TM-03 and §4 state. A card narrows the honest path; it does not stop that agent.
- **That the bot token is out of the agent's reach.** The token that posts and reads the topic sits in the shell's environment or in the `BOT_TOKEN_FILE` file (owner-only, but readable by an agent running as the same OS user). Holding it, the agent can post as the bot and read updates. It cannot make Telegram report a press from an allowed user id, but it can talk to the bot API, so a press is evidence of an allowed account, not of an unreachable channel.
- **That the operator read the text the shell holds.** Whoever holds the bot token can edit or replace the text of the mirrored card. A press proves a press on a card with the real approval id, not that the operator read what the shell built.
- **That a card survives a restart.** The token and the TUI card view are process memory. A restart drops every pending card; a later press is refused with no record, and the operator asks again. A late press is also refused by serve's expiry or its resolved state, not only by keryx's token rules.
- **Message order.** Telegram can drop, delay or reorder messages. A dropped card leaves the shell waiting (the dock stays open); a delayed press can arrive after the question was answered or has aged out, and is refused by the token rules above. Nothing in the answer proves the operator saw the card text last shown, only that this token was pressed.

The pending cards (age and time left of the token) and the answered ones (with `pressedBy`) are shown in the `/remote-control` status tab, the sidebar Remote row and the `/decisions` modal.

## 7. Unattended runs

An unattended run has no approver, so the answer to a card is no. `src/trigger/unattended.ts` also lists every card tool as interactive-only and refuses it by name. The skills that used to say "ask the operator to run this in a terminal" now say: in `keryx shell` call the tool and let the operator answer it; never send the operator to a terminal; when the run is unattended, record the item as Not run, as before.

## 8. The CLI paths and the approval floor

In a real terminal every command behaves as it did. `review confirm-plan`, `review decide-premise` and `review complete` are terminal-only by a TTY check; without a terminal they point to their card tool. Without a terminal each refusal now says: inside `keryx shell`, call the `<tool>` tool, the operator answers it as a card; outside `keryx shell`, run this command in a terminal.

`touchesHumanConfirmation` (`src/lib/command-risk.ts`) already forced `ask` for `flow confirm`, `schedule add|remove|pause|resume|run`, `review chunks estimate --answer`, `review complete --waive-coverage` and `--waive`, and `review publish`. It now also covers `keryx learn accept|promote|graduate` and `keryx agents external apply` (`touchesOperatorDecision`), so a `shell_exec` attempt of any of them asks in every mode. Like the rest of that floor it is a text match and has the limits TM-03 §5 states.

## 9. References

- `src/commands/operator-confirm-tools.ts`, `operator-confirm-review.ts`, `operator-confirm-other.ts`, `schedule-tools.ts`.
- `src/commands/agent.ts`, `src/tui/tui-shell.ts`: the approval driver, the dock and the topic mirror.
- `src/lib/command-risk.ts`: `touchesHumanConfirmation`, `touchesOperatorDecision`.
- `src/trigger/unattended.ts`: interactive-only tool names.
- `src/flow/confirm-token.ts`: the token and its caveat.
- TM-03 (`TM-03-terminal-confirmation-token.md`): the token this record's `flow_confirm` mints, and the bypasses that still apply.
