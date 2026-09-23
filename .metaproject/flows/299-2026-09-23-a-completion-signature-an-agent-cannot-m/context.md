# Context

Collected deterministically by `keryx flow init` at 2026-09-23T05:23:59.256Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [2.005] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
2. [2.001] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.858] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
4. [1.813] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
5. [1.793] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Phase 1 research, 2026-09-23. Line numbers are against `feat/signed-completion-token`
at main 0.2.155. Nothing here changes code.

### A. What SAC's confirm token actually guarantees today

**The mechanism** (`src/sac/review-confirm-token.ts`):

- `mintConfirmToken` (58-83) makes 24 random bytes (base64url, :65) and stores **only its
  sha256** (:72), bound to `workspaceId`+`proposalId`, with a TTL of `CONFIRM_TOKEN_TTL_MS = 2 min`
  (:16). It writes `.metaproject/workspaces/<ws>/proposals/<id>.confirm-token.json` (:36-38) under
  a file lock, and gives the plaintext token back to the caller once.
- `consumeConfirmToken` (98-135) holds the same lock while it runs. It refuses a token that is used,
  expired, has the wrong hash or is bound to something else (:118-126). It marks the token `usedAt`
  and writes a receipt keyed by the **idempotency key** (:50-52, :130-132). A crash-recovery
  retry of the same attempt goes through without a second token (:110). A fresh attempt does not.
- An optional `securityAcknowledged` bit is written at mint time and required at consume time
  when the proposal is `needs-approval` (:127-129).

**Where the token is minted and spent:**

- Minting happens in only one place: the CLI verb `keryx workspace confirm-review`
  (`src/commands/workspace.ts:148-186`). It reads the proposal's security gate and prints it. It
  refuses when that gate is unreadable (:169-170). It refuses `needs-approval` without
  `--acknowledge-security` (:172-182).
- The token is spent in `ProposalLifecycleService.review()` for `decision: "accepted"`
  (`src/sac/proposal-lifecycle.ts:257-288`). That call comes after the SLATE-8
  `interactive` gate (:235) and before any write.
- No agent-native or MCP tool can mint one. The MCP `sac.review` tool only takes a
  `confirmToken` as input (`src/mcp/tools.ts:296-309`). `workspace_propose` has no way to get a
  token (`src/harness/tool/builtin/workspace-lifecycle-tool.ts:21-27`).

**How "the agent cannot run it" is enforced.** There is no TTY check anywhere. Enforcement
comes from three layers, and all of them key on command text:

1. **Missing tool.** No MCP or agent-native tool mints a token, so a caller that only has tools
   cannot mint one.
2. **Approval hard floor on the shell command text.** In `src/lib/command-risk.ts:343-368`,
   `SAC_REVIEW_MARKERS = ["confirm-review", "workspace review"]` is matched as a substring of the
   lower-cased command, and `touchesSacConfirmReview` returns true on a match.
   `resolveApprovalDecision` (`src/commands/permission-mode.ts:119-144`) then returns `"ask"` no
   matter the mode, `auto` included (:130-132). The floor is wired into three places:
   - keryx's own agent loop: `executeCall` in `src/commands/agent.ts:3476-3498`
   - ACP foreign agents: `src/harness/external/acp-permission.ts:137-150` and `:166-178`
   - supervised codex elicitations: `src/harness/external/supervise-mcp.ts:256-273`
3. **Unattended floor.** Trigger runs deny some verbs outright: `FORBIDDEN_FLOW_VERBS` in
   `src/trigger/unattended.ts:52-64` already covers `flow complete` and `flow ac confirm`, and
   `unattendedRefusal` runs before any permission mode (`src/commands/agent.ts:3464-3473`). SAC's
   `confirm-review` is not in that list. Unattended runs are denied it only because they have no
   approver: `agent.ts:2717-2727` fails closed when there is nobody to answer.

**Limits of SAC's guarantee.** These are measured or read from the code, not assumed:

- **Substring match.** The floor is defeated by any spelling that does not contain the marker:
  `c=confirm; keryx workspace $c-review`, a script file that is written and then run,
  `bun -e 'import {mintConfirmToken} …'`, or an alias. The comment at `command-risk.ts:354-360`
  accepts false positives. It cannot rule out false negatives.
- **The store can be forged.** The token file holds `sha256(token)` in plain JSON under
  `.metaproject/`. An agent that can write files can write a file with the hash of a token it
  chose itself and then spend that token. It does not need to run the mint command at all.
  Harness `apply_patch` and ACP edits to `flows/**/*.json` are denied (`isManagedFlowFile`,
  `src/harness/policy/engine.ts:92-96`), but `workspaces/**` is not covered, and `shell_exec`
  redirection is never path-classified.
- **It only covers agents keryx supervises.** An external agent with its own shell, such as
  Claude Code's Bash, never passes through keryx's approval gate. For that agent the only barrier
  is its host's own permission prompt.
