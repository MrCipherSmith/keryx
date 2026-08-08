# Tasks

- T1 (context): read specification §3/§4/§10, prd, implementation plan, ADR-0010,
  `profile.ts`, `bwrap.ts`, `wrap.ts`; fix the lane boundary against the two
  parallel agents.
- T2 (test): write `landlock.test.ts` and `landlock-abi.test.ts` covering AC1–AC5
  before the implementation is complete.
- T3 (implement): `landlock.ts` — access-right tables, ruleset + failure types,
  `buildLandlockRuleset`, mask helpers.
- T4 (implement): `landlock-abi.ts` — injectable reader interface + per-process
  cache, no mechanism.
- T5 (implement): re-export the new public surface from `sandbox/index.ts`.
- T6 (review): `keryx health run`, `bun test` on the sandbox scope,
  `bun scripts/check-doc-links.ts`, then the review orchestrator on the draft PR,
  iterating until green.
- T7 (review): verify the diff touches nothing in the other agents' lanes
  (`detect.ts`, `capability-matrix.ts`, `src/commands/sandbox.ts`,
  `scripts/install.sh`, `wrap.ts`, `seatbelt.ts`, `profile.ts`, `bwrap.ts`,
  `adapter.ts`, proxy/TLS) — AC7, run as a task, not asserted in prose.
