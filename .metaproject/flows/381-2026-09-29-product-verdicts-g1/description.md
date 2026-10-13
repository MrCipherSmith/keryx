# Product module: observation verdicts, outcome slot at flow init, gates G1a and G1b

Status: ready
Source: operator decision on gate G1, 2026-09-29 (option 2), confirmed on the operator chat channel

## Problem

Gate G1 of the product module could not fail: the corpus had no field for an outcome criterion, so `product open` read 310 of 310 closed intents as never checked by construction. That is a defect in the gate's design, not in the implementation. Separately, an observation line records that someone looked but not what they saw, so the share of intents that did not work, which is the reason the module exists, can never be counted. And a requirements package cannot be marked observed at all: its `observed` is hard-coded false.

## Expected Outcome

The outcome slot is visible where flows are born, an observation carries a verdict that can be counted, requirements packages can record an observation, and G1 is two gates that can each fail, with the 310 of 310 recorded as the "before" arm and nothing built beyond that.

## Out of Scope

`map`, `admit`, the `product-admit` skill and the integration lines. Any gate on flow creation, freeze or completion. Any outcome criterion or observation written into an existing flow after the fact: the "before" arm stays honest.
