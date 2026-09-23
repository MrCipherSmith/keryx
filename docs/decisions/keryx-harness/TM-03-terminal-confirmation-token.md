# TM-03: Terminal Confirmation Token

## A Completion Confirmation No Agent Tool Can Mint, What It Does Not Prove, and a Way Out of `completing`

**Status**: Implemented
**Frozen**: 2026-09-23
**Task**: flow 299
**Depends on**: TM-02 (flow owner and signed completion). This record is the follow-up TM-02 §7 deferred, and it corrects that section's claim that such a mechanism would be a "structural proof".
**Reviewer Track**: architecture

---

## 1. Purpose

TM-02 made every completion signature record who signed it. It stated
plainly that the record is only a **claim**: `--signed-by`, `KERYX_ACTOR` and
the local git identity can all be set by an agent. This record adds a step that
no agent **tool** can perform. A flow can require it before it completes.

It also documents, as the main output of this record, what that step does
**not** establish. The same limits apply to SAC's existing
`keryx workspace confirm-review` token. §6 says so, so that mechanism's docs stop
implying more.

## 2. The mechanism

| Part | Where | What it does |
|---|---|---|
| Mint | `keryx flow confirm <id> [--merged]`, `src/commands/flow.ts` `runConfirm` | Refuses unless stdin and stdout are both terminals, the flow is `implemented` (or `in-progress` with `--merged`), it opted in, and its criteria are frozen and unchanged. Prints what is being confirmed: the flow, its criteria checksum, how many criteria are confirmed, and the PR. Reads a random six-character code typed back **on `/dev/tty`**, not stdin. Then prints the token, once. With `--merged` the token binds only `merged`, not a commit: the commit is named later, at `flow complete --merged <commit>`, so the token does not pin which commit that is. `--merged` is accepted on an `implemented` flow that records a PR too, matching `flow complete --merged` being allowed from `implemented`; the token then binds `merged`, and a PR completion with it fails as `token_target_mismatch`. |
| Store | `<flow dir>/confirm-token.json`, `src/flow/confirm-token.ts` | Holds only the sha256 of the token, bound to `{flowId, kind: "complete", acChecksum, target}`, with `mintedAt`, `expiresAt` (10 min) and `usedAt`. `target` is the completion the operator was shown at mint: `pr:<url>`, or `merged` for `--merged`. A new mint replaces the old one. The token's visible prefix is the flow id (any number of digits), so a token pasted into the wrong flow is refused as `token_other_flow`. The store's shape is validated before use. `null`, a non-object, a missing or non-string field, or an `expiresAt` that does not parse is `token_unreadable`, never "no expiry". |
| Gate | `confirmation` gate in `complete()`, `src/flow/service.ts` | Evaluated when the attempt starts, so a slow health gate cannot expire a token that was valid then. Reported last. `skipped` unless `gates.confirmation`. Otherwise it fails, with a named reason, on each of: `token_required`, `token_not_minted`, `token_unreadable`, `token_mismatch`, `token_expired`, `token_used`, `token_other_flow`, `token_stale_criteria`, `token_target_mismatch`. The last is a completion whose target is not the one minted for: another PR after `flow implemented --pr <other>`, or `--merged` against a token minted for the PR, or the reverse. |
| Spend | passing path of `complete()` | Marked used only on a passing completion, right before the write that records the signature and `done`. A failed attempt leaves the token valid until it expires. |
| Record | `FlowSignature.confirmation` | `{mechanism: "terminal-token", tokenRef, mintedAt, consumedAt, boundTo: {kind, acChecksum, target}}`. `tokenRef` is a prefix of the stored hash, never the token. `identity` beside it is unchanged, and the `basis` vocabulary (`stated`/`derived`/`unknown`) is **not** extended. A "human-confirmed" basis would claim what §5 says cannot be shown. |

**Opt-in.** A flow opts in at creation, with `flow init --require-confirmation`,
or with `completion.require_confirmation: true` in
`.metaproject/tasks.config.json`. `flow init` reads that default once and stamps
it into the new flow's `gates`, as `gates.owner` is stamped. A later config
change never reaches an existing flow. Every other flow, including every flow
created before this record, reports the gate `skipped` and completes exactly as
before.

