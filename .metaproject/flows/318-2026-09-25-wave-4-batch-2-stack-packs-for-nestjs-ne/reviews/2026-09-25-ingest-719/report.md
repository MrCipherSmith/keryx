# Adversarial review — round 2 (PR #719, flow 318, narrow verification of review-r1 fixes)

I recommend **block**. Every r1 blocker and major is fixed in the current tree (head `047435a7`, same as the PR head). But CI is red again for a different reason, and angular's `stable` status rests on eval prompts that don't hold up when I rephrase them naturally.

**Counts:** 1 blocker, 1 major, 8 minor, 2 info.

Full narrative report preserved verbatim at `scratchpad/f318/review-r2.md` (this session's scratchpad).

<!-- The machine-readable half of the same report: this round's own new findings. -->

```json keryx:findings
[
  {
    "status": "DONE_WITH_CONCERNS",
    "reviewer": "opus-adversarial-r2",
    "summary": "I recommend block. Every r1 blocker and major is fixed in the current tree (head 047435a7, same as the PR head). But CI is red again for a different reason, and angular's stable status rests on eval prompts that don't hold up when rephrased naturally.",
    "findings": [
      {
        "id": "N-B1",
        "severity": "blocker",
        "file": "src/agents/verify.test.ts",
        "line": 558,
        "problem": "tsc --noEmit reports 9 TS18048 errors ('pair.auditor' is possibly 'undefined') at src/agents/verify.test.ts lines 558-604. The M2 fix made GeneratedAgentPair.auditor/.fixer optional (src/agents/generate.ts:44-45), but the drift tests still read pair.auditor.name/.content directly.",
        "impact": "CI typecheck-and-tests fails, so CI never runs typecheck:scripts or test:core on this head; tests only pass locally because Bun doesn't typecheck.",
        "suggested_fix": "Add a non-null assertion or a guard at those call sites, then get CI fully green.",
        "evidence": "CI run 36154441118, tsc --noEmit output (9 TS18048 errors at verify.test.ts:558-604); local test:core also showed 156 unrelated environmental failures, not this PR's doing.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2",
        "class_scope": {
          "sites": [
            "src/agents/verify.test.ts:558-604"
          ],
          "enumeration_method": "Reviewer ran tsc --noEmit on the PR head and read every TS18048 site it reported."
        }
      },
      {
        "id": "N-M1",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-testing/evals.json",
        "line": null,
        "problem": "Angular's stable gate pass depends on prompt choices that don't survive natural rephrasing (the M3 problem in a form I11 doesn't catch), verified with the real router (checkSkillSelected, field: full, bundled catalog). The angular-testing e2e negative was reworded after it failed (commit c9bd5ecfd, 'avoiding the literal test/write tokens'); natural versions of that request ('Write an end-to-end test...', 'Write a Playwright e2e test...') select angular-testing and would count as false positives — the scorer-dodging minor-4 flagged was moved, not removed. 13 of 25 angular positives contain >=75% of a frontmatter trigger's router tokens (I11's Jaccard passes because padding lowers Jaccard); clear synonym swaps exist in angular-implementation. Only 1 of 6 plain-language probes for angular-implementation selected it. It is inconsistent with nestjs, which was honestly demoted for the same class of problem.",
        "impact": "angular keeps stable status and its generated agent pair on trigger prompts an honest router would mostly not select.",
        "suggested_fix": "Restore a natural e2e negative, de-prefix the angular-implementation positives, re-run the gate, and accept the result (probably experimental and no pair). Or have the owner record an explicit decision that accepts this.",
        "evidence": "Reviewer ran checkSkillSelected against the live router with natural rephrasings and measured router-token containment across angular's 25 positives.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/angular/skills/angular-testing/evals.json",
            "src/gdskills/bundled/stacks/angular/skills/angular-implementation/evals.json",
            "src/gdskills/bundled/stacks/angular/skills/angular-implementation/SKILL.md (triggers)"
          ],
          "enumeration_method": "Reviewer ran the live router (checkSkillSelected) against every angular positive and a set of natural rephrasing probes, and measured containment of frontmatter trigger tokens."
        }
      },
      {
        "id": "N-MIN1",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/mobx/skills/mobx-store-implementation/evals.json",
        "line": null,
        "problem": "mobx shows the N-M1 pattern at lower density: trigger-prefix positives, and triggers widened to mirror positives.",
        "impact": "mobx is stable, but no agent pair depends on it, so this has no gate consequence today.",
        "suggested_fix": "Apply the same realism treatment as angular in a follow-up.",
        "evidence": "Reviewer's containment measurement over mobx-store-implementation's positives.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN2",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-code-review/SKILL.md",
        "line": null,
        "problem": "The body of angular-code-review/SKILL.md Step 2 still has the broad OnPush claim ('that mutation won't trigger a re-check'). Only the frontmatter description was fixed by M5.",
        "impact": "The SKILL body still teaches the wrong mechanism even though the eval scenario was corrected.",
        "suggested_fix": "Fix the Step 2 body prose to match the corrected frontmatter/scenario.",
        "evidence": "Direct read of angular-code-review/SKILL.md Step 2 against the M5-fixed scenario.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN3",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json",
        "line": null,
        "problem": "The OnPush fail_criteria[1] says this.items = [...this.items] doesn't make CartList update. Done after the push, it does create a new reference and works, so a valid answer is at risk.",
        "impact": "A genuinely valid fix can be graded as failing.",
        "suggested_fix": "Narrow fail_criteria[1] to only the true no-op (this.items = this.items).",
        "evidence": "Direct read of the OnPush scenario's fail_criteria against Angular change-detection semantics.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN4",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-implementation/evals.json",
        "line": null,
        "problem": "In the inject scenario, pass criterion 2 requires field or constructor injection. A valid runInInjectionContext(this.injector, ...) answer, which the rubric itself names, would fail.",
        "impact": "A rubric-endorsed valid answer can be graded as failing.",
        "suggested_fix": "Widen pass criterion 2 to accept runInInjectionContext with the Injector captured beforehand in a valid context.",
        "evidence": "Direct read of the inject scenario's rubric and pass_criteria.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN5",
        "severity": "minor",
        "file": ".metaproject/flows/318-2026-09-25-wave-4-batch-2-stack-packs-for-nestjs-ne/journal.md",
        "line": null,
        "problem": "The AC6 record is incomplete: the journal lacks the final gate outcome and the nestjs demotion.",
        "impact": "The journal's own AC6 evidence trail is incomplete at this point in the flow.",
        "suggested_fix": "Record the final gate outcome and nestjs demotion in the journal.",
        "evidence": "Direct read of the journal at this head.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN6",
        "severity": "minor",
        "file": "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md",
        "line": 1074,
        "problem": "W1:1074 still says mobx 'ships mobx-code-auditor/mobx-build-fixer' and, unlike the nestjs line, isn't marked superseded.",
        "impact": "Stale documentation claim.",
        "suggested_fix": "Correct the mobx line to match the 'superseded' pattern used for nestjs.",
        "evidence": "Direct read of W1-stack-catalog.md:1074.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN7",
        "severity": "minor",
        "file": ".metaproject/flows/318-2026-09-25-wave-4-batch-2-stack-packs-for-nestjs-ne/journal.md",
        "line": null,
        "problem": "The journal claims 'M4 ... vue widened to *.ts', but only the lint STACK_EXTENSIONS changed; all vue rule paths are still **/*.vue. The behaviour is documented in patterns.mdc, so the problem is only that the claim is inaccurate.",
        "impact": "Journal claim doesn't match the actual rule file state.",
        "suggested_fix": "Either widen vue's rule paths to include *.ts for real, or correct the journal claim.",
        "evidence": "Direct read of vue/rules/patterns.mdc paths frontmatter against the journal's M4 claim.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-MIN8",
        "severity": "minor",
        "file": "src/agents/generate.ts",
        "line": null,
        "problem": "angular-code-auditor.md says 'A Angular-focused' (article bug in the generator template). The nestjs-build-fix trigger '...naming these NestJS @Module()-decorated modules' still reads as unnatural.",
        "impact": "Cosmetic grammar bug in generated agent text; unnatural trigger phrasing.",
        "suggested_fix": "Add an indefinite-article helper to the generator; reword the nestjs-build-fix trigger naturally.",
        "evidence": "Direct read of the generated angular-code-auditor.md and nestjs-build-fix's SKILL.md trigger.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-INFO1",
        "severity": "info",
        "file": "src/gdskills/stack-pack-eval-integrity.test.ts",
        "line": null,
        "problem": "I11 uses Jaccard, which a tail of extra words defeats by construction; the test comment says that's deliberate. A containment check (share of a trigger's tokens present in the prompt) would catch the pattern in N-M1. That's a candidate for the batch-1 I11 follow-up flow.",
        "impact": "A known, documented limitation of the I11 metric, not a defect introduced by this PR.",
        "suggested_fix": "Consider a containment-based I11 variant in the batch-1 follow-up flow.",
        "evidence": "Reviewer read the I11 test's own comment and reproduced the containment-vs-Jaccard gap on N-M1's findings.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "N-INFO2",
        "severity": "info",
        "file": "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md",
        "line": null,
        "problem": "r1's other two info items are unchanged, as expected: the nextjs-nuxt regex graders add little signal, and freshness-queue.jsonl references pre-rebase SHAs.",
        "impact": "None; both are informational and were already left unchanged deliberately.",
        "suggested_fix": "No action needed.",
        "evidence": "Reviewer re-checked both r1 info items and confirmed nothing regressed.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r2"
      },
      {
        "id": "R1-B1",
        "severity": "blocker",
        "file": "src/gdskills/stack-packs.test.ts",
        "line": 430,
        "problem": "pack.extends! is passed to path.join, but this PR widened extends to string | readonly string[] (TS2345); typecheck-and-tests fails.",
        "impact": "CI typecheck-and-tests fails at stack-packs.test.ts:430 (TS2345); client matrix (runtime) also fails agents-catalog-commands.test.ts:190 and :464.",
        "suggested_fix": "Use extendsList(pack) at line 430. Update or re-home both CLI tests, but only after M1 is decided.",
        "evidence": "Locally: bun test on the 6 related files gives 2569 pass, 2 fail (the two above).",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/stack-packs.test.ts:430",
            "src/commands/agents-catalog-commands.test.ts:190",
            "src/commands/agents-catalog-commands.test.ts:464"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-B1"
      },
      {
        "id": "R1-M1",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/mobx/pack.json",
        "line": null,
        "problem": "The mobx agent pair reverses a W2 design decision, silently.",
        "impact": "agents-catalog-commands.test.ts:464 fails; mobx-code-auditor duplicates coverage with code-mobx-store-review.",
        "suggested_fix": "Either drop agentProfile from mobx/pack.json along with its two agent files and agent-refs entries, or record an owner decision and update W2.",
        "evidence": "W2-agent-catalog.md:396-399,496 unchanged; PR edits the 0.1.9 changelog to say mobx now ships a pair.",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/mobx/pack.json",
            "docs/requirements/keryx-agent-platform-expansion/workstreams/W2-agent-catalog.md:396-399,496"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-M1"
      },
      {
        "id": "R1-M2",
        "severity": "major",
        "file": "src/gdskills/bundled/agents/nestjs-code-auditor.md",
        "line": 15,
        "problem": "Three generated agents claim coverage no gate ever measured.",
        "impact": "Generated agent personas make false claims about gate coverage and reference nonexistent skills.",
        "suggested_fix": "Only generate a persona when its matching skill bucket is non-empty.",
        "evidence": "nestjs-code-auditor.md:15, mobx-code-auditor.md:15, mobx-build-fixer.md all show skills: [] with unchanged confirming language.",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/agents/nestjs-code-auditor.md:15,42",
            "src/gdskills/bundled/agents/mobx-code-auditor.md:15,42",
            "src/gdskills/bundled/agents/mobx-build-fixer.md"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-M2"
      },
      {
        "id": "R1-M3",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json",
        "line": null,
        "problem": "Positive trigger prompts copy the skills' own triggers: lists (author wrote both sides).",
        "impact": "A trigger-accuracy score built this way measures recall of the skill's own trigger list, not routing on real phrasing.",
        "suggested_fix": "Rewrite positives so none overlaps a frontmatter trigger at >=0.5, then re-run the gate.",
        "evidence": "Reviewer measured token overlap between each eval positive and its skill's frontmatter triggers list.",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/angular/skills/*/evals.json",
            "src/gdskills/bundled/stacks/vue/skills/*/evals.json",
            "src/gdskills/bundled/stacks/nestjs/skills/*/evals.json",
            "src/gdskills/bundled/stacks/nextjs-nuxt/skills/*/evals.json",
            "src/gdskills/bundled/stacks/mobx/skills/*/evals.json"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-M3"
      },
      {
        "id": "R1-M4",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/nextjs-nuxt/rules/security.mdc",
        "line": 3,
        "problem": "The nextjs-nuxt security rule never applies to the files it is about.",
        "impact": "The security rule is inert exactly where it matters.",
        "suggested_fix": "Add ts for nextjs-nuxt, or give security.mdc narrower .ts path globs.",
        "evidence": "security.mdc:3 paths scoped to tsx/jsx/vue only.",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/nextjs-nuxt/rules/security.mdc:3",
            "src/gdskills/governance/authoring-lint.ts STACK_EXTENSIONS['nextjs-nuxt']",
            "src/gdskills/bundled/stacks/vue/rules/patterns.mdc:12"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-M4"
      },
      {
        "id": "R1-M5",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json",
        "line": null,
        "problem": "Angular (stable) scenarios teach a wrong mechanism and grade valid answers as wrong.",
        "impact": "The anti-gaming calibration trained the judge to reject a correct answer.",
        "suggested_fix": "Reframe OnPush around @Input reference mutation. Replace both subtle_wrongs with answers that are actually wrong.",
        "evidence": "SKILL.md:49-52 and judge-recordings/angular__angular-implementation.json entry 10.",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/angular/skills/angular-code-review/SKILL.md:49-52",
            "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json",
            "src/gdskills/bundled/stacks/angular/skills/angular-implementation/evals.json",
            "src/gdskills/governance/judge-recordings/angular__angular-implementation.json entry 10"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-M5"
      },
      {
        "id": "R1-M6",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/SKILL.md",
        "line": 45,
        "problem": "nestjs-testing (stable) fails an approach the NestJS docs themselves show.",
        "impact": "The most idiomatic, docs-endorsed testing pattern is graded as wrong.",
        "suggested_fix": "Accept either form, drop the redundant override, and soften the new fail criterion.",
        "evidence": "SKILL.md:45-49,111 and the mock-dependency-boundary scenario's fail_criteria/known_right.",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/SKILL.md:45-49,111",
            "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/evals.json"
          ],
          "enumeration_method": "Carried forward from round 1 unchanged."
        },
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-M6"
      },
      {
        "id": "R1-MIN1",
        "severity": "minor",
        "file": "src/gdskills/bundled-eval.ts",
        "line": 228,
        "problem": "The Nuxt ~/ allowlist can be bypassed via .. traversal.",
        "impact": "A near-miss home-path detector that a crafted trial output can defeat.",
        "suggested_fix": "Reject any .. segment, limit the exemption, add tests.",
        "evidence": "Reviewer verified 0 offenders currently exist but confirmed the bypass shape.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN1"
      },
      {
        "id": "R1-MIN2",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/nestjs/skills/nestjs-build-fix/SKILL.md",
        "line": null,
        "problem": "The description rewrites lost clarity (inaccurate terminology).",
        "impact": "Trigger/description text is technically inaccurate.",
        "suggested_fix": "Restore the correct terms.",
        "evidence": "Direct read of both SKILL.md description/trigger strings.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN2"
      },
      {
        "id": "R1-MIN3",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/vue/agent-refs.json",
        "line": null,
        "problem": "The vue failure is described inaccurately (wrong attribution).",
        "impact": "The failure is real; only the attribution is wrong.",
        "suggested_fix": "Correct the attribution in agent-refs.json and W1.",
        "evidence": "Direct read of vue-build-fix's evals.json trigger-negative-1 against the note's claim.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN3"
      },
      {
        "id": "R1-MIN5",
        "severity": "minor",
        "file": "src/gdskills/bundled/install-manifest.json",
        "line": null,
        "problem": "Manifest profiles are inconsistent (missing lang:ts-js-node).",
        "impact": "Component-level detection and doctor reporting will differ.",
        "suggested_fix": "Add lang:ts-js-node to the vue/angular/nextjs-nuxt profiles.",
        "evidence": "Direct read of install-manifest.json profile entries.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN5"
      },
      {
        "id": "R1-MIN6",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/mobx/pack.json",
        "line": null,
        "problem": "Nested backticks in mobx/pack.json buildCommands[1] produce broken inline code.",
        "impact": "Generated agent markdown renders malformed inline code.",
        "suggested_fix": "Escape or restructure the nested backticks.",
        "evidence": "Direct read of the generated mobx-build-fixer.md.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN6"
      },
      {
        "id": "R1-MIN7",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-build-fix/evals.json",
        "line": null,
        "problem": "Wrong error class in an angular-build-fix scenario (NullInjectorError is runtime-only).",
        "impact": "The scenario's premise is technically inaccurate.",
        "suggested_fix": "Say ng build succeeds and the app throws at runtime/bootstrap.",
        "evidence": "Direct read of the scenario prompt.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN7"
      },
      {
        "id": "R1-MIN8",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/nextjs-nuxt/skills/nextjs-nuxt-build-fix/evals.json",
        "line": null,
        "problem": "A strawman calibration answer that admits its own flaw.",
        "impact": "Weakens the anti-gaming calibration for that scenario.",
        "suggested_fix": "Rewrite subtle_wrong to be genuinely plausible.",
        "evidence": "Direct read of the scenario's subtle_wrong text.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN8"
      },
      {
        "id": "R1-MIN9",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/evals.json",
        "line": null,
        "problem": "A positive that gives away the answer.",
        "impact": "Weakens the trigger-accuracy signal for that positive.",
        "suggested_fix": "Rewrite the positive to describe the symptom rather than name the fix.",
        "evidence": "Direct read of nestjs-testing positive 6.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-MIN9"
      },
      {
        "id": "R1-INFO2",
        "severity": "info",
        "file": "src/gdskills/bundled/install-manifest.json",
        "line": null,
        "problem": "Stable modules now depend on experimental ones.",
        "impact": "A dependency-stability inversion, worth documenting.",
        "suggested_fix": "Add a sentence to W1 noting the dependency.",
        "evidence": "Direct read of install-manifest.json module dependency graph.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "global_id": "2026-09-25-ingest-719-r02#R1-INFO2"
      }
    ],
    "stats": {
      "blocker": 1,
      "major": 1,
      "minor": 8,
      "info": 2
    }
  }
]
```
