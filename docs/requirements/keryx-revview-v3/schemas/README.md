# Review V3 wire schemas

The JSON Schemas in this directory define the stable structural contracts for Review V3 config, host-approved runtime plans, and durable run state. Runtime validation in `src/review/agents/config.ts` and `src/review/agents/store.ts` is authoritative for semantic relationships that JSON Schema cannot express safely.

Semantic validation additionally enforces:

- concurrency, model-round, time, spending, and reserve relationships between ceilings;
- exact assignment graph, parent depth, idempotency, counters, reservations, result ownership, and revision consistency;
- a single host-approved active plan bound to the run revision and monotonically increasing plan versions and review rounds;
- a cumulative run-scoped registered-wave cap that cannot reset when a plan is superseded;
- exact root/template assignment bindings, coordinator-only dynamic-child authority, non-expanding child scopes, inherited wave/plan identity, and delegated coverage envelopes;
- current-plan-only coverage backed by a completed in-scope result and declared coverage cell;
- controller ownership leases and fencing tokens.

Unknown fields fail closed. Schema version changes require an explicit migration rather than silently accepting an older durable ledger.