**Floors.** These are the same shape as SAC's.
- **No tool mints a token.** No MCP tool or agent-native tool mints one. A test
  pins the production callers of the mint to the service and the CLI verb.
- **The approval floor asks in every mode.** A shell command containing the
  words `flow confirm` sets the approval gate's hard floor
  (`touchesHumanConfirmation`, `src/lib/command-risk.ts`, word-bounded). It
  forces `ask` in every permission mode, `auto` included. This holds in keryx's
  own agent loop, in the ACP permission classifier, and on the
  supervised-codex elicitation path.
- **No grant answers the prompt.** The interactive approver never lets a
  session pattern (`keryx flow *`) or a remembered exact grant auto-approve the
  command. It never offers "always" for it (readline `A=always`, the TUI's
  exact/prefix options), and a stored pattern naming it is refused on load.
- **Unattended runs refuse it.** They refuse `flow confirm` and `flow recover`
  (`FORBIDDEN_FLOW_VERBS`). They also refuse any command or patch that names a
  `confirm-token` store, flow or SAC.
- **The harness cannot edit the store.** The harness policy and ACP already
  refuse edits to `flows/**/*.json` (`isManagedFlowFile`), and that covers the
  store.

## 3. What the record means

A spent token means this: within the TTL, someone completed an interactive
confirmation step for exactly this flow and this criteria checksum. That step
cannot be reached through any agent tool, and keryx's own supervised agents can
run it only after a person answers an approval prompt.

It does **not** say who ran the step. It does not say that the person read
anything. It does not even say that a person ran it (§5).

## 4. Handing the token to an agent

The intended use is this: a person runs `keryx flow confirm`, then gives the
token to an agent, which runs `flow complete --confirm-token`. That is
**delegation**: the person has authorized that completion. keryx cannot tell
this apart from the person running `complete` themselves, and it does not
claim to.

## 5. What keryx cannot prove (known bypasses)

On one machine, where the agent runs as the same OS user with an unrestricted
shell, nothing local proves that a person was present. Specifically:

1. **Obfuscated command text evades the approval floor.** The floor is a
   substring match on the command. `c=confirm; keryx flow $c 299`, a script
   written to a file and then run, an alias, or `bun -e` calling the mint
   directly never contains the words `flow confirm`.
2. **A pseudo-terminal can be faked.** `script -qc '<cmd>' /dev/null` gives any
   process a TTY on stdin and stdout, and a `/dev/tty` it can write the code to.
   The check blocks pipes, MCP, ACP and the trigger sandbox. It does not block
   an agent that can run `script`.
3. **The hash store can be forged.** It is a plain JSON file. An agent that can
   write files can write the sha256 of a token it chose, and then spend that
   token. It never needs to run `flow confirm`. The harness and ACP refuse the
   path, but a shell redirect is not path-classified.
4. **Agents outside keryx supervision are not gated.** An agent with its own
   shell tool, such as an editor's, never passes through keryx's approval
   prompt. That agent's host decides what it may run.
5. **The opt-in flag can be removed.** `gates.confirmation` lives in
   `flow.json`. A shell-capable agent can hand-edit it away, and the gate then
   reports `skipped`.
6. **Pasting the token delegates the completion.** See §4. A person who pastes
   the token to an agent has delegated the completion.

Closing these gaps needs something outside the agent's reach: a separate OS
user or keyring the agent cannot read, a hardware key, or an approval on
another device. None of these is in scope here.

## 6. SAC's review-confirmation token has the same limits

`keryx workspace confirm-review` (`src/sac/review-confirm-token.ts`) is the
pattern this record copies, and it has the same gaps:
- its store, `.metaproject/workspaces/<ws>/proposals/<id>.confirm-token.json`,
  holds a plain sha256 an agent can forge;
- its approval floor is matched by text: `confirm-review` or `workspace review`;
- an agent outside keryx supervision is not gated at all.