- **A TTY check would not help either.** A child of keryx's `shell_exec` gets `/dev/null` as
  stdin, because `Bun.spawn` sets no `stdin` (`shell-exec-tool.ts:175-180`; measured:
  `child-stdin-not-tty`). But the child still inherits the controlling terminal and **can open
  `/dev/tty`** (measured: `can-open-dev-tty`). And `script -qc '<cmd>' /dev/null </dev/null` gives
  any command a TTY stdin with no human present (measured: `stdin tty: True`).
  `isTTY`/`bothStreamsAreATerminal` (`src/commands/mcp-servers.ts:677-682`) adds friction for
  pipes, MCP, ACP and the trigger sandbox. It is not proof of a human.

**Conclusion.** On one machine, where the agent runs as the same OS user with an unrestricted
shell, nothing local proves a human was present. What keryx can honestly offer:

- a confirmation step that no agent **tool** can perform;
- that keryx's own, ACP-supervised and codex-supervised agents cannot run without a human
  answering a prompt no mode lifts;
- that unattended runs cannot reach at all;
- whose record states which mechanism was used and what it cannot prove.

A real proof needs something outside the agent's reach: a separate OS user or keyring, a
hardware key, or an out-of-band device approval. That is out of scope here, and the docs should
say so.

### A. Current signing surface (flow 289)

- `Identity` and `IdentityBasis` = `"stated" | "derived" | "unknown"`; resolution order is
  `--signed-by` > `KERYX_ACTOR` > git email > unknown (`src/flow/identity.ts:18-70`).
- `FlowSignature` (`src/flow/types.ts:156-181`) is `{at, kind: "ac-confirm"|"complete", identity,
  criterion?, acChecksum, headCommit?}`.
- The schema's `identity` uses `additionalProperties: false` with a **closed `basis` enum**
  (`src/flow/schema.ts:242-253`). `flowSignature` uses `additionalProperties: true`
  (`schema.ts:254-274`). So a new **sibling field** on the signature is forward-compatible with
  older validators; a new `basis` value is not.
- Completion signing happens only on the passing path (`service.ts:1001-1011`).
  `acConfirm` is at `service.ts:589`.
- The only callers are CLI verbs: `src/commands/flow.ts:820` and `:896`. MCP exposes only
  `flow.status` (`src/mcp/tools.ts:691`).
- The CLI caveat is already worded as "a {basis} claim …, not proof a human signed"
  (`flow.ts:926-936`). Other readers of `basis`:
  - `flow status` (`flow.ts:491,497`)
  - `governance report` (`src/governance/report.ts:105-109`)
- Opt-in precedent: `FlowGates` in `types.ts:124-147` (`tasks`, `review`, `owner`), which
  `flow init` stamps into every new flow (`service.ts:271`); `ownerGate` at `service.ts:882`.
  The project-level config precedent is `.metaproject/tasks.config.json` `completion.*`, read by
  `review-gate.ts:89,198-203`.

### B. Every path that leaves a flow in `completing`

The status enters `completing` and is **persisted** before any gate runs. For the direct-merge
case this happens at `service.ts:776-777`; otherwise through `transition()` at :779. It is
persisted again at :979 by the `completion-attempt-recorded` save, which does not change status.

Paths that leave it there:

1. **AC tamper during the gates, on the failing path.** The tamper is caught at `:942-946`, the
   attempt is recorded as failed (:960, :979), and then `transition(…, "in-progress", …)` at
   :1034 calls `assertAcIntact` first (`transition()`, :210). That throws, so the status stays
   `completing`. `completion-attempts.test.ts:160-211` pins the throw (:188) but never asserts
   the status that results. This is the path flow 291 noticed.
2. **AC tamper between the save at :979 and the transition at :1017, on the passing path.**
   `transition(…, "done")` throws in the same way. The completion signature is built in memory
   (:1002) and never persisted, which is correct. The flow stays `completing`.
3. **Uncaught exceptions from gates that have no try/catch.** Once the flow is in `completing`:
   - `deps.mainMergeGate` and `verifyCommitOnMain` (:825-827);
   - `tracker.detect()` and `tracker.prStatus()` for the pull-request gate (:831-832);
   - the base-branch gate's own `tracker.detect()` and `prStatus()`, and `baseBranchCondition`
     (:860-870).

   Any throw from these leaves `completing` with **no completion attempt recorded at all**. The
   review, health and security gates are wrapped and fall back to `unevaluableGate`.
4. **Process death during `complete()`.** SIGINT, a crash, or an OOM while the health gate runs
   the full check leaves the flow in `completing`. `withFileLock` reclaims a stale lock
   (`src/lib/fs.ts:76-98`, heartbeat and stale detection), so the lock does not stay stuck, but
   the status does.

**Why there is no way out today.** `completing` may go to `done`, `in-progress` or `blocked`
(`src/flow/machine.ts:10`). Neither `done` nor `in-progress` is reachable by any verb except
`complete()` itself:

