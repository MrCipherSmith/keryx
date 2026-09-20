# Handoff: the agent bus, the shell split, and what is left

Version: 1.0.0
Written: 2026-09-20, at the end of agent bus P5 (flow 279, PR #634).

Two programmes ran beside each other over 2026-09-19/20 and are entangled in
places, so this file records both: what landed, what is open, and the exact
next step for each open item. It is a handoff, not a summary — every open item
names the command or file to start from.

## 1. The agent bus — done, P0 through P5

Requirements package: [`docs/requirements/keryx-agent-bus/`](../requirements/keryx-agent-bus/README.md).
Architecture page: `.metaproject/wiki/architecture/agent-bus.md`.

| Phase | What it added | Flow | PR |
|---|---|---|---|
| P0 | Session lease, so two `keryx shell -c` stop silently overwriting one session | 271 | #607 |
| P1 | Clone-wide bus store and the `keryx bus` CLI | 272 | #611 |
| P2 | Shells join the bus: presence, heartbeat, poller, `/bus` | 273 | #615 |
| P3 | Delivery to the agent: drains, wake, `bus_list`, `bus_send` | 274 | #620 |
| P4 | Pause leases: held turns, the `git-publish` approval floor, `bus_pause`, override | 275 | #622 |
| P5 | Wiki page, CLI reference, end-to-end evidence | 279 | #634 |

The motivating case works: one agent announces a pause, the others queue their
operator lines instead of running them, and `git push` needs approval even in
`auto` mode.

### The one thing not proven

A reply **authored by a model** through `bus_send`. The evidence
(`docs/requirements/keryx-agent-bus/evidence/`) drives the delivery path on a
live local `ollama/llama3.1` model — the message enters the agent's history
with `provenance: "tool"`, and the `ack` follows the history push by 59 ms,
which proves the ordering rather than asserting it — but that model will not
emit a well-formed tool call, so the reply there is operator-issued and
labelled as such.

**Next step, if someone wants it closed:** re-run
`docs/requirements/keryx-agent-bus/evidence/scenario-2-ask-and-reply.md`'s
Step 2 with a model competent at tool use, and replace the operator-issued
reply. Nothing in the delivery path depends on the model — the envelope, the
provenance and the ack all run before the model produces a token.

### Not built, and deliberately

MCP participation in the bus is v2 (decision D-08). No work is queued for it.

## 2. The shell god-file split — in progress, not mine

A separate programme, run from another session. Package:
`docs/requirements/keryx-shell-split/`.

| Phase | What it did | Flow | PR |
|---|---|---|---|
| P1 | Inventory of every test that reads the two god-files as source text | 276 | #623 |
| P2 | Converted those audits into behavioural tests | 277 | #625 |
| P2b | The remaining seams — and a real `process.once` bug the widened scan found | 278 | #631 |

P2b is worth knowing about beyond its own programme: the invariant test that
bans `process.once` for teardown handlers scanned a **hardcoded two-file list**,
so a live violation in `src/commands/serve.ts` sat in the gap — a second Ctrl-C
while `keryx serve` was draining killed it before `stopped` printed.

**Open:** flow 278's record still reads `in-progress` although all four tasks
are done and #631 is merged. The session that ran it was closing it when this
was written. Check with `keryx flow status 278` before touching it, and leave
it to that session if it is still active — two sessions writing one flow record
is how flow 275's state was lost once already.

**Next phases (P3, P4):** split `src/tui/tui-shell.ts` into `src/tui/shell/`
and then `src/commands/shell.ts`, each as pure movement with no behaviour
change. Both are mechanical now that the audits are behavioural.

## 3. Open items, with their next step

1. **Flow 278 not closed.** See above. `keryx flow status 278`.
2. **Duplicate flow ids 265 and 266.** Each number is taken by two different
   packages: `265-…-background-task-execution-p1` and
   `265-…-read-only-plan-toggle`; `266-…-background-task-execution-p2` and
   `266-…-tui-boot-animation`. `keryx flow list` reports the collision on every
   run. Repair with
   `keryx flow renumber <dir> --to <free id> --reason "<why>"`.
   Cause and prevention are recorded in the memory note about pre-creating flow
   packages in a PR branch: the ids were taken on `main` while the branches
   were open.
3. **Agent bus P5 review.** Flow 279's review round was not run — it was
   stopped for budget. The PR is documentation only and its checks are green,
   but the flow's completion gate wants an ingested round. Run one against the
   merged head with `keryx review ingest --target pr --ref 634 --flow 279
   --reviewers <name> --report <markdown> --verifications <json>`, then
   `keryx review complete <package> --finding <id> --disposition …`.
   Two traps, both hit during P4: the report is **markdown**, not JSON, and the
   severity vocabulary is `blocker|major|minor|info` — `nit` is silently
   mis-parsed, which once filed a minor finding as a blocker.
4. **Backlog entry 12 — `env VAR=x <cmd>` and `bash -c "<cmd>"` hide a command
   from every risk rule.** `docs/requirements/backlog.md`. The fix is in the
   shared segment parsing that the destructive classifier also reads, so it
   needs its own review with the destructive cases enumerated.

## 4. Two lessons worth keeping

**Local refs go stale within minutes when several sessions share a clone.**
Twice during this work a confident statement about another branch was wrong
because the branch had moved: once a branch was reported unpushed when it was
13 commits ahead. Fetch the specific branch before judging it.

**A subagent's report is a claim, not a result.** In this programme: a status
worker reported updating the roadmap row and had only added a changelog entry;
a docs worker reported a rescan it had not run; an evidence worker twice
reported waiting on a background run that did not exist. Each was caught by
checking the artefact rather than the report, and each would have shipped a
false statement otherwise.
