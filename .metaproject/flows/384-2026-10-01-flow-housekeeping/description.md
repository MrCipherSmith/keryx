# Flow housekeeping: unique flow ids across clones, flow folders committed with the code

Status: draft, PRD and AC sent to the operator (confirmed with "Ок", message 176012)
Source: operator message 175372 (housekeeping), repeated clone-collision findings on 2026-10-01

## Problem

Flow ids are allocated from a ledger in the git common directory of one clone. A second
clone, or a branch that has not been fetched, does not see them, so two clones hand out
the same number: on 2026-10-01 origin/main held flows 360–365 that were different flows
from the local 360–365. Separately, 27 flow folders (and their review records) were
never committed, so after a pull a clone does not hold the same flows as another clone
and `keryx product index` and `keryx flow list` disagree between machines.

## Expected Outcome

After `git pull` on any clone, `keryx product index` shows the same flows and
`keryx flow list` has no duplicate id. A new flow never takes a number already used on a
remote branch this clone has seen. A flow cannot be completed with its folder missing
from git, and the rule is written down: the flow folder is committed in the same PR as
the code and again at closing.

## Outcome criteria

- After `git pull` on a second clone, `keryx flow check` reports every flow consistent and `keryx product index` lists the same number of flows as the first clone. Checked by running both commands on two clones and recorded as an `outcome-observed:` line in this flow's journal.

## Done by hand in this flow (not code)

- Local flows 360–365 renumbered to 378–383 with `keryx flow renumber` (id-map records the old ids).
- All uncommitted flow folders, review records and review notes committed in one PR.

## Out of Scope

A central id server, network calls from `flow init` without an opt-in, rewriting history,
renumbering flows that are already on main.
