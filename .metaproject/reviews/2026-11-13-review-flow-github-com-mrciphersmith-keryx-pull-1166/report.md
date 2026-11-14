Reviewed `b076a85a6354` — the PR head at review time.
**Changes requested — 1 Blocker, 8 Major, 11 Minor.** Round 1's findings are closed, but the fix that sealed the package (`src/review/seals.ts`) introduced three new defects: a waiver on a pre-seal package produces false tamper evidence that blocks complete and publish, deleting `seals` turns the target check off, and the severity the verifier gate counts by is not sealed.
Reviewed `b076a85a6354` against `e9ac9253fde7` · round 2 (delta) · CI green at review time.
Evidence level: ran — `keryx review verify-run` probes for all 9 blocker/major findings (9 confirmed), `keryx review mutate` over 39 mutants on 11 test files (25 killed, 14 survived)
Coverage: slice-03 and slice-05 (main-merged code and dependency overrides, 18 drivers) were not dispatched by operator agreement; review-security-code read slice-07 only partially. The operator closes with `--waive-coverage`.

## Prior findings (round 1)

- **review-architecture-w1:F-001** — closed.
- **review-architecture-w2:F-004** — closed.
- **review-architecture-w3:ARCH-1** — closed. `review publish` now runs the research-error gate through `evaluateCloseGates`.
- **review-degradation-w2:F-001** — closed.
- **review-degradation-w2:F-002** — closed.
- **review-degradation-w2:F-003** — closed.
- **review-logic-w2:F-001** — closed.
- **review-logic-w3:F-002** — closed.
- **review-testing-practices-w1:F-001** — closed.
- **review-testing-practices-w2:TP-2** — closed.
- **review-logic-w4:F-001 — partial** (architecture, core-boundaries, regression, testing-practices: partial; degradation: regressed; logic: withdrawn; security, style: closed). The accepted break holds, but the seals widen it: every pre-seal waiver and verification is now unhonoured, not only the removed escapes, and the CHANGELOG names only the narrow break. Carried as review-degradation-w1:F-001 and the CHANGELOG minors below.
- **review-security-code-w3:SEC-1 — partial** (security, degradation: partial; others closed). Hand-written waivers, verifications and head overrides are now refused, but a rewritten `target.head` still passes when `seals` is deleted, and severity is unsealed. Carried as cluster B and C below.

## Regressions the fixes introduced

**A. A waiver on a seal-less package seals no target, then the target check fails (answering review-security-code-w3:SEC-1).** `waiveReadinessLocked` (`src/review/readiness.ts:613`) writes `seals: { ...(manifest.seals ?? {}), readinessWaivers }`; `sealProblems` (`src/review/seals.ts:87`) checks the target whenever `seals` exists, so a PR-bound package started before this release and waived the supported way is refused by complete and publish with "manifest.json target … does not match the seal". The close at `src/review/managed.ts:1148` does not repair it. Probe: `research-evidence/verify-seals-r2-1.txt`. Raised as review-logic-w8:LOGIC-1, review-logic-w10:F-001, review-degradation-w2:F-001, review-degradation-w4:F-001, review-regression-w4:F-001 (major) and review-architecture-w4:ARCH-4 (minor). Premise: upheld. Fix: seal the current target whenever keryx first creates `seals` (both writers); do not instead key the check on `seals.target`, which opens a second cluster-B bypass.

**B. Deleting `seals` turns the target check off (answering review-security-code-w3:SEC-1).** `sealProblems` skips the target check when `manifest.seals` is absent, so an agent with a file tool deletes `seals`, sets `target.head` to the PR head, and `review complete` closes READY with no operator act. Probe: same file, B problems `[]`. Raised as review-security-code-w8:SEC-1 (blocker) and review-security-code-w1:SEC-R2-1 (major). Premise: upheld — AC9 names a rewritten `target.head` as refused; the branch's own "no seals = unchecked" note cannot narrow it. Fix: key the legacy exemption on something manifest.json edits cannot clear (a marker in the hashed round record), or refuse a PR-bound package without `seals.target` until `review complete --head <sha> --head-reason` re-seals it.

**C. Severity is not sealed (answering review-security-code-w3:SEC-1).** `verifierCheck` (`src/review/readiness.ts:238`) picks heavy findings by the `severity` string in findings.json; editing an unverified `major` to `minor` passes item `verifier`. Probe: `research-evidence/verify-sev-and-legacy-r2-1.txt`. Raised as review-security-code-w8:SEC-2 (major). Premise: owner-decision (AC9 does not list severity; flow 490 owns the completion snapshot). Operator: uphold — seal the blocker/major set at ingest and test the severity edit in this PR.

## Major (outside the clusters)

**review-degradation-w1:F-001. Pre-seal packages with real verifier results or TTY waivers read NOT READY.** `src/review/seals.ts`. A package closed before this release with a verification in the producer's shape, and no `seals`, fails item `verifier` with "keryx did not record" (probe: `research-evidence/verify-sev-and-legacy-r2-1.txt`). This is wider than the break the operator accepted for review-logic-w4:F-001. Premise: owner-decision. Operator: dismiss — keep strict per AC9; the CHANGELOG and the `seals.ts` header must name every affected pre-seal package and its repair (carried by the CHANGELOG minors).

## Minor

<details open><summary><b>Minor (11)</b></summary>

- **review-architecture-w1:F-001, review-degradation-w2:F-002, review-logic-w6:F-001. The CHANGELOG breaking note names only the removed escapes.** `CHANGELOG.md:8`; `src/review/seals.ts:14-16` says the release note records the wider break. Fix: say pre-seal waivers, head overrides and verifications are not honoured, with the repair.
- **review-architecture-w4:ARCH-4.** Cluster A, rated minor by this reviewer.
- **review-degradation-w2:F-003, review-style-w2:F-001. AC9 has no `[verify:]` tag.** `.metaproject/flows/488-…/acceptance-criteria.md`. Fix: `keryx flow ac update 488 AC9` with `[verify: exec \`bun test src/review/seals.test.ts\`]`.
- **review-logic-w4:F-001. `cli-reference.md:5112` contradicts itself on `--answered-by`.** Fix: name the `review complete` flags that accept it.
- **review-architecture-w6:F-001. The "closed package skips live coverage" rule is spelled twice** in `src/review/close-gates.ts`. Fix: compute it once.
- **review-degradation-w6:DEG-1. An unreadable findings.json is waivable through the `ledger` item.** `src/review/close-gates.ts:52`. Fix: return an untagged error.
- **review-style-w4:F-001. `readiness.ts:246` matches the seals message text** to tell "no verification" from forged. Fix: export a constant.
- **review-style-w4:F-002. `sink`/`editManifest` helpers copied into three test files.** Fix: move to `close-gates.test-helpers.ts`.

</details>

<details><summary><b>Info (14)</b></summary>

Listed in the findings block: review-architecture-w4:ARCH-5, review-architecture-w6:F-002, review-degradation-w1:F-002..F-004, review-degradation-w4:F-002, review-degradation-w6:DEG-2, review-logic-w1:F-001, review-style-w1:F-001, review-style-w4:F-003..F-005, review-testing-practices-w1:F-001, review-testing-practices-w4:TP-1.

</details>

<details><summary><b>How this review was run</b></summary>

- **Workflow:** `review-orchestrator`, managed package `2026-11-13-review-flow-github-com-mrciphersmith-keryx-pull-1166`, round 2 (delta `e9ac9253fde7..b076a85a6354`).
- **Slices:** slice-01 fix, slices 02–06 new, slices 07–10 second look. Not dispatched: slice-03, slice-05 (operator agreement).
- **Models:** claude-opus-5-5 — reviewers, verifier and premise judge.
- **Subagents:** review-architecture, review-core-boundaries, review-degradation, review-highload, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices (44 results); review-premise ×1.
- **Fallback:** every reviewer via `general-purpose` because Claude Code has no bundled keryx agent types.
- **Raw normalisation:** 10 results declared `STATUS: DONE` outside their REVIEW_RESULT object; the status was copied in, nothing else changed (`research-evidence/raw-normalisation.md`).
- **Verification:** annotate. Confirmed 9, refuted 0, unverifiable 0.
- **Premise:** 13 findings judged — 11 upheld, 2 owner-decision; operator upheld review-security-code-w8:SEC-2 and dismissed review-degradation-w1:F-001 (keep strict, document).
- **Mutation:** 39 mutants, 25 killed, 14 survived (`research-evidence/mutation-1.md`). Survivors that matter for the fix round: `managed.ts:1148` legacy-seal gate (w2-mc-seals-legacy-package-gate, w4-M5 — cluster A has no test), `seals.ts:70` method/evidence checks one at a time (w4-M2, w4-M3), `managed.ts:519` carried verification (w4-M1), `readiness.ts:610` waiver replacement (w4-M4), the closed-publish coverage skip (w1-mc-03, w4-M6, w6-mc-w6-09 — review-testing-practices-w1:F-001), `close-gates.ts:55` sealed-only waivers (w1-mc-04, w4-M12 — readiness filters the same set, so the call is redundant there).

</details>

