# Outcome author flag: agent or human wrote the outcome criterion

Status: ready
Source: operator decision, operator chat channel 2026-09-29 (relayed by arena-83, confirmed by the operator in message 171919)

## Problem

Gate G1a of the product module reads whether new flows carry a real outcome criterion. Nearly every flow is created by an agent that has just read the instruction to fill the outcome slot, so a real criterion there measures obedience to the instruction, not acceptance by a person. Flow 364 made the split by hand. Nothing in `flow.json` records who wrote the criterion, so the split cannot be counted, only guessed.

## Expected Outcome

`flow.json` carries `outcomeAuthor` (`agent` or `human`), set at creation and changeable only through a journaled setter. `flow status` and `product index` show it. G1a and G1b are read in four cells by author. The flag marks and gates nothing.

## Outcome criteria

- After ten new flows exist that were created after this release: read `keryx product index` and count how many carry a marked author and how many read `unknown`. The mark helped if none of the ten reads `unknown` and G1a is counted in the four cells without a hand classification.

## Out of Scope

Any gate on creation, freeze or completion that reads the flag. Inferring `human` from anything (git identity, owner, environment). Rewriting old flows: a flow without the field reads `unknown`, neither agent nor human. Any new `product` command: the bulk budget of the product module (1 module, 4 commands, 1 skill, 0 subagents, 0 mandatory steps, 0 gates) is unchanged, the setter is a `flow` subcommand. Touching the Outcome criteria section of a flow created with `--outcome-author human`, not even with an example.