The SAC guide and the README now describe that token as friction, not proof. As
of this record, the unattended floor refuses commands and patches that name the
SAC token store. The harness policy's `isManagedFlowFile` does not cover the
SAC store, because it lives under `workspaces/`, not `flows/`. That is one more
reason not to call it a proof.

## 7. A way out of `completing`

Before this record, `complete()` left a flow in `completing` whenever something
went wrong after it entered that status:
- **The criteria changed mid-run.** `transition()` re-checked them on the way
  back to `in-progress` and threw.
- **A gate threw.** The merge, pull-request and base-branch gates had no catch.
- **The process died.**

No verb could leave `completing` except `complete()` itself:
- `completing → completing` is not an allowed transition;
- `unblock` restores the previous status, which was `completing`.

The fix has two parts. One window stays open. A failure between spending the
token and writing `done` (a process killed right there) leaves the token spent
and the flow in `completing`. The token file and `flow.json` cannot be written
atomically together. `flow recover` returns the flow to `in-progress`, and a
fresh `flow confirm` mints a new token.

- **At the source.**
  - Every gate that can throw is caught and recorded as unevaluable, naming the
    gate.
  - The failure path returns to `in-progress` without re-checking the criteria
    (`returnToInProgress`), because a changed file is what it is recording.
  - A change that lands after a passing attempt was recorded is recorded as a
    second, failed attempt. The first attempt is never rewritten. No signature
    is written and no token is spent.
  - Every later forward transition still checks the criteria.
- **`keryx flow recover <id> --reason "<why>"`**, for a flow a dead process
  left behind.
  - It is valid only from `completing`.
  - It refuses while another process holds the flow lock, since a live
    `complete` holds that lock. A `complete` killed outright (`kill -9`) leaves
    its lock behind until it goes stale, about 30 seconds. Until then the
    refusal says a crashed completion becomes recoverable once the lock goes
    stale, and `flow status` shows "completion in progress, or interrupted less
    than ~30s ago". After that, the flow shows as `interrupted`.
  - It moves the flow to `in-progress` and records a `completion-recovered`
    event. The event carries the reason, the last event before the
    interruption, and whether the criteria file is intact.
  - It never touches `signatures` or `completionAttempts`.

`flow status` and the TUI's `/flows` view both label a `completing` flow whose
lock nobody holds as `interrupted`, and name the command.

## 8. Backward compatibility

- **Additive fields.** `gates.confirmation`, `FlowSignature.confirmation` and
  the `confirmation` gate name are all optional and additive. There is no
  `schemaVersion` bump, and nothing is rewritten on read.
- **Old flows.** Every existing flow package loads, validates and passes
  `keryx flow check` unchanged. A flow without the flag reports the gate
  `skipped`. It completes, or fails, for exactly the reasons it did before.
- **Old signatures.** A signature without `confirmation` renders as before.
- **What did change.** `complete()` no longer throws when the criteria file
  changes mid-run. It returns a failed result, and the flow is `in-progress`.
- **Older keryx.** An older keryx validates `flow.json` against its own schema,
  whose gate names are a closed list. So its `flow check` flags a completion
  attempt that records the new `confirmation` gate, exactly as older builds
  flagged `owner` when that gate was added. New code reads old flows
  unchanged. Old code reading new flows is not a goal.

## 9. References

- `src/flow/confirm-token.ts`: store, check, spend, reasons, and the caveat line.
- `src/flow/service.ts`:
  - `complete()`, `confirmMint()`, `recover()`;
  - `confirmationGate`, `confirmPreconditionError`, `returnToInProgress`.
- `src/flow/store.ts`: `flowLockPathFor`, `isCompletionInterrupted`, `interruptedCompletionLine`.
- `src/commands/flow.ts`: `runConfirm` (terminal, `/dev/tty` challenge), `runRecover`, `completionSignatureNotes`.
- `src/lib/command-risk.ts`: `touchesFlowConfirm`, `touchesHumanConfirmation`.
- `src/trigger/unattended.ts`: the forbidden verbs and the protected token stores.
- `src/tui/inspector-sources.ts`, `src/tui/flow-inspector.ts`: `/flows` shows `interrupted`.
- `src/sac/review-confirm-token.ts`: the SAC token (§6).
