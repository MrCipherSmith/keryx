# Flow 338 (W4 batch 6) — Consolidated adversarial review, PR #733

Two opus review rounds against the stack-pack lessons checklist (`.metaproject`
scratchpad `stack-pack-lessons.md`), each followed by a fix pass and a narrow
opus verification of that pass. Round 1 found 2 blockers, 4 majors, several
minors, 2 info; round 2 (verifying round 1's fixes) found 2 of those (B1, M2)
only partly closed and re-opened them; the round-2 verification pass confirmed
all blockers/majors closed (0 blocker, 0 major remaining) plus three small
non-blocking follow-ups, all addressed before merge. A CI-only failure
(`runStocktake`'s skill-specific-reason guard, W1-AC11) was found and fixed
after that, unrelated to the adversarial review's own findings.

## Blocker

### [B1] honest-gate re-run was gamed, not honest
- **Severity**: blocker
- Commit `b2ea46de` (a fix pass between the honest gate's two runs)
  restated several FAILING eval prompts near-verbatim inside `SKILL.md`
  `description:`/`triggers:` text (Jaccard ≥0.5 against the specific
  failing prompt each was meant to fix), so the second run's PASS
  verdicts for `ci-pipeline-implementation`/`ci-pipeline-code-review`
  were not honest held-out results. Two more instances (Helm-render
  clause in `docker-k8s-terraform-build-fix`, "Resource not accessible"
  parenthetical in `ci-pipeline-build-fix`) were missed in the first fix
  pass and caught only by round 2's own re-measurement.
- **Fix**: every restated line reverted to exact run-1 wording across two
  fix commits; run 1 made the official gate result (`governance/eval.json`
  rebuilt verbatim from run-1 raw output, byte-identical); no gate re-run
  performed. Reviewer's own `i11.ts` near-copy measurement confirmed 0
  matches after both fix passes.

### [B2] I11 not enforced for the two new packs; 5 near-copy positives
- **Severity**: blocker
- `I11_ENFORCED_PACKS` (`stack-pack-eval-integrity.test.ts`) did not list
  `docker-k8s-terraform`/`ci-github-gitlab`, so 5 near-copy eval-positive/
  trigger pairs (2 introduced by the fix pass, 3 pre-existing from Phase A
  authoring) went uncaught.
- **Fix**: both packs added to `I11_ENFORCED_PACKS`; all 5 near-copies
  reworded to read as distinct real requests, without touching
  calibration/rubric content.

## Major

### [M1] Kubernetes NetworkPolicy ingress semantics inverted
- **Severity**: major
- `rules/security.mdc` and the review `SKILL.md` claimed `ingress: []`
  was the wide-open/allow-all shape; NetworkPolicy is fail-closed —
  an empty/omitted `ingress:` is deny-all, `ingress: [{}]` is allow-all.
- **Fix**: corrected in both files, ctx7-verified against Kubernetes docs.

### [M2] false claim that GitLab CI needs GitHub's env:/variables: injection fix
- **Severity**: major
- The rule claimed GitLab CI/CD variables need the same intermediate-
  variable routing GitHub Actions' `${{ }}` does — false, since a GitLab
  variable is already a shell environment variable by the time `script:`
  runs. Found repeated in 5 total locations across two review rounds
  (`rules/security.mdc`, `pack.json`'s `auditFocus`, and one paragraph
  each in `ci-pipeline-implementation`/`ci-pipeline-code-review`, then
  three more spots round 2 caught: implementation Step 3, code-review's
  flag list and verification checklist).
- **Fix**: all locations rewritten around the real risks (unquoted
  expansion, `eval`/`sh -c` concatenation, `$[[ inputs.* ]]` config-time
  interpolation), ctx7-verified against GitLab docs; the `$[[ inputs.* ]]`
  wording also narrowed to name pipeline/trigger inputs specifically.

### [M3] pack.json notes.implement/test rationales were false
- **Severity**: major
- `notes.implement` repeated the W1 spec's own inaccurate claim that
  "config authoring lives in the deploy quality skill" — `deploy` only
  runs release pipelines, per its own SKILL.md. `notes.test` claimed no
  test-writing concept exists for this family — false: `terraform test`/
  `.tftest.hcl` and `helm test`/helm-unittest are real.
- **Fix**: both notes (plus `notes.migrate`) rewritten as honest
  deferrals, ctx7-verified; the review skill's "fix a plan" redirect to
  `deploy` corrected to `docker-k8s-terraform-build-fix`; W1 doc's table
  row and prose annotated as superseded.

### [M4] journal/doc regression-causality record was wrong
- **Severity**: major
- Two claims in this flow's own prior journal/doc record were incorrect
  relative to the archived run-1 raw data (which negative was caused by
  the fix commit vs. already failing in run 1).
- **Fix**: both corrected against the archived `gate-evidence/run1/` data.

## Minor (bundled — full list in the flow journal's review-round sections)

- **Severity**: minor
- Missing-USER claim contradicting `patterns.mdc`; Terraform `use_lockfile`/
  `moved`-block/`force_destroy` coverage; `pull_request_target`/
  `pull_request` token-access wording; `permission-scope-fix` eval
  scenario's rubric/subtle_wrong issues (a calibration content change,
  AG judge-check re-recorded, no gate re-run); path-coverage gaps
  (`deploy/`, `manifests/`, kustomize, chart `values.yaml`, the reversed
  `Dockerfile.*` wildcard convention — `authoring-lint.ts` gained a new
  `globMatchToken` branch, later tightened with a 4-char floor,
  `Containerfile`, GitLab `include:`, composite `action.yml`); dropped
  `interruptible` from deploy guidance; `testing.mdc` self-contradiction;
  self-contradictory `agent-refs.json` phrasing; W1 "Kept" list precision;
  a vacuous regression test retargeted to actually exercise the floor it
  tests.
- **Fix**: all addressed across the two review rounds and the small
  follow-up commit before merge; see the flow journal's "PR review round
  1"/"PR review round 2"/"Round 2 verification" sections for the
  file-by-file accounting.

## Info

- Anti-pattern tokens (`USER root`, `FROM node:latest`, `pull_request_target`)
  necessarily also appear in `calibration.known_right` for scenarios that
  must name the exact pattern being reviewed — assessed against
  `stack-pack-eval-integrity.test.ts`'s own I6/I7 definitions (presence in
  SKILL.md/known_wrong/rubric, never absence from known_right) and the
  live-judge AG check, both of which confirm this is not a defect. No
  change made; recorded as an assessed, not overlooked, point.
- CI-only failure (`runStocktake`'s skill-specific-reason guard) found and
  fixed after the adversarial review closed, from a coincidental stocktake
  evidence tie between `ci-pipeline-build-fix` and an unrelated
  pre-existing skill (`orchestration/feature-dev`) caused by catalog
  growth — not an adversarial-review finding, noted here for completeness.

```json keryx:findings
[
  {
    "status": "DONE_WITH_CONCERNS",
    "reviewer": "review-orchestrator",
    "summary": "2 blockers, 4 majors, several minors, 2 info across two rounds; all blocker/major findings fixed and verified before merge",
    "findings": [
      {
        "id": "B1",
        "severity": "blocker",
        "file": "src/gdskills/bundled/stacks/ci-github-gitlab/skills/ci-pipeline-build-fix/SKILL.md",
        "problem": "honest-gate re-run was gamed: description/triggers text restated failing eval prompts near-verbatim",
        "impact": "second run's PASS verdicts were not honest held-out results",
        "suggested_fix": "revert every restated line to run-1 wording; make run 1 the official gate result",
        "evidence": "i11.ts near-copy measurement, Jaccard >=0.5 against failing prompts",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/ci-github-gitlab/skills/ci-pipeline-implementation/SKILL.md",
            "src/gdskills/bundled/stacks/ci-github-gitlab/skills/ci-pipeline-code-review/SKILL.md",
            "src/gdskills/bundled/stacks/docker-k8s-terraform/skills/docker-k8s-terraform-build-fix/SKILL.md"
          ],
          "enumeration_method": "i11.ts run against every SKILL.md description/triggers line in both new packs vs each skill's own evals.json positives, both review rounds"
        }
      },
      {
        "id": "B2",
        "severity": "blocker",
        "file": "src/gdskills/stack-pack-eval-integrity.test.ts",
        "problem": "I11 not enforced for the two new packs; 5 near-copy positive/trigger pairs",
        "impact": "near-copy trigger prompts could pass eval integrity undetected",
        "suggested_fix": "add both packs to I11_ENFORCED_PACKS; reword the near-copies",
        "evidence": "i11.ts measurement",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/docker-k8s-terraform/skills/docker-k8s-terraform-review/evals.json"
          ],
          "enumeration_method": "i11.ts full-catalog run; only docker-k8s-terraform-review carried pre-existing (Phase A) near-copies beyond the ones fixed under B1"
        }
      },
      {
        "id": "M1",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/docker-k8s-terraform/rules/security.mdc",
        "problem": "Kubernetes NetworkPolicy ingress: [] vs ingress: [{}] semantics inverted",
        "impact": "guidance would tell a user the deny-all shape is allow-all and vice versa",
        "suggested_fix": "correct per Kubernetes NetworkPolicy fail-closed semantics",
        "evidence": "ctx7 Kubernetes docs",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/docker-k8s-terraform/skills/docker-k8s-terraform-review/SKILL.md"
          ],
          "enumeration_method": "grep for ingress:/NetworkPolicy wording across the pack"
        }
      },
      {
        "id": "M2",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/ci-github-gitlab/rules/security.mdc",
        "problem": "false claim that GitLab CI needs the same env:/variables: injection fix GitHub Actions does",
        "impact": "guidance would recommend a fix that changes nothing about the actual risk",
        "suggested_fix": "rewrite around real risks (unquoted expansion, eval/sh -c, $[[ inputs.* ]])",
        "evidence": "ctx7 GitLab docs",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/ci-github-gitlab/pack.json",
            "src/gdskills/bundled/stacks/ci-github-gitlab/skills/ci-pipeline-implementation/SKILL.md",
            "src/gdskills/bundled/stacks/ci-github-gitlab/skills/ci-pipeline-code-review/SKILL.md"
          ],
          "enumeration_method": "grep for the false variables:-indirection claim across the pack"
        }
      },
      {
        "id": "M3",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/docker-k8s-terraform/pack.json",
        "problem": "notes.implement/notes.test rationales were false (deploy doesn't author configs; terraform test/helm test are real)",
        "impact": "misleads a reader of the pack about why implement/test skills were omitted",
        "suggested_fix": "rewrite as honest deferrals",
        "evidence": "deploy/SKILL.md read directly; ctx7 Terraform/Helm docs",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/docker-k8s-terraform/skills/docker-k8s-terraform-review/SKILL.md",
            "src/gdskills/bundled/stacks/docker-k8s-terraform/rules/testing.mdc",
            "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md"
          ],
          "enumeration_method": "traced the false 'deploy authors configs' and 'no test concept' claims to every place they were repeated or relied upon"
        }
      },
      {
        "id": "M4",
        "severity": "major",
        "file": ".metaproject/flows/338-2026-09-25-wave-4-batch-6-stack-packs-for-docker-k8/journal.md",
        "problem": "two causality claims about which gate run caused which failure were wrong",
        "impact": "misleading record of the honest-gate history",
        "suggested_fix": "correct against archived run-1 raw data",
        "evidence": "gate-evidence/run1/*.json raw output",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md"
          ],
          "enumeration_method": "cross-checked every per-scenario causality claim in the journal and W1 doc against the two skills' archived run-1 raw JSON"
        }
      },
      {
        "id": "MIN-1",
        "severity": "minor",
        "problem": "multiple minor content/wording/test-quality issues bundled (see report body)",
        "impact": "various small correctness/clarity gaps",
        "suggested_fix": "see report body for the full itemized list",
        "evidence": "manual review of pack content and test files",
        "confidence": "medium"
      },
      {
        "id": "INFO-1",
        "severity": "info",
        "problem": "anti_patterns tokens also present in calibration.known_right for scenarios naming the exact pattern reviewed",
        "impact": "none — assessed against I6/I7's actual requirement and the live-judge AG check",
        "suggested_fix": "no action needed",
        "evidence": "stack-pack-eval-integrity.test.ts I6/I7 definitions; AG judge-check results",
        "confidence": "high"
      }
    ],
    "stats": { "blocker": 2, "major": 4, "minor": 1, "info": 1 }
  }
]
```
