# Closed-flow state hole: report uncommitted state, commit flow 359, G1a split by author

Status: ready
Source: operator instruction on the operator chat channel, 2026-09-29 (confirmed after relay from arena-83)

## Problem

`flow complete` writes the closing state (status, task-done, AC confirmations with signatures, gate refusals, review records) into the working copy after the PR is already merged, and no later step commits it. Flow 359 shows it: its tracked `flow.json` and `journal.md` differ from main, and its `reviews/` folder is untracked, so main holds a stale state where the flow is not closed and the evidence that the completion gate refused for cause is missing. It will repeat on every tracked flow. Separately, gate G1a as written would measure obedience, not acceptance: nearly every flow is created by an agent that has just read the instruction to fill the outcome slot.

## Expected Outcome

A closed flow whose tracked state is uncommitted is reported where the operator looks (the end of `flow complete` and `flow status`), never gated. Flow 359's closing state is on main. G1a is defined to be read separately for flows created by a person and flows created by an agent, and the agent-created ones are named a compliance check.

## Outcome criteria

- Next tracked flow closed after this release: `keryx flow complete` prints the uncommitted-state note, and the closing state reaches main in the next PR instead of staying in a working copy. Looked at on the next two tracked flow closures.

## Out of Scope

Any gate on completion, freeze or creation. Committing untracked flows (352–364 stay local by the standing rule) or `.metaproject/data`. A new field in flow.json recording who created a flow, and any automatic classification of authorship: the split is done by hand when G1a is read. Changing where `flow complete` writes.
