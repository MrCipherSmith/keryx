# Admission regressions: tests-first

Target: `7e7179a8`, Bun 1.3.14. No production changes or commits.

- `SEC-W31-001` (major): `src/hub/admission-regression.test.ts` / `slow public login bodies cannot exhaust authenticated mutation admission`. Real `createHubApplication.fetch` holds 32 public session bodies after each starts reading; authenticated project mutations succeed before and should succeed during saturation; abort/settle and another successful mutation establish cleanup. RED: expected 200, received 503 during saturation; baseline and cleanup succeeded. The existing queue tests continue to cover body deadline and byte limits and protected route tests cover authorization before reading.
- `W2-010` (minor), exact mutant `w2-supplement-remote-stream-limit`: `authenticated machine stream over remote parser limit is cancelled without mutating state`. Calls real `createRemoteControl.handle` directly with an authenticated machine and 33 streamed MiB, bypassing the outer queue. Asserts 413, cancellation, unchanged machine and no operation records. PASS on baseline: this is coverage for an existing guard, not a product defect. Removing the cited guard should cause this test to fail; mutant was not executed in this phase.

Command: `keryx ctx run -- bun test src/hub/admission-regression.test.ts` — exit 1, 1 fail / 1 pass, 8 assertions. Output: `.metaproject/data/gdctx/raw/2026-11-02T12-42-24-690Z-946642_run.log`.

Routing: graph_used yes (graph reported stale because of untracked node_modules; affected output is advisory); wiki_used no (focused test construction, not domain investigation); ctx_used yes; raw_rg_used no.