- Re-running `flow complete` hits `transition(completing → completing)`, which is not allowed
  (:779 and machine.ts:10), or the `--merged` branch, which requires `in-progress` (:774).
- `flow implemented` requires `in-progress → implemented`, which is not allowed from
  `completing`.
- `flow block` works: :1053 checks only the transition, not AC integrity. But `flow unblock`
  restores `previousStatus`, which is `completing` (:1065). That is a loop.
- `flow ac update` and `ac reseal` (:632, :695) repair the checksum but do not change status.

The only way out is hand-editing `flow.json`. The harness denies that
(`isManagedFlowFile`, `engine.ts:92-96`), unattended runs deny it
(`unattended.ts:91-100`), and it breaks the rule that the CLI is the only writer.

### B. Design direction (recommended)

- (a) **Fix paths 1 and 2 at the source.** Once the tamper has been recorded as a failed
  attempt, the failure path's move back to `in-progress` should skip the AC re-check: use
  `assertTransition` and `save`, not `transition()`. The AC integrity check still guards every
  later forward transition (`implemented`, `completing`, `done`). The failing path should also
  run in a `try/finally`, so that any throw after the flow enters `completing` (path 3) records a
  failed attempt naming the gate that could not be evaluated, and returns the flow to
  `in-progress`.
- (b) **Add `keryx flow recover <id> --reason "<why>"`** for what is left (path 4, and any flow
  already stuck on disk):
  - It is valid only from `completing`.
  - It takes the flow lock with the default 5 s timeout, so a `complete` that is still running
    makes it fail with "a completion is in progress" rather than racing it.
  - It moves the flow to `in-progress` and appends a `completion-recovered` history event with
    the reason, the last history event before the interruption, and whether the AC file is
    currently intact (reported, not required).
  - It never touches `signatures` and never writes a completion attempt.
  - It is added to `FORBIDDEN_FLOW_VERBS`.
- `flow status` should show a `completing` flow whose lock is not held as "interrupted — run
  `keryx flow recover`".

### A. Design direction (recommended)

- **Mint verb:** `keryx flow confirm <id>`, deliberately a separate command, as in SAC.
  - It refuses unless stdin and stdout are both TTYs (`bothStreamsAreATerminal`).
  - It refuses unless the flow is `implemented`, or `in-progress` for the `--merged` case.
  - It refuses unless the AC are frozen and intact.
  - It prints what is being signed: flow id and title, AC checksum, number of confirmed criteria,
    PR URL or head. It then reads a random short challenge back **from `/dev/tty`**, which
    defeats a plain pipe.
  - It prints a token with a TTL of about 10 minutes, since the health gate is slow.
  - It stores only the token's hash, bound to `{flowId, kind: "complete", acChecksum}`, under
    `.metaproject/flows/<dir>/confirm-token.json`. That path is already covered by
    `isManagedFlowFile` for harness and ACP edits.
- **Consume:** `flow complete <id> --confirm-token <t>`. A new opt-in `confirmation` gate is
  verified when `complete()` starts and recorded in `completionAttempts`. The token is marked
  used only on the passing path, and the signature is written in the same save.
- **Floors:**
  - Add `"flow confirm"` to the approval hard-floor markers, next to `SAC_REVIEW_MARKERS`.
  - Add `flow confirm` and `flow recover` to `FORBIDDEN_FLOW_VERBS`.
  - Add `confirm-token` to the unattended protected-path markers.
- **What the signature records:** keep `identity` unchanged (still `stated`, `derived` or
  `unknown`). Add a sibling field `confirmation: {mechanism: "terminal-token", tokenRef
  (a short prefix of the stored hash, never the token), mintedAt, consumedAt, boundTo: {kind,
  acChecksum}}`. Do **not** add a `"human-confirmed"` basis. That would claim more than the
  mechanism proves, and the closed `basis` enum would break older validators.
- **Opt-in:**
  - Per flow: `gates.confirmation: true`, set by `flow init --require-confirmation`.
  - Per project: `.metaproject/tasks.config.json` `completion.require_confirmation: true`.
    `flow init` stamps this into **new** flows only, as `gates.owner` is stamped, so changing
    the config later never changes old flows.
  - A flow without the flag reports the gate as `skipped`.
- **Honest limits to document** (in TM-03 and the CLI reference):
  - The command-text floors can be bypassed by obfuscated spellings.
  - A shell-capable agent can fake a pty (`script`) or forge the hash file.
  - External agents running outside keryx supervision are not gated by keryx at all.
  - A human who pastes the token to an agent has delegated the completion. That is the intended
    handoff, not a breach: the token proves that someone completed an interactive confirmation
    step within the TTL for exactly this AC checksum. It does not prove who, and it does not prove
    they read anything.
  - The opt-in flag lives in `flow.json`, which a shell-capable agent can hand-edit.
