# Product module P1: intent index and the open queue

Status: formalized
Source: docs/requirements/keryx-product-module/ (prd.md, specification.md, implementation-plan.md P1)

## Problem

Intent exists only as prose in one flow at a time; no set can be queried, and a
flow closing on merge discards the question of whether it helped. The package
proposes a `product` module but says its premise stands or falls on one number:
how many closed intents were never checked for effect.

## Expected Outcome

`keryx product index` derives the intent set from flows and requirements
packages (disposable data under `.metaproject/data/product/`), `keryx product
open` lists intents closed in code and never observed, both deterministic with no
model and no gate, visible in the TUI. The real-corpus number is read with a
breakdown and reported at gate G1 before `map` or `admit` are considered.

## Out of Scope

`map` (P2), `admit` and the `product-admit` skill (P3), the three integration
lines (P4). No gate, no subagent, no mandatory step, no activity report, no model
call. Depends on acceptance-layer W0 being on main.
