# Keryx Agent Platform Expansion — Metrics and Validation
Version: 0.1.2

## Purpose

Define, per workstream, what is measured, how, and the threshold that gates
progress — so wave exit and Wave 4 content scale-out are decided from
evidence, not from agent narrative or document/commit volume, consistent with
this program's honest-status invariant.

## W1 — Stack-aware skills & rules catalog

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Stack coverage count | Number of stacks with at least one rule + one implement/test/review/build-fix/migrate skill, from the current 2 (NestJS/Prisma, React/MobX) toward the W1 target-stack table's (`workstreams/W1-stack-catalog.md`) full list. | Increases only after the covering batch passes the eval gate below. | Count entries in the stack-pack registry; cross-check against `.metaproject/rules/core/*` and `.metaproject/skills/catalog.md`. |
| Skill trigger-eval accuracy | Fraction of a scenario bank (positive + negative prompts) where a skill's `description` correctly fires or correctly stays silent. | ≥ 90% on the negative-case subset before a skill ships (over-broad activation is unverified as the most common failure mode — requires a first-party check against `keryx skills eval` run history before implementation). | `keryx skills eval`, scenario bank of ≥10 prompts per skill, 3–5 trials per case, report pass-rate distribution. |
| Behavior-eval pass@k | Fraction of trials where the skill's output satisfies its `expected_behavior` assertions, at k trials. | pass@3 ≥ 80% before graduating from `candidate` to shipped. | `keryx skills eval`, deterministic and model graders per assertion type. |
| Dedupe-gate hit rate | Fraction of new-skill proposals that the scout gate correctly flags as a near-duplicate of an existing skill. | Reported; investigate any proposal that ships despite a flagged duplicate. | `keryx skills scout`, sampled review of flagged vs. shipped proposals. |
| Stocktake verdict distribution | Count of skills per verdict (keep/improve/update/retire/merge) per stocktake run, each with a specific reason. | No skill stays `needs-review`/`stale` across two consecutive stocktakes without an action taken. | `keryx skills stocktake`, diffed against the prior run. |

## W2 — Agent definitions catalog

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Agent export success per harness | Fraction of catalog agents that export cleanly to each harness the capability matrix marks `native`/`adapter`. | 100% for `native`, 100% for `adapter` (with recorded per-harness caveats where the matrix notes capability gaps). | `keryx agents export --runtime <id>` against every catalog entry, per harness in the matrix. |
| Fail-closed accuracy for unsupported harnesses | Fraction of export attempts against an `unsupported` harness that fail with a named reason rather than silently no-op. | 100%. | Export attempt against every `unsupported` harness id in the matrix; assert a structured failure, not exit 0. |
| Guard-test coverage | Every agent's declared `tools`/`skills` references resolve to something real. | 100%, enforced pre-merge. | Guard test analogous to `agent-catalogue-xref.test.ts`, run over `.metaproject/agents/`. |
| Prompt-defense baseline duplication | Count of agent bodies that duplicate the shared prompt-defense baseline instead of the compiler injecting it once. | 0. | Static check over compiled output. |

## W3 — Self-learning loop

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Learned-pattern acceptance rate | Accepted candidates / total candidates reviewed. | Reported, not gated — a low rate may mean healthy filtering, not failure. | `keryx learn review` history, tallied per period. |
| Rejection reason distribution | Count of rejections per named reason (over-generalized, injection-shaped, low evidence, duplicate). | Every rejection has a non-empty reason; 0 silent rejections. | Same review history. |
| Zero-unconsented-writes invariant | Count of `accepted`-status patterns with no recorded human accept action. | 0, always. | Audit `.metaproject/data/learning/candidates/` status transitions against the consent-log. |
| Confidence update determinism | Given the same evidence sequence, the same confidence value results across runs. | 100% reproducible. | Property test over the deterministic update rule. |
| Content-safety scan coverage | Fraction of extracted lesson text scanned by `keryx security check-output` before becoming a candidate. | 100%. | Trace every candidate record back to a scan result. |

## W4 — Portability

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Bundle round-trip fidelity | Byte-identical checksummed content after export → import → inspect on a fixture bundle. | 100%. | Automated round-trip test in CI. |
| User-modified-file protection | Fraction of import attempts against a user-modified target file that correctly refuse to overwrite. | 100%. | Fixture with a deliberately user-modified target; assert refusal. |
| Fail-closed on checksum mismatch | Fraction of imports with a tampered/mismatched checksum that refuse rather than partially apply. | 100%. | Fixture with a corrupted bundle entry. |
| Cross-harness memory handoff correctness | Reads filtered to `target_harnesses` never return an entry whose `target_harnesses` excludes the requesting harness. | 100%. | Property test over the MCP memory tool's read path. |

## W5 — Multi-harness support & capability matrix

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Matrix completeness | Fraction of listed harness records with every required field (id, state, surfaces_supported, surfaces_unsupported, install_command, verification_command, risk_notes, last_verified, source_docs) populated. | 100%, enforced by the CI validator. | `keryx integrations matrix --check` in CI. |
| Adapter coexistence regression rate | Count of new adapters that reintroduce the config-clobbering class already fixed for Cursor/Windsurf. | 0. | Regression test analogous to `agent-hooks.coexistence.test.ts`, run against every adapter pair sharing a settings file. |
| Experimental-to-verified transition rate | Count of adapters moved from `experimental` to `verified` confidence with a recorded first-party verification. | Reported per period. | Diff the registry's `confidence` field across releases. |
| Install/doctor idempotency | Repeated `keryx integrations install --runtime <id>` produces no diff on the second run. | 100%. | Run install twice against a clean fixture; diff output. |