```json keryx:findings
[
  {
    "id": "review-security-code-w8:SEC-1",
    "severity": "blocker",
    "file": "src/review/seals.ts",
    "line": 87,
    "quote": "if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)) {",
    "problem": "The target check runs only when `manifest.seals` exists. Absence of the whole `seals` object is treated as 'a package that predates the seals', so the check is skipped. The seal is therefore removable, not just forgeable.",
    "evidence": "seals.ts:80-93 sealProblems: head_override is checked on its own condition (so a hand-written override is caught), but the target branch is gated on `manifest.seals !== undefined`. close-gates.ts evaluateCloseGates calls sealProblems(readManifest(...)) and nothing else re-checks target. headCheck (readiness.ts:355-367) reads ctx.manifest.target.head via completeHeadGate and compares it with the PR head. roundRecordTampered (round-record.ts:276-287) hashes only round.json and prior_findings.json, so manifest.target is not covered there either (MANIFEST_IDENTITY_FIELDS is used by the registry, not by the close gates). seals.test.ts case (b) edits target.head but leaves `seals` in place, so no test covers deleting `seals`.",
    "impact": "Attack vector: an agent with only a file tool opens manifest.json of a PR package whose round reviewed an old head, deletes the `seals` key (also `head_override` if present) and sets `target.head` to the PR's current head. `review complete` and `review publish` run sealProblems (no seals, no head_override: no problem) and headCheck (reviewed head equals PR head: pass). The round is closed or published as having reviewed the current head without the operator's --head-reason quote, which is the relabel SEC-1 round 1 asked to stop. Deleting `seals` costs the agent nothing it needs: waivers and verifications are not honoured without it, but the head gate does not need them.",
    "suggested_fix": "Do not read a missing `seals` as 'legacy'. Record the target seal at every package creation (start, attach, ingest) and treat a PR-bound package without `seals.target` as unsealed. For genuinely old packages, key the legacy exemption on something an agent cannot clear by editing manifest.json, for example the closed-round registry hash or a `schemaVersion`/`createdAt` threshold that is itself covered by roundRecord, or refuse and require `review complete --head ... --head-reason`. Add a test that deletes `seals` and sets target.head to the PR head and expects both complete and publish to refuse.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "class_scope": {
      "sites": [
        "src/review/seals.ts:87",
        "src/review/seals.ts:82",
        "src/review/managed.ts:521",
        "src/review/managed.ts (complete, line not re-read at head:seals set only when stored.seals !== undefined || options.head !== undefined)"
      ],
      "enumeration_method": "keryx ctx rg for manifest.seals / seals: / sealTarget / sealProblems across src (non-test): the only reader of the target seal is sealProblems; the only writers of seals.target are the ingest build at managed.ts:521 and the complete path; the other seal kinds (waivers, verifications) are read through partitionWaivers/verificationProblem, which already fail closed when seals are absent, so the target seal is the one member of the class that does not."
    }
  },
  {
    "id": "review-degradation-w1:F-001",
    "reviewer": "review-degradation",
    "severity": "major",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "consumer-trace",
    "file": "src/review/seals.ts",
    "line": null,
    "quote": "the operator accepted that such a closed package may read NOT READY",
    "problem": "The seals make every package written before them read NOT READY. That covers any such package with a readiness waiver of any item, or with a verifier result on a blocker or major finding, and it includes ones closed legitimately through a TTY waiver or a real `ingest --verifications`. The operator accepted the break only for packages closed through the removed escapes. On base, such a package read READY. On head, verificationProblem (seals.ts:72) returns 'a verification keryx did not record' for every unsealed verification. partitionWaivers (seals.ts:57-62) puts every pre-seal waiver in `unsealed`, and computeReadiness (readiness.ts:489-498) fails the item with a note that the entry 'keryx did not record'. computeReadiness has no closed-package exemption (readiness.ts:459-471: only coverage items use liveCoverageGate/coverageMdGated). seals.ts:14-16 justifies this with 'the operator accepted that such a closed package may read NOT READY; the flow 488 CHANGELOG entry says so'. Neither record covers it. The operator's decision (flow 488 journal.md:28) is 'packages closed via the removed escapes stay NOT READY'. CHANGELOG.md:8 is 'A package that an earlier release closed on a `Not verified: N` line or a first-line head statement now reads NOT READY'.",
    "impact": "Take a package closed with a real verifier result or a TTY waiver before this release. After the upgrade it shows NOT READY in `review readiness`, `review status` and the panel, with evidence that reads as forgery ('not honoured', 'keryx did not record'). `review publish` refuses it (close-gates.ts:79-80). The shell publish guard refuses `gh pr review` on that PR when that package is the newest one bound to it (publish-guard.ts:120-128: closed packages are candidates, since status is 'closed', not 'completed'). An open package ingested with `--verifications` on 0.4.27 and completed after the upgrade is refused at item verifier. Each case needs an operator waiver per package, or --partial, for a decision that was already made correctly.",
    "suggested_fix": "Either narrow the break to what was accepted, or widen the record to what the code does. Narrowing: stamp a seal-schema marker into every manifest keryx writes from now on (for example `seals.version`). For a package without the marker, keep base behaviour for verifications and waivers: honour them as before, the way target is already left unchecked. Only the removed escapes still fail, since they are no longer read at all. A package with the marker but without matching seals is refused as now. Widening: rewrite CHANGELOG.md:8 to name every pre-seal package with a waiver or a verified heavy finding, correct seals.ts:14-16, and get the operator's decision on that wider scope. Add a test that builds a pre-seal closed package with a real verification and asserts the chosen behaviour.",
    "evidence": "Read seals.ts:14-16, 57-62, 67-74; readiness.ts:241-251 (verifierCheck), 459-471, 487-501 (computeReadiness); close-gates.ts:49-59, 79-80; publish-guard.ts:112-133. Consumers of computeReadiness found by keryx ctx rg (search-derived): commands/review.ts:4735 and 4857, operator-confirm-review.ts:346 and 369, close-gates.ts:79, publish-guard.ts:124, tui/review-panel.ts:198. Refute: (a) Is there a closed-package exemption for items verifier or waivers? readiness.ts:459-471 has none; only coverage-md and the live coverage gate key on status. (b) Does a CHANGELOG line or operator decision cover the wider set? CHANGELOG.md:7-8 and journal.md:28 name only escape-closed packages, and journal.md:36 lists the known seal gaps without this one. (c) Does ingest re-seal old verifications? managed.ts:517-521 seals only what the verifier merge applied in this ingest, so an already-closed package is never re-sealed. The claim survives.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/seals.ts:72",
        "src/review/readiness.ts:489",
        "src/review/close-gates.ts:55",
        "src/review/publish-guard.ts:124",
        "src/commands/review.ts:4735",
        "src/commands/review.ts:4857",
        "src/commands/operator-confirm-review.ts:346",
        "src/tui/review-panel.ts:198"
      ],
      "enumeration_method": "search-derived: keryx ctx rg 'computeReadiness\\(' over src excluding tests (9 matches, 6 files), plus the two seal readers verificationProblem and partitionWaivers (keryx ctx rg over src/review); every caller reaches the unsealed-means-fail rule"
    }
  },
  {
    "id": "review-degradation-w2:F-001",
    "severity": "major",
    "reviewer": "review-degradation",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "consumer-trace",
    "file": "src/review/readiness.ts",
    "line": 613,
    "quote": "seals: { ...(manifest.seals ?? {}), readinessWaivers }",
    "problem": "A package written before the seals (no `manifest.seals`) is meant to have its target left unchecked (seals.ts:78, :87 `manifest.seals !== undefined && ...`). But keryx's own waiver path turns it into a package that does have seals and no target seal: waiveReadiness writes `seals: { readinessWaivers }` with no `target` (readiness.ts:613), and the close keeps exactly that when `stored.seals` was undefined and no `--head` was given (managed.ts:1148-1150: `stored.seals !== undefined || options.head !== undefined ? {..., target: sealTarget(...)} : manifest.seals`). From then on sealProblems sees `seals` defined, a PR-bound target and `seals.target` undefined, and pushes 'manifest.json target ... does not match the seal keryx wrote' (seals.ts:87-90). evaluateCloseGates throws on that before the evidence, research and readiness steps, and before `relaxReadiness` is consulted (close-gates.ts:65-66), so `review publish` refuses the package and `review publish --partial` refuses it too (publish.ts:175). On base, the same --waive close leaves a package that publish accepts.",
    "impact": "The CHANGELOG's documented repair for a package closed through the removed escapes (CHANGELOG.md:8: `keryx review complete <package> --waive verifier|head \"<their words>\"`, or publish with `--partial`) leaves a PR-bound pre-seal package that can never be published. The waiver is still recorded, but publish refuses outright, and the refusal tells the operator their manifest was edited outside keryx, which is false. The same happens to any round that was in flight across the upgrade and is closed with `--waive`, or waived through the review_waive_readiness card. In the card case `review complete` itself then refuses at close-gates.ts:65. The only escapes are knowing to repeat `--head <recorded sha>` at close (which makes managed.ts:1148 seal the target) or editing manifest.json by hand, which is exactly what the seals forbid.",
    "suggested_fix": "Keep the 'no seals = target unchecked' state consistent. Either key the target check on `manifest.seals?.target !== undefined` rather than on `manifest.seals !== undefined` (seals.ts:87), or have waiveReadiness and the close seal the current target whenever they create `seals` on a package that had none (readiness.ts:613; managed.ts:1148: also seal when `manifest.seals !== undefined`). Add a test: build a PR-bound package with no `seals`, run `completeManagedReview` with `waiveReadiness`, then assert that `publishManagedReview` (and `--partial`) is not refused with the target-seal message.",
    "evidence": "Consumer trace at head b076a85a6354: readiness.ts:609-613 (waiver seal written, `...(manifest.seals ?? {})` adds no target); managed.ts:1131-1135 (beforeReadiness calls waiveReadiness, then reloads manifest from disk, now with seals {readinessWaivers}); managed.ts:1148-1153 (stored.seals undefined, options.head undefined, so `seals = manifest.seals` with no target is written to the closed manifest); seals.ts:87 (target check gated only on `manifest.seals !== undefined`); close-gates.ts:65-66 (sealProblems throws before relaxReadiness is read at :57/:80); publish.ts:175 (publish calls evaluateCloseGates). Refute attempts: seals.ts:14-16 and :78 state that pre-seal packages keep their target unchecked, so the refusal contradicts the stated design and is not a deliberate choice (law 4). close-gates.test-helpers.ts:54 and readiness.test.ts:71 always add `target: manifest.seals?.target ?? sealTarget(...)` to fixtures, so no test reaches the partial-seal state. A search for 'predat|before the seals|no seals|legacy' in src/review found no test of a pre-seal package being waived. Base: on main, close-gates.ts and seals.ts do not exist and publish ran readiness alone, so a --waive close was publishable.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:613",
        "src/review/managed.ts:1148",
        "src/review/seals.ts:87",
        "src/review/close-gates.ts:65"
      ],
      "enumeration_method": "keryx ctx rg 'seals\\b|sealTarget|sealWaiver|sealHeadOverride|withVerificationSeals' over src/review and src/commands (search-derived; the graph was not asked because these exports are outside slice-02): every writer of manifest.seals is managed.ts:521 (ingest, always seals the target, so it is not affected), managed.ts:1149 (close, seals the target only on the stored-seals or --head branch) and readiness.ts:613 (waiver, never seals the target). The one reader of seals.target is seals.ts:87, reached through close-gates.ts:65 by managed.ts:1125 (complete) and publish.ts:175 (publish)."
    }
  },
  {
    "id": "review-degradation-w4:F-001",
    "reviewer": "review-degradation",
    "severity": "major",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "consumer-trace",
    "file": "src/review/readiness.ts",
    "line": 613,
    "quote": "await write(manifestPath, `${JSON.stringify({ ...manifest, readiness_waivers: all, seals: { ...(manifest.seals ?? {}), readinessWaivers } }, null, 2)}\\n`);",
    "problem": "Take a PR package written before the seals existed (manifest.seals undefined, for example one still open when keryx is upgraded). On it, waiveReadiness writes `seals: { readinessWaivers }` and no `target`. sealProblems (seals.ts:87) treats any manifest whose `seals` is defined as sealed. Here seals.target is undefined and differs from sealTarget(target), so every later evaluateCloseGates call (close-gates.ts:65) throws `manifest.json target ... does not match the seal keryx wrote ... never by editing manifest.json`. There are two paths. (a) `review complete --waive <item>`: beforeReadiness writes the waiver after the seal check, so the close succeeds. completeManagedReview keeps `manifest.seals`, which still has no target, because `stored.seals` was undefined and no --head was given (managed.ts:1148-1150). Every later `review publish` is then refused, --partial included, and a closed package has no repair. (b) A standalone waiver (the review_waive_readiness card, then complete): complete itself is refused. On base, both paths worked. Re-waiving with keryx is the natural repair for a package from before the seals, since its old waivers are no longer honoured, and it is exactly what triggers this.",
    "evidence": "consumer-trace: readiness.ts:613 writes `{...(manifest.seals ?? {}), readinessWaivers}`, which has no target when manifest.seals was undefined. seals.ts:87: `if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target))` makes undefined !== digest, so it refuses. close-gates.ts:65-66 runs this before relaxReadiness is consulted, for both complete and publish. managed.ts:1148-1150: `const seals = stored.seals !== undefined || options.head !== undefined ? {... target: sealTarget(manifest.target) ...} : manifest.seals;` leaves the target out on path (a). Refutation attempted: the only other writers of seals.target are ingest (managed.ts:521) and complete with --head (managed.ts:1149); neither runs on these paths. isPrBound (complete-head-gate.ts:15) is true for every kind:pr target. seals.test.ts and the helpers build packages with ingestReady, which always seals the target, so no test reaches this state. The seals.ts header (lines 14-17) accepts only that old waivers and verifications are not honoured and that an old target is not checked. It does not accept that a package becomes unclosable or unpublishable.",
    "impact": "An operator who recorded a new waiver the supported way, on a package from before the seals, gets a closed package that `review publish` refuses forever (or an open one `review complete` refuses). The refusal message accuses them of editing manifest.json by hand and names --head --head-reason as the repair, which does not apply to a closed package.",
    "suggested_fix": "Seal the target wherever seals are first created on a manifest that has none. In waiveReadiness: `seals: { ...(manifest.seals ?? { target: sealTarget(manifest.target) }), readinessWaivers }`. Or make sealProblems check the target only when `manifest.seals?.target !== undefined`. Add a test that strips `seals` from an ingested PR package, then waives, then completes and publishes.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:613",
        "src/review/managed.ts:1148",
        "src/review/seals.ts:87"
      ],
      "enumeration_method": "search (keryx ctx rg) for every writer of `seals` in src/ outside tests: managed.ts:521 (ingest, always sets target), managed.ts:1148-1150 (complete, target only when stored.seals or --head), readiness.ts:613 (waiver, never sets target). The last two are the sites that can leave seals defined without a target; seals.ts:87 is the reader that turns that into a refusal."
    }
  },
  {
    "id": "review-logic-w10:F-001",
    "severity": "major",
    "file": "src/review/readiness.ts",
    "line": 613,
    "quote": "seals: { ...(manifest.seals ?? {}), readinessWaivers }",
    "problem": "waiveReadinessLocked writes a `seals` object holding only `readinessWaivers` when the manifest has no seals yet. sealProblems (seals.ts:87) treats the mere presence of `seals` as 'this package carries a target seal' and compares `manifest.seals.target` (undefined) with sealTarget(target). The close path does not repair it: managed.ts:1148 adds `target` only when `stored.seals !== undefined || options.head !== undefined`, and `stored` is the manifest read before the waiver. A package started before the seals existed therefore ends up sealed without a target seal after its first waiver.",
    "impact": "Package started with a pre-0.4.27 keryx and still open at upgrade, PR-bound. The operator runs `review complete <pkg> --waive memory-outside-stage \"...\"` (or answers the review_waive_readiness card). The close succeeds: sealProblems runs at close-gates.ts:65, before beforeReadiness records the waiver, and it sees no seals. The closed manifest holds `seals: { readinessWaivers }` with no `target`. `review publish` then runs evaluateCloseGates, sealProblems sees seals present and PR-bound, finds `seals.target !== sealTarget(...)`, and throws 'manifest.json target ... does not match the seal keryx wrote'. The message blames a manifest edit that never happened. sealProblems is not waivable and `--partial` does not relax it, so that package cannot be published at all. The same state arises when the card waives an item on an open legacy package and a later `review complete` runs. seals.ts:15-16 says a package with no seals has its target left unchecked, and this path breaks that promise.",
    "suggested_fix": "Make the absent target seal mean 'target not checked' in sealProblems, with `manifest.seals?.target !== undefined && ... !== sealTarget(...)`. Or have waiveReadinessLocked record `target: manifest.seals?.target` only when it exists and never create a seals object that implies a target. Do not seal the current target there: that would bless whatever the file holds today. Add a test: a manifest with no seals, a waiver, a close, then publish.",
    "evidence": "readiness.ts:613 (`seals: { ...(manifest.seals ?? {}), readinessWaivers }`) is the only writer of `readinessWaivers` seals and does not add `target`. managed.ts:1148-1150 (`stored.seals !== undefined || options.head !== undefined ? {...target...} : manifest.seals`) leaves seals as read from disk when no --head is given. seals.ts:87 (`manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)`) refuses. publish.ts:175 calls evaluateCloseGates, which calls sealProblems at close-gates.ts:65. Traced by reading, not run.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:613",
        "src/review/managed.ts:1148",
        "src/review/seals.ts:87"
      ],
      "enumeration_method": "keryx ctx rg for `seals` over src excluding tests and seals.ts: 3 writers of a seals object (managed.ts:521 ingest, managed.ts:1149 complete, readiness.ts:613 waive). Ingest always sets `target`; complete sets it only under the stored.seals/--head condition; only waive can create seals with no `target`. One reader (sealProblems) that assumes it."
    },
    "reviewer": "review-logic"
  },
  {
    "id": "review-logic-w8:LOGIC-1",
    "severity": "major",
    "file": "src/review/readiness.ts",
    "line": 613,
    "quote": "seals: { ...(manifest.seals ?? {}), readinessWaivers } }",
    "problem": "waiveReadiness creates `manifest.seals` as `{ readinessWaivers }` on a package that had none, with no `target` digest. seals.ts sealProblems treats the mere presence of `seals` as proof that the target was sealed: `manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)`. For such a package `seals.target` is undefined, so the comparison is always unequal and the gate reports 'manifest.json target (head ...) does not match the seal keryx wrote'. seals.ts's own header and the managed.ts comment at the close ('A package from before the seals is sealed only when this close records a head of its own (--head)') state the opposite intent: a pre-seal package's target is not checked.",
    "evidence": "Path: open PR-bound package written before this change (no `seals`), then the operator waives any item (the review_waive_readiness card, or `review complete --waive <item> \"<quote>\"`). readiness.ts:613 writes `seals: { readinessWaivers }`. In the same `complete`, evaluateCloseGates ran sealProblems (close-gates.ts:65) BEFORE beforeReadiness, so this close passes; managed.ts:1148 then keeps `seals = manifest.seals` (stored.seals was undefined and no --head), so the closed manifest holds `seals` without `target`. `review publish` then runs evaluateCloseGates -> sealProblems (close-gates.ts:65) -> refuses. For a card waiver on a still-open package the next `complete` refuses at the same line, and `complete --head <sha> --head-reason ...` cannot repair it because sealProblems reads the on-disk manifest first. No test covers it: seals.test.ts waives only on packages made by ingestReady (which seals the target at ingest), and close-gates.test-helpers.ts line 57 papers over the shape with `manifest.seals?.target ?? sealTarget(manifest.target)` for hand-built fixtures.",
    "impact": "A legitimately waived pre-seal package becomes unclosable (open case) or unpublishable (closed case) with a message that blames a manifest edit that never happened; the only way out is to hand-edit manifest.json, which is the act the seals exist to refuse. Scope is packages in flight across the upgrade, since packages created from now on carry a target seal from ingest.",
    "suggested_fix": "Make the 'sealed target' test explicit instead of inferring it from the presence of `seals`: in sealProblems check the target only when `manifest.seals?.target !== undefined`. Alternatively have waiveReadiness leave a seal-less manifest seal-less for the target, or stamp `target: sealTarget(manifest.target)` only when the package already carried one. Add a seals.test.ts case: waive on a manifest with `seals` deleted, then complete and publish.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:613",
        "src/review/seals.ts:87",
        "src/review/managed.ts:1148"
      ],
      "enumeration_method": "keryx ctx rg for `.seals`, withVerificationSeals, sealTarget( and seals writers over src (non-test): the writers of `manifest.seals` are managed.ts:521 (ingest, always sets target), managed.ts:1148-1150 (close; sets target only when stored.seals or --head), and readiness.ts:613 (waive; never sets target). Only readiness.ts:613 can create a `seals` object without `target`; the one reader that equates 'seals present' with 'target sealed' is seals.ts:87."
    },
    "reviewer": "review-logic"
  },
  {
    "id": "review-regression-w4:F-001",
    "severity": "major",
    "file": "src/review/seals.ts",
    "line": 87,
    "quote": "if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)) {",
    "problem": "sealProblems treats any manifest that carries a seals object as one whose target seal must exist. waiveReadiness (src/review/readiness.ts:613) now writes `seals: { ...(manifest.seals ?? {}), readinessWaivers }` and never a target seal. On a pull-request package written before flow 488 (no seals at all, which seals.ts and the CHANGELOG say is tolerated) the first operator waiver therefore turns `seals` from undefined into `{ readinessWaivers }`, and from then on `manifest.seals.target` is undefined and never equals the target digest. completeManagedReview does not repair it: it seals the target only when `stored.seals !== undefined || options.head !== undefined` (managed.ts:1148), so a close of such a package by `--waive` alone records `seals` without a target.",
    "evidence": "Trigger: a PR-bound package created by an older keryx (manifest has no `seals`), then `keryx review complete <review> --waive <item> \"<quote>\"`, or the review_waive_readiness card followed by `review complete`. Outcome A (close by --waive in one call): evaluateCloseGates runs sealProblems on the on-disk manifest before beforeReadiness (close-gates.ts:65 vs :76), so the close succeeds; the closed manifest holds seals.readinessWaivers only; `keryx review publish` then calls evaluateCloseGates (publish.ts:175), sealProblems fires on the missing target seal and publish refuses with 'manifest.json target (head ...) does not match the seal keryx wrote'. Outcome B (card waive, then complete): the second command refuses at close-gates.ts:66 for the same reason. The message blames editing manifest.json, which the operator did not do, and its stated repair (`complete --head <sha> --head-reason`) is itself refused by the same earlier check. Before this change neither command refused such a package.",
    "impact": "In-flight and recently closed PR review packages from before the upgrade that took a readiness waiver can no longer be completed or published; the refusal is false tamper evidence and has no operator repair short of hand-editing manifest.json, which is what the seal is meant to catch.",
    "suggested_fix": "Make the target check apply only when a target seal was ever written: guard on `manifest.seals?.target !== undefined`, or have waiveReadiness leave `seals.target` absent and sealProblems skip an absent one; alternatively have waiveReadiness/complete seal the current target when it creates the first seals object on a legacy package. Add a test: ingest a package, strip `seals`, waive one item, close, then publish.",
    "confidence": "high",
    "reviewer": "review-regression",
    "class_scope": {
      "sites": [
        "src/review/publish.ts:175",
        "src/review/close-gates.ts:65",
        "src/review/readiness.ts:613",
        "src/review/managed.ts:1148"
      ],
      "enumeration_method": "every writer of manifest.seals (rg seals over src/review, src/commands, src/flow, src/tui: readiness.ts waiveReadiness, managed.ts ingest and complete) against every reader of sealProblems (close-gates.ts, reached from managed.ts complete and publish.ts); only waiveReadiness can create a seals object without a target seal, and both close-gates callers (complete and publish) read it. Names changed files src/review/readiness.ts waiveReadiness and src/review/seals.ts sealProblems."
    }
  },
  {
    "id": "review-security-code-w1:SEC-R2-1",
    "severity": "major",
    "file": "src/review/seals.ts",
    "line": 87,
    "quote": "if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)) {",
    "problem": "The target seal that is meant to stop a hand-edited reviewed head is checked only when `manifest.seals` exists. The seals live inside manifest.json, the same file the seal protects, and a manifest with no `seals` key is treated as a pre-seal package whose target is not checked (seals.ts header: 'their target is not checked, since there is no record of it to check against'). The head gate (completeHeadGate in complete-head-gate.ts:44) compares whatever `target.head` manifest.json holds with the PR head. `roundRecordTampered` has the same shape: it returns undefined when the `roundRecord` stamp is absent (round-record.ts:277-278).",
    "evidence": "seals.ts:87 guards the target comparison with `manifest.seals !== undefined`. managed.ts:521 writes `seals` on every new ingest, so a package from this release always carries it, and removing it is the only thing that switches the check off. close-gates.ts:65 calls sealProblems(manifest) and nothing else rechecks that a seal should exist. managed.ts:1148 re-seals on close only when `stored.seals !== undefined || options.head !== undefined`, so a package whose seals were stripped stays unsealed through `review complete`. readiness.ts:489 and seals.ts:72 fail closed for waivers and verifications when seals are missing, so those two are not affected; the target is the one decision that fails open.",
    "impact": "Attack vector: an agent with a file tool, the actor this flow constrains, edits manifest.json: sets `target.head` to the PR's current head and deletes the `seals` object. `keryx review complete` then reads a head equal to the PR head, readiness item `head` passes, and no operator waiver or `--head-reason` is involved. That is the escape the PR set out to close (operator-only relabel of the reviewed head); it needs one extra deletion over the pre-fix edit, not a digest recomputation. A review of an older commit is certified as a review of the PR head. Exploitation requires write access to the package directory, which the flow's threat model grants the agent. The seals header states the intended level is tamper evidence, not a signature, and that level is met for waivers and verifications; the target is below it because the evidence can be removed rather than only forged.",
    "suggested_fix": "Make the absence of seals a recorded fact keryx can distinguish from a legacy package. For example, stamp a `sealsVersion` (or the keryx version that wrote the package) into round.json/prior_findings.json-adjacent data that roundRecordTampered already hashes outside the manifest body, or into the flow journal, and have sealProblems report 'seals missing from a package that was written with them' when that anchor says seals were required. A cheaper partial step: refuse in sealProblems when `manifest.seals === undefined` and the manifest carries any field only the new writers set (`roundRecord` stamp with a version >= this release, `head_override`, `readiness_waivers` entries with a seal-era shape). Apply the same anchor to the missing `roundRecord` stamp in roundRecordTampered.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "class_scope": {
      "sites": [
        "src/review/seals.ts:87",
        "src/review/round-record.ts:277",
        "src/review/managed.ts:1148"
      ],
      "enumeration_method": "keryx ctx rg for `seals` across src (non-test files) and for roundRecordTampered/readRoundStamp: three consumers decide on absence. seals.ts:87 skips the target check, round-record.ts:277 skips the round-record check, managed.ts:1148 skips sealing the target on close. Waivers (readiness.ts:489 via partitionWaivers) and verifications (seals.ts:72 via verificationProblem) treat absence as 'not honoured', so they are excluded."
    }
  },
  {
    "id": "review-security-code-w8:SEC-2",
    "severity": "major",
    "file": "src/review/readiness.ts",
    "line": 238,
    "quote": "const heavy = ctx.findings.filter((finding) => [\"blocker\", \"major\"].includes(String(finding.severity)));",
    "problem": "The verifier gate decides which findings need a verification from the `severity` field of findings.json, and the seals cover only the verification object (keyed by global_id/id), not the finding it sits on. A finding can be taken out of the gate by changing its severity string.",
    "evidence": "seals.ts:42 sealVerification digests {finding: key, verification}; findings.json severity is not part of any seal. readiness.ts:238 filters on severity before verificationProblem is consulted.",
    "impact": "Attack vector: an agent with a file tool edits findings.json and changes an unverified `major` or `blocker` to `minor`. Item `verifier` then counts zero heavy findings and passes, and the report posted from the package no longer carries the blocking finding. This is a downgrade that skips the check SEC-1 asks to protect; it needs findings.json write access only. Not reached if another gate re-derives severity from the raw reviewer results; I did not find one in this slice, so the precondition is not established by the diff.",
    "suggested_fix": "Seal the severity-bearing fields (id, global_id, severity) when ingest writes findings.json, for example a digest over the list of {key, severity} for heavy findings stored in manifest.seals, and have verifierCheck compute heavy from the sealed list. Or reconcile findings.json against the ingested raw results at complete.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "class_scope": {
      "sites": [
        "src/review/readiness.ts:238"
      ],
      "enumeration_method": "keryx ctx rg for verifierCheck and the readers of findings severity in the close gates; slice-04 holds one severity-keyed gate (verifierCheck). Other severity-keyed gates outside this slice were not enumerated."
    }
  },
  {
    "id": "review-architecture-w1:F-001",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/review/seals.ts",
    "line": 15,
    "quote": "the flow 488 CHANGELOG entry says so",
    "problem": "seals.ts says the operator accepted that a closed package from before the seals may read NOT READY, and that 'the flow 488 CHANGELOG entry says so'. The only CHANGELOG entry (CHANGELOG.md:8, 'Breaking for packages closed through the removed escapes') names packages closed on a `Not verified: N` line or a first-line head statement. The seal rule is wider: partitionWaivers (seals.ts:57) and verificationProblem (seals.ts:72) refuse every waiver and every verification of a package written before the seals existed, including ones recorded honestly through `review complete --waive` or the verifier merge. The CHANGELOG does not mention seals (git grep -i seal CHANGELOG.md finds no flow 488 entry).",
    "impact": "An operator with an older, legitimately closed package sees item `verifier` or a waived item fail and `review publish` refuse it, and the release notes name a different cause (the removed escapes). The code comment points the maintainer to a disclosure that is not there.",
    "suggested_fix": "Extend the CHANGELOG breaking note to say that waivers and verifications recorded before this release carry no seal and are not honoured, with the repair (re-waive with `review complete --waive`, re-run `review ingest --verifications`, or publish with `--partial`); or correct the seals.ts comment so it does not cite an entry that does not say it.",
    "evidence": "src/review/seals.ts:14-16 (comment), :57-62 (partitionWaivers), :66-74 (verificationProblem); CHANGELOG.md:8 at head.",
    "confidence": "high"
  },
  {
    "id": "review-architecture-w4:ARCH-4",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/review/seals.ts",
    "line": 87,
    "quote": "if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)) {",
    "problem": "sealProblems treats the mere presence of `manifest.seals` as 'this package has a target seal', and the header says a package with no seals at all predates them. But waiveReadiness writes `seals: { ...(manifest.seals ?? {}), readinessWaivers }` (readiness.ts:613) with no `target` entry, and it can run on its own: the operator card review_waive_readiness calls it (operator-confirm-review.ts:373) and does not close the package. On a PR-bound package created before this change, that write turns `seals` from undefined into `{ readinessWaivers }`. The next `review complete` or `review publish` then reaches evaluateCloseGates -> sealProblems, finds `seals.target` undefined !== sealTarget(target), and refuses with 'manifest.json target ... does not match the seal keryx wrote'. The refusal comes before the --head path, so the repair it names (--head <sha> --head-reason) cannot clear it, and the operator's own sanctioned act (the card waiver) is what trips it. Found by reading; not run.",
    "impact": "An in-flight PR-bound package from before this release, once the operator waives an item through the card, can no longer be completed or published by any keryx command. Only hand-editing manifest.json clears it, which is the path the seals exist to refuse. It fails closed, so no gate is bypassed. The population is packages started before the upgrade.",
    "suggested_fix": "Decide 'legacy' on `seals?.target === undefined`, not on `seals === undefined`: in sealProblems check the target only when `manifest.seals?.target !== undefined`. Alternatively have waiveReadiness seal the current target when it writes the first seal, the way the test helper close-gates.test-helpers.ts does (`manifest.seals?.target ?? sealTarget(manifest.target)`). Add a test: a package with no seals, a waiver through waiveReadiness, then completeManagedReview closes.",
    "confidence": "medium",
    "evidence": "sealProblems treats the mere presence of `manifest.seals` as 'this package has a target seal', and the header says a package with no seals at all predates them. But waiveReadiness writes `seals: { ...(manifest.seals ?? {}), readinessWaivers }` (readiness.ts:613) with no `target` entry, and it can run on its own: the operator card review_waive_readiness calls it (operator-confirm-review.ts:373) and does not close the package. On a PR-bound package created before this change, that write turns `seals` from undefined into `{ readinessWaivers }`. The next `review complete` or `review publish` then reaches evaluateCloseGates -> sealProblems, finds `seals.target` undefined !== sealTarget(target), and refuses with 'manifest.json target ... does not match the seal keryx wrote'. The refusal comes before the --head path, so the repair it names (--head <sha> --head-reason) cannot clear it, and the operator's own sanctioned act (the card waiver) is what trips it. Found by reading; not run."
  },
  {
    "id": "review-architecture-w6:F-001",
    "title": "The 'closed package skips the live coverage gate' rule is spelled twice with different conditions",
    "severity": "minor",
    "file": "src/review/close-gates.ts",
    "line": 53,
    "quote": "const closedPublish = input.action === \"publish\" && manifest.status === \"closed\";",
    "evidence": "close-gates.ts:53 turns the live coverage check off only when action is publish and the package is closed; its own comment (line 47) says this is the same rule as readiness.ts Context.liveCoverageGate. readiness.ts:470 spells that rule as `liveCoverageGate: manifest.status !== \"closed\"`, with no action term. For `review complete` on an already-closed package, readiness item 3 reads the recorded close while researchRefusals (close-gates.ts:54) re-runs coverage live, so the two halves of one gate evaluation disagree about which coverage verdict applies.",
    "impact": "Maintainability: the rule lives in two places and the comment asserts they match when they do not. A later change to one will silently split complete and publish behaviour again, which is the class flow 488 ARCH-1 set out to remove. Re-completing a closed package is not a path I could show reaching a wrong result, so this is structural only.",
    "suggested_fix": "Compute one `liveCoverage` boolean next to the manifest read (or export it from readiness.ts) and pass it to both packageResearchErrorsTagged and computeReadiness, instead of deriving it twice.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "problem": "The 'closed package skips the live coverage gate' rule is spelled twice with different conditions"
  },
  {
    "id": "review-degradation-w2:F-002",
    "severity": "minor",
    "reviewer": "review-degradation",
    "degradation_class": "diff-vs-description",
    "evidence_kind": "base-diff",
    "file": "CHANGELOG.md",
    "line": 8,
    "quote": "**Breaking for packages closed through the removed escapes.**",
    "problem": "seals.ts:14-15 says that waivers and verifications in packages written before the seals are no longer honoured, and that 'the flow 488 CHANGELOG entry says so'. The Unreleased entry does not say it. It describes only packages closed on a `Not verified: N` line or a first-line head statement, and it never mentions the seals: a pre-seal package's operator waivers (any item) recorded with `--waive` or the card, its ingest-applied verifications, and a manifest edited by hand (head_override, target.head) are now not honoured by complete, publish or readiness.",
    "impact": "An operator who upgrades finds packages that were closed legitimately, with real operator waivers or verifier results, reading NOT READY and refused by publish. The release notes give no cause or repair for that, and they list the repair that F-001 shows dead-ends for PR-bound packages.",
    "suggested_fix": "Extend the Breaking bullet: packages written before this release carry no seals, so their readiness waivers and verifier results are not honoured until they are re-recorded through `review complete --waive` / `review ingest --verifications`; direct edits of manifest.json or findings.json are refused. Once F-001 is fixed, make the stated repair match the code.",
    "evidence": "Read CHANGELOG.md:5-8 at head (the two Unreleased bullets, no mention of seals or of pre-seal waivers and verifications) against seals.ts:14-16 (the comment that claims the CHANGELOG documents it) and against readiness.ts:488 and seals.ts:52-74 (unsealed waivers and verifications are not honoured). Refute attempt: the operator accepted the NOT READY outcome (seals.ts:15; journal SEC-1 decision 'Закрыть в этом PR'), so the behaviour itself is a recorded decision and is not filed here; only the description gap is.",
    "confidence": "high"
  },
  {
    "id": "review-degradation-w2:F-003",
    "severity": "minor",
    "reviewer": "review-degradation",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": ".metaproject/flows/488-2026-11-12-review-audit-p0-gates/acceptance-criteria.md",
    "line": 22,
    "quote": "- AC9: An operator decision the close gates honour",
    "problem": "AC9 was added through `flow ac update` with no `[verify: ...]` marker, so flow.json records it as `\"AC9\": { \"kind\": \"unclassified\" }`. The same file's contract (lines 7-9) requires every criterion to end with an exec, invariant, judged or none marker. AC1-AC7 each carry `[verify: exec ...]` and AC8 carries `[verify: judged]`. The criterion itself asks for a test that edits each file directly and asserts the refusal, and src/review/seals.test.ts ('seals keep hand-written gate inputs out (SEC-1)') looks like that check, but nothing binds AC9 to it.",
    "impact": "AC9 is the one criterion the round-1 scope widening added, and the flow cannot confirm it mechanically. Either `flow complete` stops on an unclassified AC, or AC9 is confirmed with nothing executable behind it.",
    "suggested_fix": "`keryx flow ac update 488 AC9` with the same text plus `[verify: exec \\`bun test src/review/seals.test.ts\\`]`, so acKinds records AC9 as exec.",
    "evidence": "Read slice-02.diff: acceptance-criteria.md hunk (AC9 added with no marker; AC1-AC8 all marked) and flow.json hunk (`\"AC9\": {\"kind\": \"unclassified\"}` beside exec/judged kinds). Not settled: whether `keryx flow complete` refuses an unclassified kind. Check: `keryx flow status 488` or a dry `keryx flow complete 488`.",
    "confidence": "medium"
  },
  {
    "id": "review-degradation-w6:DEG-1",
    "severity": "minor",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "base-diff",
    "file": "src/review/close-gates.ts",
    "line": 52,
    "quote": "const findings = await readFile(path.join(packageDir, \"findings.json\"), \"utf8\").then((text): unknown => JSON.parse(text), () => undefined);",
    "problem": "On base, completeManagedReviewLocked parsed findings.json before any write (`const researchFindings = JSON.parse(await readFile(path.join(packageDir, \"findings.json\"), \"utf8\"));`, base managed.ts:1090, outside the try), so an unreadable or non-JSON findings.json refused the close outright. The PR removes that line; close-gates.ts now turns an unreadable file into `undefined`, which researchErrors reports as \"canonical findings must be an array\" — and packageResearchErrorsTagged tags every researchErrors message with readiness item `ledger` (research.ts:156). researchRefusals (close-gates.ts:57) drops an error whose item is sealed-waived, so `review complete --waive ledger \"<quote>\"` lifts it. computeReadiness then reads the same file as `[]` (readiness.ts:465), so item `verifier` passes vacuously (\"0 blocker/major finding(s), all verified\") and `quotes-located` passes too. The manifest is written `closed` and sealed (managed.ts:1162), active review cleared and the round registered (1176-1179), and only then does the unguarded `JSON.parse(await readFile(path.join(packageDir, \"findings.json\"), \"utf8\"))` at managed.ts:1192 throw, outside the rollback.",
    "impact": "A package whose findings.json is truncated or hand-broken can be closed with one ledger waiver: the flow's review gate then sees a closed round whose verifier item reported clean over zero findings, and the command exits with a SyntaxError after the irreversible writes, leaving no review notes. research.ts:127-130 says an unreadable ledger is an integrity failure no waiver covers; unreadable findings is now the waivable exception. Trigger needs a corrupt file plus an operator waiver, hence minor.",
    "suggested_fix": "In researchRefusals, return an untagged (unwaivable) error when findings.json is unreadable instead of passing `undefined` into the tagged ledger check — e.g. `if (findings === undefined) return [\"findings.json is unreadable or not JSON\"]` — or restore an early parse in completeManagedReviewLocked before the try. Optionally move the managed.ts:1192 read above the manifest write.",
    "evidence": "base-diff: base origin/main managed.ts:1090 `const researchFindings = JSON.parse(...)` before the try; head managed.ts has no such line (slice-06 hunk @@ 1112,1119) and close-gates.ts:52 swallows the parse error. Traced head: close-gates.ts:52 -> research.ts:81 'canonical findings must be an array' -> research.ts:156 tagged ['ledger'] -> close-gates.ts:55-57 waived filter -> readiness.ts:457/465 findings [] -> readiness.ts:245 verifier ok -> managed.ts:1162 manifest closed -> managed.ts:1192 unguarded JSON.parse. Refute: looked for a guard between 1125 and 1162 — recordDispositions reads findings only when --finding dispositions are given; premiseRecords/verdictRecords read via readJson (undefined on failure, verdict.ts:258) and do not throw; missingArtifacts checks existence only. No guard found.",
    "confidence": "medium",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w4:F-001",
    "severity": "minor",
    "file": "docs/docs/cli-reference.md",
    "line": 5112,
    "quote": "`review complete` and its `--waive` and `--waive-coverage` flags refuse these flags and stay on the terminal and card path",
    "evidence": "The unchanged paragraph says `review complete` refuses `--answered-by` and stays on the terminal and card path. The text this PR adds in the same file says a differing `--head` needs `--head-reason` from a terminal or `--answered-by` from a host question. The code agrees with the new text: runComplete reads reviewCompletionHostAnswer(args) and passes hostQuestion (src/commands/review.ts:4935, 4954, 4971), and completeManagedReviewLocked validates it (src/review/managed.ts:1087-1101).",
    "impact": "Two paragraphs of the CLI reference give opposite answers on whether a host question can carry a close, a waiver or a head relabel. An operator or agent following the first paragraph is told to avoid a path the second says works.",
    "suggested_fix": "Reword the sentence at line 5112 to say which `review complete` flags accept `--answered-by` (`--head-reason`, `--waive`, `--waive-coverage`) and under what conditions, matching the code at head.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "problem": "The unchanged paragraph says `review complete` refuses `--answered-by` and stays on the terminal and card path. The text this PR adds in the same file says a differing `--head` needs `--head-reason` from a terminal or `--answered-by` from a host question. The code agrees with the new text: runComplete reads reviewCompletionHostAnswer(args) and passes hostQuestion (src/commands/review.ts:4935, 4954, 4971), and completeManagedReviewLocked validates it (src/review/managed.ts:1087-1101)."
  },
  {
    "id": "review-logic-w6:F-001",
    "file": "CHANGELOG.md",
    "line": 8,
    "quote": "- **Breaking for packages closed through the removed escapes.**",
    "severity": "minor",
    "title": "CHANGELOG omits the seals breakage that src/review/seals.ts says it records",
    "evidence": "src/review/seals.ts:14-15 states packages written before the seals existed carry none, so their waivers and verifications are not honoured, and 'the flow 488 CHANGELOG entry says so'. The Unreleased entries (CHANGELOG.md:5-9) mention only the removed report-line escapes; a search of CHANGELOG.md for 'seal' finds no entry for this change. A package closed earlier with a genuine operator waiver (--waive) or applied verifications now has unhonoured waivers/verifications and reads NOT READY.",
    "impact": "An operator with an old, legitimately waived package sees NOT READY and a refused publish, and the documented repair (re-waive the verifier or head item) is written only for report-line closures; waivers of other items (files-covered, blast-radius, reviewers, ledger) and old verifications are not named. Documentation gap, not a behaviour defect.",
    "suggested_fix": "Add a sentence to the Breaking entry: packages created before this release carry no seals, so their readiness waivers, head overrides and verifier results are no longer honoured; re-run `review complete --waive <item> \"<words>\"` (or `review ingest --verifications`) or publish with `--partial`.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "problem": "CHANGELOG omits the seals breakage that src/review/seals.ts says it records"
  },
  {
    "id": "review-style-w2:F-001",
    "severity": "minor",
    "file": ".metaproject/flows/488-2026-11-12-review-audit-p0-gates/acceptance-criteria.md",
    "line": 24,
    "quote": "- AC9: An operator decision the close gates honour",
    "problem": "AC9 is the only criterion in the file with no trailing verify tag. The file's own header says every criterion ends with [verify: exec `<command>`], [verify: invariant `<command>`], [verify: judged] or [verify: none — <reason>]; AC1-AC8 all follow it. The matching flow.json entry records AC9 as kind \"unclassified\" instead of exec/judged.",
    "impact": "Convention drift in a checksum-protected file: tooling and readers that parse the verify tag cannot tell how AC9 is checked, although the criterion itself names a test that edits each file directly and asserts the refusal.",
    "suggested_fix": "Via `keryx flow ac update`, end AC9 with the real check, e.g. [verify: exec `bun test src/review/seals.test.ts`] (the file added by this round), and set acKinds.AC9 to exec with that check.",
    "evidence": "acceptance-criteria.md lines 4-12 state the rule; lines 16-23 (AC1-AC8) each end in a [verify: ...] tag; the AC9 line added in this round ends at \"...and a test edits each file directly and asserts the refusal.\" with no tag. flow.json acKinds.AC9 is {\"kind\": \"unclassified\"}.",
    "confidence": "high",
    "reviewer": "review-style"
  },
  {
    "id": "review-style-w4:F-001",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/review/readiness.ts",
    "line": 246,
    "quote": "const forged = unverified.filter((entry) => entry.problem !== \"no verification\");",
    "problem": "readiness.ts decides which unverified findings get the 'not honoured' note by comparing entry.problem to the free-text literal \"no verification\", which is a separate string literal returned by verificationProblem in seals.ts (line 69). Two modules agree on a sentence, not on a named constant. The variable is also called `forged`, although the other problem texts (a verification without verdict, method and evidence) are malformed, not necessarily forged.",
    "impact": "Rewording the message in seals.ts silently turns every 'no verification' finding into a 'forged' one in the item-4 evidence, with no type or compile error.",
    "suggested_fix": "Export a constant (e.g. NO_VERIFICATION) from seals.ts and use it in both places, or have verificationProblem return a tagged value; rename `forged` to something like `rejected`.",
    "evidence": "src/review/seals.ts:69 `return \"no verification\";` and src/review/readiness.ts:246 compare the same literal.",
    "confidence": "high"
  },
  {
    "id": "review-style-w4:F-002",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/review/seals.test.ts",
    "line": 32,
    "quote": "const sink = () => {",
    "problem": "The same test scaffolding is copied across the flow 488 test files: the posting `sink` (publish-gate-parity.test.ts:19, seals.test.ts:32, and `io` in readiness-verifier-waiver.test.ts:17), `editManifest` (publish-gate-parity.test.ts:24, seals.test.ts:37, complete-waiver-scope.test.ts:26), and the open-obligation literal `{ id: \"ob-1\", source: \"raw\", question: \"is it real?\", status: \"open\" }` (publish-gate-parity.test.ts:103, complete-waiver-scope.test.ts:23, readiness.test.ts:50). close-gates.test-helpers.ts already exists as the shared home for this kind of fixture.",
    "impact": "A change to the posting seam or the manifest edit shape has to be made in three places; the copies drift.",
    "suggested_fix": "Move `sink`, `editManifest` and an `openObligation` helper into close-gates.test-helpers.ts and import them.",
    "evidence": "keryx ctx rg for `^const sink = `, `^async function editManifest`, `id: \"ob-1\"` over src/review test files lists the sites above.",
    "confidence": "high"
  },
  {
    "id": "review-architecture-w4:ARCH-5",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/review/seals.ts",
    "line": 78,
    "quote": "`review complete` and `review publish`. A package with no seals at all predates them, and its target is not checked.",
    "problem": "The legacy exemption for the target check is keyed on the absence of `manifest.seals`, a field the same agent that could forge a target can delete. Removing the whole `seals` key skips the target comparison entirely, which is cheaper than recomputing the digest. The header of seals.ts states the level honestly ('evidence that a file was edited outside keryx, not a signature'; a recomputed digest is not stopped), and the legacy leniency is a stated choice, so this is not reported as a defect. It is noted because deletion and recomputation are both one edit, and nothing in the stamp ties 'sealed' to the package: a package keryx created after this release carries `roundRecord`/`operatorGate` (start/attach), and an ingest package carries neither.",
    "impact": "None beyond what the module already concedes. Would matter only if the seals are later described as stopping a deliberate edit rather than showing an accidental or naive one.",
    "suggested_fix": "If the exemption is meant to cover only genuinely old packages, record a seal-format marker (for example `seals.v`) at creation and treat its absence on a post-release package as tampering. Otherwise state in the CHANGELOG entry that removing `seals` is equivalent to a legacy package.",
    "confidence": "medium",
    "evidence": "The legacy exemption for the target check is keyed on the absence of `manifest.seals`, a field the same agent that could forge a target can delete. Removing the whole `seals` key skips the target comparison entirely, which is cheaper than recomputing the digest. The header of seals.ts states the level honestly ('evidence that a file was edited outside keryx, not a signature'; a recomputed digest is not stopped), and the legacy leniency is a stated choice, so this is not reported as a defect. It is noted because deletion and recomputation are both one edit, and nothing in the stamp ties 'sealed' to the package: a package keryx created after this release carries `roundRecord`/`operatorGate` (start/attach), and an ingest package carries neither."
  },
  {
    "id": "review-architecture-w6:F-002",
    "title": "research.ts, a lower-level ledger module, depends on readiness.ts vocabulary while readiness.ts imports research.ts at runtime",
    "severity": "info",
    "file": "src/review/research.ts",
    "line": 9,
    "quote": "import type { ReadinessItemId } from \"./readiness\";",
    "evidence": "readiness.ts imports dispatchRuns, packageCoverageErrors and researchErrors from ./research at runtime; research.ts imports ReadinessItemId from ./readiness as a type. The import is type-only and the comment at research.ts:8 names the reason, so there is no runtime cycle and the choice is deliberate.",
    "impact": "None at runtime. The item-id type belongs to the checklist, and the ledger now cannot be read or tested without readiness.ts compiling; moving READINESS_ITEMS ids into a small types module would restore a one-way dependency. Reported as info because the author's stated reason holds and nothing breaks.",
    "suggested_fix": "Optional: export ReadinessItemId from types.ts (or a readiness-items.ts) and import it from there in both modules.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "problem": "research.ts, a lower-level ledger module, depends on readiness.ts vocabulary while readiness.ts imports research.ts at runtime"
  },
  {
    "id": "review-degradation-w1:F-002",
    "reviewer": "review-degradation",
    "severity": "info",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "consumer-trace",
    "file": "src/review/seals.ts",
    "line": null,
    "quote": "if (manifest.seals !== undefined && isPrBound(manifest.target) && manifest.seals.target !== sealTarget(manifest.target)) {",
    "problem": "A hand edit to target.head is refused only while the manifest has a `seals` key. If an agent deletes `seals` from manifest.json and rewrites target.head to the PR head, sealProblems returns nothing. completeHeadGate then compares the forged head with the PR head and passes, and the close at managed.ts:1148-1150 writes no seals (stored.seals undefined, no --head). The agent gives up only unsealed waivers and verifications, which a package with no blocker/major findings and no waivers does not need. Deleting a key is a cheaper bypass than the recomputed digest that seals.ts:12-14 accepts as out of scope. journal.md:36 lists 'a package with no `seals` keeps its target unchecked' as a known gap, so this is recorded, not filed as a defect.",
    "impact": "SEC-1's point (3), a hand-rewritten target.head, is still open on a package whose `seals` key is deleted. seals.test.ts (b) covers only the case where seals is present.",
    "suggested_fix": "Record at review start something the agent cannot drop without notice, for example a seal-schema marker in round.json, which roundRecordTampered already hashes. Refuse a PR-bound package whose round record says it was sealed but whose manifest has no seals. Add a seals.test.ts case that deletes `seals` and rewrites target.head.",
    "evidence": "Read seals.ts:80-93, managed.ts:521 (seals written only at ingest), managed.ts:1148-1150, close-gates.ts:62-66, seals.test.ts:81-85. Refute: journal.md:36 names the gap, so this stays info.",
    "confidence": "high"
  },
  {
    "id": "review-degradation-w1:F-003",
    "reviewer": "review-degradation",
    "severity": "info",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": "docs/docs/guides/review-with-a-record.md",
    "line": null,
    "quote": "| 7 | the report's head is the PR head |",
    "problem": "The fix retitled readiness item 7 in both SKILL.detail.md copies and in READINESS_ITEMS (readiness.ts:40: 'the head recorded for the round matches the PR head'). The user guide's checklist table still titles the item 'the report's head is the PR head'. Its repair column does say a report line does not pass it. This is the last site of the class review-architecture-w1:F-001 and review-logic-w2:F-001 named.",
    "impact": "The guide names the check by the property the flow removed, so a reader may still look to report.md for item 7.",
    "suggested_fix": "Retitle the row as readiness.ts:40 does: 'the head recorded for the round matches the PR head'.",
    "evidence": "keryx ctx rg for \"report's head\" over src and docs: one hit each in docs/docs/guides/review-with-a-record.md:788 and src/review/readiness.ts:40 (the new title).",
    "confidence": "high"
  },
  {
    "id": "review-degradation-w1:F-004",
    "reviewer": "review-degradation",
    "severity": "info",
    "location_class": "pre-existing",
    "degradation_class": "debt",
    "evidence_kind": "base-diff",
    "file": "src/gdskills/model-tier.ts",
    "line": null,
    "quote": "// `model_tier` input into the `{ kind: \"tier\" }` request. From there",
    "problem": "Pre-existing, the sibling of review-degradation-w2:F-003. model-selection.mdc was fixed, but the module header of model-tier.ts (lines 18-25) still says createSpawnSubagentTool turns the tool's `model_tier` input into a tier request. spawn_subagent now ignores model_tier (SPAWN_SUBAGENT_IGNORED_FIELDS, spawn-subagent-tool.ts:1067).",
    "impact": "A maintainer reading the producer of the tier map is told about a wire that no longer carries the field.",
    "suggested_fix": "Rewrite lines 18-25 to name model_class and model routing, as model-selection.mdc:201-206 now does.",
    "evidence": "keryx ctx rg 'model_tier. input' over the repo: model-tier.ts:22 is the only remaining hit outside history.",
    "confidence": "medium"
  },
  {
    "id": "review-degradation-w4:F-002",
    "reviewer": "review-degradation",
    "severity": "info",
    "publication": "question",
    "degradation_class": "behaviour-delta",
    "evidence_kind": "consumer-trace",
    "file": "src/review/flow-move.ts",
    "line": 226,
    "quote": "await planJson(plan, path.join(packageDir, \"findings.json\"), finalOf, (value) => mapStrings(value, movePath));",
    "problem": "A flow renumber rewrites every string in findings.json that starts with `.metaproject/flows/<old>/`, and that includes the fields inside `verification`. The seal (seals.ts:42, sealVerification over the whole verification object) is not recomputed. A verified heavy finding whose verification.evidence (or method/verifier) starts with the old flow path would then read as a forged verification at verifier item 4 after the move. On base, verification was not sealed, so the move was harmless. If true: minor, a moved package goes NOT READY on item verifier and publish is refused without --partial or a waiver.",
    "evidence": "consumer-trace: flow-move.ts:207-208 movePath rewrites a string only when the whole value starts with the old prefix. mapStrings (flow-move.ts:298-308) walks every nested string. seals.ts:72 compares manifest.seals.verifications[key] against sealVerification(key, finding.verification). Whether real verifier evidence ever starts with a flow path is data the code cannot answer: verify-run.ts:154 appends the record path rather than prefixing it.",
    "impact": "After housekeeping renumbers a flow, a verified package can lose its verifier pass silently.",
    "suggested_fix": "Check: grep existing packages' findings.json for a verification.evidence that starts with `.metaproject/flows/`. If any exist, re-seal verifications in flow-move, or exclude `verification` from mapStrings.",
    "confidence": "low"
  },
  {
    "id": "review-degradation-w6:DEG-2",
    "severity": "info",
    "degradation_class": "diff-vs-description",
    "evidence_kind": "base-diff",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md",
    "line": 776,
    "quote": "7. `head` — the head recorded at `review start` is still the PR head and the PR is not merged; otherwise only the operator's `head` waiver lifts it (no report line does).",
    "problem": "The rewritten item-7 line says the gate checks the head recorded at `review start`, but with `review complete --head <sha>` the gate checks the --head value (managed.ts:1077 rewrites manifest.target.head before completeHeadGate at 1106), as the help text in review.ts:5681-5683 states. The same line is in .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md:776.",
    "impact": "An orchestrator reading the skill may believe --head cannot repair item 7 and reach for a waiver instead; wording only, no code effect.",
    "suggested_fix": "Say \"the head the round records (the one from `review start`, or `--head`)\" in both copies.",
    "evidence": "read SKILL.detail.md:776 (both copies) against managed.ts:1059-1078 and :1106 and review.ts:5681-5688.",
    "confidence": "medium",
    "reviewer": "review-degradation",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w1:F-001",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/review/seals.ts",
    "line": 28,
    "quote": "return createHash(\"sha256\").update(canonicalJson({ seal: SEAL_DOMAIN, kind, content })).digest(\"hex\");",
    "problem": "The seal is an unkeyed sha256 over a public domain string and canonical JSON. An agent that reads seals.ts can recompute the digest for a hand-written readiness waiver, head_override or verification and write it into manifest.seals. The tamper evidence therefore stops edits made without knowing the scheme, not an agent that reproduces it.",
    "evidence": "seals.ts:28 and the header comment (lines 14-17) say 'evidence that a file was edited outside keryx, not a signature' and 'cryptography is out of scope, flow 488 description'. The gates honour any entry whose digest matches (seals.ts waiverSealed, verificationProblem, sealProblems). Nothing in the code at head holds a secret.",
    "impact": "SEC-1 is closed to the level the flow chose (hand edits are not honoured and the item names the unsealed entry). A deliberate forger who recomputes the digest still passes. This is recorded, not a defect in the fix.",
    "suggested_fix": "None required for this PR. If the threat model ever includes an agent that reads the source, key the digest with a per-package secret held outside the package directory.",
    "confidence": "high"
  },
  {
    "id": "review-style-w1:F-001",
    "severity": "info",
    "file": "src/review/close-gates.ts",
    "line": 65,
    "quote": "const sealed = sealProblems(await readManifest(packageDir));",
    "title": "evaluateCloseGates reads manifest.json twice per call",
    "evidence": "close-gates.ts:65 reads the manifest for the seal check; researchRefusals (line 50, called at line 77) reads it again with readManifest. beforeReadiness (line 76) can rewrite the manifest in between (waiver recording), so the second read is deliberate for `review complete`, but the first read is not needed again for publish.",
    "impact": "Readability only: a reader must work out why the manifest is read twice and whether the two reads may differ. No functional defect found.",
    "suggested_fix": "Add a one-line comment at the second read saying it re-reads after beforeReadiness recorded waivers, or pass the first read in where no hook ran.",
    "confidence": "medium",
    "reviewer": "review-style",
    "problem": "evaluateCloseGates reads manifest.json twice per call"
  },
  {
    "id": "review-style-w4:F-003",
    "reviewer": "review-style",
    "severity": "info",
    "file": "src/review/managed.ts",
    "line": 1079,
    "quote": "// Review F-001 (logic w3): a quote with nothing to relabel would be recorded nowhere while the close reports success.",
    "problem": "Comments and test titles cite review-round ids (F-001 logic w3, SEC-1, ARCH-1, TP-1, TP-2, TP-3). These ids resolve only against a review package that is not part of the code, so a later reader cannot follow them. The sentences after the id explain the reason well and stand alone.",
    "impact": "Noise that ages badly; the id adds nothing once the reason is stated.",
    "suggested_fix": "Drop the review ids and keep the reason text (the flow 488 reference is enough as the anchor).",
    "evidence": "Sites: src/review/managed.ts:1079, src/review/seals.ts:1, src/review/close-gates.ts:44, src/review/seals.test.ts:1, src/review/publish-gate-parity.test.ts:82, src/review/complete-waiver-scope.test.ts:71, src/review/publish.test.ts:148 and :156, src/review/readiness.test.ts:166.",
    "confidence": "medium"
  },
  {
    "id": "review-style-w4:F-004",
    "reviewer": "review-style",
    "severity": "info",
    "file": "src/review/seals.ts",
    "line": 64,
    "quote": "const filled = (value: unknown): boolean => typeof value === \"string\" && value.trim() !== \"\";",
    "problem": "`filled` is defined again here with the same body as the local `filled` inside isHostQuestion in src/review/types.ts:119.",
    "impact": "Two copies of a one-line non-blank-string predicate; small, but the next tweak lands in one.",
    "suggested_fix": "Export one predicate from a shared review util (or types.ts) and reuse it.",
    "evidence": "keryx ctx rg `const filled` in src/review non-test files: seals.ts:64 and types.ts:119.",
    "confidence": "high"
  },
  {
    "id": "review-style-w4:F-005",
    "reviewer": "review-style",
    "severity": "info",
    "file": "src/review/managed.ts",
    "line": 1072,
    "quote": "throw new Error(`Cannot complete managed review; --head ${head} differs from the head recorded when the round started",
    "problem": "close-gates.ts now holds the refusal prefix in a module constant `REFUSAL = \"Cannot complete managed review;\"`, while managed.ts spells the same prefix out at three throw sites, two of them added or touched by this PR.",
    "impact": "The prefix is a user-visible contract the parity tests compare; two spellings can diverge.",
    "suggested_fix": "Export REFUSAL from close-gates.ts (or a small constants module) and use it in managed.ts.",
    "evidence": "keryx ctx rg `Cannot complete managed review;`: managed.ts:1054, :1072, :1082 and close-gates.ts:35.",
    "confidence": "high"
  },
  {
    "id": "review-testing-practices-w1:F-001",
    "severity": "info",
    "file": "src/review/close-gates.ts",
    "line": 53,
    "quote": "const closedPublish = input.action === \"publish\" && manifest.status === \"closed\";",
    "evidence": "The closedPublish branch (publish of a closed package skips the live coverage gate: packageResearchErrorsTagged(..., { coverage: false })) has no test I could find that publishes a closed package with a coverage error pending; publish-gate-parity.test.ts has no 'closed' match and the --partial/relax cases do not reach it. This is read-only evidence: the mutation pass was not run (this round allows no test execution), so the survival of a deletion is a prediction, not a result.",
    "impact": "If the branch is dropped, publishing a package already closed would be re-held to the live coverage gate; nothing would fail in the suite if so. Not verified by execution.",
    "suggested_fix": "Add one publish-gate-parity case: a closed package whose coverage input has since changed still publishes; and a non-closed one with the same input is refused. Then run it with the branch deleted.",
    "confidence": "low",
    "reviewer": "review-testing-practices",
    "problem": "The closedPublish branch (publish of a closed package skips the live coverage gate: packageResearchErrorsTagged(..., { coverage: false })) has no test I could find that publishes a closed package with a coverage error pending; publish-gate-parity.test.ts has no 'closed' match and the --partial/relax cases do not reach it. This is read-only evidence: the mutation pass was not run (this round allows no test execution), so the survival of a deletion is a prediction, not a result."
  },
  {
    "id": "review-testing-practices-w4:TP-1",
    "severity": "info",
    "file": "src/review/managed.ts",
    "line": 519,
    "quote": "carriedVerification.has(key) && carriedVerification.get(key) !== finding.verification",
    "problem": "Several branches added for flow 488 AC9 appear to have no test that separates them from the condition beside them. Read from the test files, not run: (1) managed.ts:519 `carriedVerification.has(key) && carriedVerification.get(key) !== finding.verification` is the clause that keeps a verification carried INTO the merge from being sealed. seals.test.ts's reviewer result (REVIEWER_RESULT) carries no `verification`, so no fixture feeds an agent-supplied verification through ingest and asserts it stays unsealed. (2) seals.ts `verificationProblem` tests `!filled(verdict) || !filled(method) || !filled(evidence)`; the only inputs are `{}` and `{ verdict }` (readiness.test.ts), so a verdict+method record without evidence, or verdict+evidence without method, separates nothing. (3) readiness.ts:610 `keptSeals` (a waiver kept across a second `--waive` keeps its seal) has no test that waives a second item and then re-checks the first. (4) managed.ts:1148 `stored.seals !== undefined || options.head !== undefined` (a pre-seal package closed without `--head` gains no seals) has no test that closes such a package and reads back `seals`. (5) close-gates.ts:53-54 `closedPublish ? { coverage: false } : {}` has no fixture whose closed package fails the live coverage gate, so nothing separates it from the open-package path.",
    "evidence": "keryx ctx rg over src/review/*.test.ts for `readinessWaivers|seals?.|unsealed|manifest.seals` returns one hit (readiness.test.ts:71, the fixture helper); `verification: {` / `verification: VERIFIED` appear in seals.test.ts only in post-ingest writeFindings calls and in the ingest-applied verification, never in a reviewer result; publish-gate-parity.test.ts and seals.test.ts name no closed-package coverage case. Not confirmed by execution: the mutants are in mutant_candidates (ids M1-M5) and unrun.",
    "impact": "If a later edit drops one of these clauses, the suite may stay green while the SEC-1 property it implements (only a keryx-applied verification and a keryx-written waiver or head count) loosens. The gates themselves read correct at head.",
    "suggested_fix": "Run M1-M5 first. For (1) add a seals.test.ts case whose reviewer result finding carries a well-formed `verification` and assert the item `verifier` still fails and `manifest.seals.verifications` has no key for it. For (2) add `{ verdict, method }` and `{ verdict, evidence }` to the readiness.test.ts loop. For (3) waive `verifier` then `files-covered` in two calls and assert both are honoured; then hand-edit one quote and assert only it is refused. For (4) close a package built without seals and assert `seals` stays undefined. For (5) a closed package with an uncovered scope file must still publish.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  }
]
```
