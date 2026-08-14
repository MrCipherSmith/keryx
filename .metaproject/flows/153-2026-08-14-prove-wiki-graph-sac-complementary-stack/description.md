# Prove wiki+graph+SAC complementary stack with reproducible runbook

Status: ready
Source: user description

## Problem

Operators and agents treat Shared Agent Context (SAC) and the project wiki as
the same “memory layer”. That hides the real split:

- the code graph is a structural index;
- the wiki is curated long-lived project knowledge;
- memory is accepted lessons/decisions/constraints;
- SAC is a local collaboration entry point that *references* those owners and
  promotes new knowledge only through a reviewed proposal.

Without one verified working cycle, fallback behaviour and a tool-trace, the
stack looks like duplication instead of a complementary system.

## Expected Outcome

- One operator document explains the live cycle: context in, graph/wiki use,
  task execution, SAC proposal, owner write, version/audit ids.
- Session state, Facts, Work, and durable knowledge are named separately.
- Fallback is proven from real CLI/logs: model-backed paths fail closed;
  deterministic graph/wiki/memory/SAC reads keep working.
- A 3–5 step reproducible scenario records expected vs actual.
- Residual gaps are listed explicitly, not inferred.

## Out of Scope

- Turning on the learned SAC policy experiment.
- Inventing an automatic hosted → local → cache model chain that the current
  fail-closed design rejects.
- Replacing wiki/memory/flow/graph with a new store.
- Publishing a marketing article (only a short write-up prompt).