## W6 — keryx shell lifecycle hooks

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Hook latency p95 | Wall-clock time added to a tool call by the hook runtime, 95th percentile. | Measured and published before any hook is enabled by default in an unattended profile; no default-on until a threshold is explicitly approved. | Benchmark harness running a representative hook set against a fixture session. |
| Tighten-only invariant violations | Count of hook decisions observed to turn a policy-engine `deny` into `allow`, or override a hard deny. | 0, enforced by a guard test, not just runtime observation. | Property test driving `decide()` outputs through the hook composition layer. |
| Fail-closed rate for `gate`-class timeouts (all profiles) | Fraction of a `gate`-class hook timeout, in any profile, that resolves to deny, not allow. | 100%. | Fixture `gate`-class hook that always times out, run under each profile. |
| Fail-closed rate for `gate-advisory`-class timeouts | Fraction of a `gate-advisory`-class hook timeout that resolves to deny in `unattended-untrusted`, and to allow-with-recorded-warning in `read-only-review`/`monitored-trusted-local`. | 100% per profile's documented behavior. | Fixture `gate-advisory`-class hook that always times out, run under each profile. |
| Child hook-set inheritance correctness | Fraction of spawned child agents that inherit exactly the parent's explicit hook set, no implicit host hooks. | 100%. | Inspect the hook config visible to a spawned child in a fixture run. |

## W7 — gdgraph & gdctx correctness

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| gdctx false-block rate on read-only allowlist | Fraction of the R7.3 allowlisted read-only git commands that the ctx guard still blocks after the fix. | 0%. | Run every allowlisted command pattern through the guard; assert allow. |
| gdctx fact-preservation score | Score against `fixtures/benchmark/keryx/gdctx-fact-preservation.json`, measuring whether `ctx read`/`ctx run` output preserves facts present in the raw source. | No regression versus the pre-fix baseline; the GDCTX-2 redaction fix must raise the score on the badge-URL fixture case specifically. | Existing benchmark fixture, re-run pre/post fix. |
| Stdout misclassification rate | Fraction of a labeled corpus of normal (non-error) command output that `keryx ctx run` classifies as an error/warning. | 0% for the labeled corpus, versus a nonzero rate reproduced pre-fix (e.g. the "refuse" stem match). | Labeled fixture corpus of real command outputs (git log, test runners, linters) with known-good/known-bad lines. |
| POSIX flag acceptance | Fraction of bundled short-flag forms (e.g. `-il`) that succeed after the fix, matching their split-flag equivalent's result. | 100% for the documented, reviewed flag set. | Run both forms against the same query; diff results. |
| gdgraph freshness self-check accuracy | Fraction of stale-graph situations (files changed since last `gdgraph build`) correctly flagged before an `affected` query answers from it, for the existing self-check (`src/gdgraph/staleness.ts`, `src/commands/gdgraph.ts:583-593`) once every query path calls it. | 100% detection on a fixture with deliberately unstaged changes. | Fixture repo with post-build file edits; assert the self-check fires. |

## W8 — Harness-config security audit & impact-evidence gate

| Metric | Definition | Threshold | Method |
|---|---|---|---|
| Audit findings precision | True positives / (true positives + false positives) against a labeled fixture set of known-good and known-bad harness configs. | Measured before `--ci` mode is recommended as a merge gate; no fixed threshold claimed without this measurement. | Labeled fixture set covering each check category (secrets, prompt-injection instructions, over-permissive allow lists, unpinned MCP servers, hook injection, exfiltration, silent suppression, unrestricted-tool agents). |
| Audit findings recall | True positives / (true positives + false negatives) on the same fixture set. | Same as above — measured, reported, not assumed. | Same fixture set. |
| Fix-proposal apply-separation invariant | Count of `--fix-proposals` runs that mutate a file directly instead of emitting a proposal. | 0. | Run `--fix-proposals` against a fixture; assert no file diff until a separate apply step runs. |
| Impact-evidence gate false-block rate | Fraction of legitimate first-edits in a session that the evidence gate blocks without being able to supply the required evidence (importers/tests/memory caveats) due to a tooling failure rather than a real gap. | Tracked per period; investigate any nonzero rate promptly. | Instrument the gate's own denial reasons; separate "no evidence available" from "evidence supplied, user declined to acknowledge." |

## Validation method (program-wide)

- Every metric above is recomputed from the cited tool/fixture output, never
  from an implementing agent's self-report.
- A workstream may not claim its Wave exit criteria (see
  [implementation-plan.md](implementation-plan.md)) met without the
  corresponding metric's measurement attached to its Flow's evidence bundle.
- Wave 4's stack-coverage count (W1) increases only after the batch's eval
  metrics clear their thresholds — per decision D-7, this is enforced as a
  process gate, not merely tracked.
- Any metric reported as `unknown` stays `unknown`; it is never serialized or
  displayed as zero or as passing.
- Reporting cadence: at each workstream's Flow state transition, update its
  metrics; at each wave exit, reconcile all metrics for the workstreams in
  that wave before declaring the wave complete.
