# Adversarial review — round 1 (PR #719, flow 318)

**Recommendation: block.** Nothing here needs a redesign. But CI is red, the PR reverses a documented design decision without recording it, and the angular scorecard claim ("stable, no prompt fixes needed") doesn't hold up. The fixes are all local.

**Counts:** 1 blocker, 6 major, 9 minor, 3 info.

Full narrative report preserved verbatim at `scratchpad/f318/review-r1.md` (this session's scratchpad).

<!-- The machine-readable half of the same report. -->

```json keryx:findings
[
  {
    "status": "DONE_WITH_CONCERNS",
    "reviewer": "opus-adversarial-r1",
    "summary": "Recommendation: block. Nothing needs a redesign, but CI is red, the PR reverses a documented design decision without recording it, and the angular scorecard claim does not hold up. The fixes are all local.",
    "findings": [
      {
        "id": "R1-B1",
        "severity": "blocker",
        "file": "src/gdskills/stack-packs.test.ts",
        "line": 430,
        "problem": "pack.extends! is passed to path.join, but this PR widened extends to string | readonly string[] (TS2345); typecheck-and-tests fails.",
        "impact": "CI typecheck-and-tests fails at stack-packs.test.ts:430 (TS2345); client matrix (runtime) also fails agents-catalog-commands.test.ts:190 (still expects only 4 go/python agents) and :464 (expects agents generate --stack mobx to be refused).",
        "suggested_fix": "Use extendsList(pack) at line 430. Update or re-home both CLI tests, but only after M1 is decided.",
        "evidence": "Locally: bun test on the 6 related files gives 2569 pass, 2 fail (the two above).",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/stack-packs.test.ts:430",
            "src/commands/agents-catalog-commands.test.ts:190",
            "src/commands/agents-catalog-commands.test.ts:464"
          ],
          "enumeration_method": "Reviewer reproduced CI failures locally with bun test on the 6 related files."
        }
      },
      {
        "id": "R1-M1",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/mobx/pack.json",
        "line": null,
        "problem": "The mobx agent pair reverses a W2 design decision, silently: W2-agent-catalog.md:396-399 and :496 say mobx gets no generated pair (review coverage is code-mobx-store-review), but this PR gives mobx an agentProfile and generated pair without recording or justifying the reversal.",
        "impact": "agents-catalog-commands.test.ts:464 fails (that decision, enforced as a test); mobx-code-auditor duplicates coverage with code-mobx-store-review, which the manifest wiring claims to avoid.",
        "suggested_fix": "Either drop agentProfile from mobx/pack.json along with its two agent files and agent-refs entries, or record an owner decision and update W2 Initial catalogue and the Generated-agent sprawl risk line.",
        "evidence": "W2-agent-catalog.md:396-399,496 unchanged; PR edits the same document's 0.1.9 changelog to say mobx now ships a pair.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/mobx/pack.json",
            "docs/requirements/keryx-agent-platform-expansion/workstreams/W2-agent-catalog.md:396-399,496"
          ],
          "enumeration_method": "Reviewer read W2's design-decision passages and diffed them against this PR's mobx pack.json/agent-refs.json."
        }
      },
      {
        "id": "R1-M2",
        "severity": "major",
        "file": "src/gdskills/bundled/agents/nestjs-code-auditor.md",
        "line": 15,
        "problem": "Three generated agents (nestjs-code-auditor, mobx-code-auditor, mobx-build-fixer) claim coverage no gate ever measured: each has skills: [] because those packs ship review: []/build-fix: [], yet each auditor's description still says it checks 'the 6 stack-specific risk patterns this pack's governance gate has confirmed', and line 42 tells the agent to consult a review skill that doesn't exist.",
        "impact": "Generated agent personas make false claims about gate coverage and reference nonexistent skills.",
        "suggested_fix": "Only generate a persona when its matching skill bucket is non-empty. Or point the generator at the real cross-referenced skill (review-backend, code-mobx-store-review) and drop the 'gate has confirmed' wording for those packs.",
        "evidence": "nestjs-code-auditor.md:15, mobx-code-auditor.md:15, mobx-build-fixer.md all show skills: [] with unchanged confirming language; line 42 of both auditors references a nonexistent review skill.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/agents/nestjs-code-auditor.md:15,42",
            "src/gdskills/bundled/agents/mobx-code-auditor.md:15,42",
            "src/gdskills/bundled/agents/mobx-build-fixer.md"
          ],
          "enumeration_method": "Reviewer read every generated agent file in this PR and checked its skills bucket and description claims."
        }
      },
      {
        "id": "R1-M3",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json",
        "line": null,
        "problem": "Positive trigger prompts copy the skills' own triggers: lists (author wrote both sides). Token-overlap measurement (>=0.5 counts as a near-copy): angular 15/25 (angular-code-review 5/6, one verbatim), vue 19/30 (one verbatim), nestjs 10/19, nextjs-nuxt 19/36 (2 verbatim), mobx 0/15 (the only clean pack); batch-1 baseline 26/110 (~24%). The 'angular needed no fix' claim does not hold.",
        "impact": "A trigger-accuracy score built this way measures recall of the skill's own trigger list, not routing on real phrasing — angular is being promoted to stable on prompts an honest router would not see.",
        "suggested_fix": "Rewrite positives so none overlaps a frontmatter trigger at >=0.5 (start with angular, since it is being promoted), then re-run the gate. Consider adding an integrity check (an I-rule) with that threshold.",
        "evidence": "Reviewer measured token overlap between each eval positive and its skill's frontmatter triggers list across all 5 batch-2 packs plus the batch-1 baseline.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/angular/skills/*/evals.json",
            "src/gdskills/bundled/stacks/vue/skills/*/evals.json",
            "src/gdskills/bundled/stacks/nestjs/skills/*/evals.json",
            "src/gdskills/bundled/stacks/nextjs-nuxt/skills/*/evals.json",
            "src/gdskills/bundled/stacks/mobx/skills/*/evals.json"
          ],
          "enumeration_method": "Reviewer measured Jaccard-style token overlap between every positive trigger prompt and its own skill's frontmatter triggers list, across all 5 batch-2 packs plus the batch-1 baseline."
        }
      },
      {
        "id": "R1-M4",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/nextjs-nuxt/rules/security.mdc",
        "line": 3,
        "problem": "The nextjs-nuxt security rule never applies to the files it is about: all four nextjs-nuxt/rules/*.mdc files are scoped to **/*.tsx, **/*.jsx, **/*.vue, and STACK_EXTENSIONS['nextjs-nuxt'] locks that in, but security.mdc is about Server Actions (actions.ts), route.ts handlers, middleware.ts, Nuxt server/api/**/*.ts and nuxt.config.ts runtimeConfig — all .ts files.",
        "impact": "The security rule is inert exactly where it matters; vue/rules/patterns.mdc's Pinia/composable guidance is milder-form same issue (only fires on .vue).",
        "suggested_fix": "Add ts for nextjs-nuxt, or give security.mdc narrower .ts path globs for server/**, app/**/route.ts, **/actions.ts and middleware.ts.",
        "evidence": "security.mdc:3 paths scoped to tsx/jsx/vue only; the rule's own content is about .ts-only surfaces.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/nextjs-nuxt/rules/security.mdc:3",
            "src/gdskills/governance/authoring-lint.ts STACK_EXTENSIONS['nextjs-nuxt']",
            "src/gdskills/bundled/stacks/vue/rules/patterns.mdc:12"
          ],
          "enumeration_method": "Reviewer read every nextjs-nuxt and vue rule file's paths frontmatter against the file types its own prose describes."
        }
      },
      {
        "id": "R1-M5",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json",
        "line": null,
        "problem": "Angular (stable) scenarios teach a wrong mechanism and grade valid answers as wrong. OnPush scenario (flag-onpush-inplace-mutation, SKILL.md:49-52) claims an in-place push 'won't trigger a re-check under OnPush', but items is an internal field, not an @Input, so this is wrong; its subtle_wrong (push then markForCheck()) is functionally correct Angular. The inject scenario (inject-inside-injection-context-only) rubric explicitly lists runInInjectionContext as valid, yet subtle_wrong uses exactly that and is labelled wrong; the recorded judge calibration (judge-recordings/angular__angular-implementation.json entry 10) failed it as 'fail criterion 1'.",
        "impact": "The anti-gaming calibration trained the judge to reject a correct answer; the 'zero mismatches on first run' result partly reflects that.",
        "suggested_fix": "Reframe OnPush around @Input reference mutation, or say explicitly the mutation happens outside the component's own event path. Replace both subtle_wrongs with answers that are actually wrong. Re-record calibration and the gate for angular.",
        "evidence": "SKILL.md:49-52 and judge-recordings/angular__angular-implementation.json entry 10, read directly by the reviewer.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/angular/skills/angular-code-review/SKILL.md:49-52",
            "src/gdskills/bundled/stacks/angular/skills/angular-code-review/evals.json (flag-onpush-inplace-mutation)",
            "src/gdskills/bundled/stacks/angular/skills/angular-implementation/evals.json (inject-inside-injection-context-only)",
            "src/gdskills/governance/judge-recordings/angular__angular-implementation.json entry 10"
          ],
          "enumeration_method": "Reviewer read both flagged scenarios' SKILL.md content, rubric, calibration, and the recorded judge transcript."
        }
      },
      {
        "id": "R1-M6",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/SKILL.md",
        "line": 45,
        "problem": "nestjs-testing (stable) fails an approach the NestJS docs themselves show: scenario mock-dependency-boundary's fail criterion says 'Recommends constructing UsersService directly with new UsersService(fakeRepo)', but the NestJS docs show that for isolated unit tests; SKILL.md:111 hardens it into a rationalization table. SKILL.md:45-49 and known_right both provide the mock twice ({provide, useValue} entry and .overrideProvider), which is redundant and teaches cargo-cult code; pass criteria demand overrideProvider, so the most idiomatic answer risks failing.",
        "impact": "The most idiomatic, docs-endorsed testing pattern is graded as wrong.",
        "suggested_fix": "Accept either form, drop the redundant override from SKILL and known_right, and soften the new fail criterion to 'only when the DI wiring itself is under test'.",
        "evidence": "SKILL.md:45-49,111 and the mock-dependency-boundary scenario's fail_criteria/known_right, read directly.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/SKILL.md:45-49,111",
            "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/evals.json (mock-dependency-boundary)"
          ],
          "enumeration_method": "Reviewer read the scenario's fail_criteria/known_right against the SKILL.md guidance and the NestJS docs' own pattern."
        }
      },
      {
        "id": "R1-MIN1",
        "severity": "minor",
        "file": "src/gdskills/bundled-eval.ts",
        "line": 228,
        "problem": "The Nuxt ~/ allowlist can be bypassed: ~/anything-else is flagged, but startsWith('~/pages/') runs on a TILDE_PATH match allowing '.' and '/', so ~/pages/../.ssh/id_rsa and ~/app/../.aws/credentials pass; ~/server/, ~/public/, ~/utils/ are also plausible real home subdirectories and the exemption applies repo-wide; no test was added.",
        "impact": "A near-miss home-path detector that a crafted trial output can defeat via .. traversal.",
        "suggested_fix": "Reject any .. segment, limit the exemption to the nextjs-nuxt/vue pack paths or to recorded trial output, trim the list, and add positive and negative tests.",
        "evidence": "Reviewer verified 0 offenders currently exist but confirmed the bypass shape.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN2",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/nestjs/skills/nestjs-build-fix/SKILL.md",
        "line": null,
        "problem": "The description rewrites (checklist item 3) lost clarity: nestjs-build-fix's 'two @Module()-decorated NestJS modules or providers' is wrong (providers aren't @Module-decorated); angular-code-review's 'a DI call made outside Angular's own injector' changed the meaning (the concept is an injection context/NG0203, not 'Angular's injector').",
        "impact": "Trigger/description text is technically inaccurate, written for the scorer rather than for correctness.",
        "suggested_fix": "Restore the correct terms: 'inject() called outside an injection context', 'a circular import between two NestJS modules or providers'.",
        "evidence": "Direct read of both SKILL.md description/trigger strings.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN3",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/vue/agent-refs.json",
        "line": null,
        "problem": "The vue failure is described inaccurately: vue/agent-refs.json note and W1 say vue-build-fix's FP=1 is a same-pack near-miss collision with vue-implementation, but the failing negative is actually trigger-negative-1, 'fix this tsc error in a plain typescript service file', a cross-pack ts-js-node prompt.",
        "impact": "The failure is real; only the attribution is wrong, which could misdirect a future fix.",
        "suggested_fix": "Correct the attribution in agent-refs.json and W1 to name the actual cross-pack collision.",
        "evidence": "Direct read of vue-build-fix's evals.json trigger-negative-1 against the note's claim.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN4",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-testing/evals.json",
        "line": null,
        "problem": "Some prompts are phrased oddly, apparently to dodge the scorer: angular-testing negative avoids 'e2e test' phrasing; vue2-to-vue3 vmodel-single-to-multiple-bindings prompt never says 'Vue'; mobx-observable-testing negatives carry jargon removed from positives plus a typo ('stores constructor').",
        "impact": "Prompts read as written for the scorer rather than as realistic user requests.",
        "suggested_fix": "Rewrite toward natural phrasing without scorer-dodging.",
        "evidence": "Direct read of the three flagged prompts.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN5",
        "severity": "minor",
        "file": "src/gdskills/bundled/install-manifest.json",
        "line": null,
        "problem": "Manifest profiles are inconsistent: the vue, angular and nextjs-nuxt profiles omit the lang:ts-js-node component, while the existing nestjs and react profiles list it.",
        "impact": "Module dependencies pull it in transitively, but component-level detection and doctor reporting will differ.",
        "suggested_fix": "Add lang:ts-js-node to the vue/angular/nextjs-nuxt profiles for consistency.",
        "evidence": "Direct read of install-manifest.json profile entries.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN6",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/mobx/pack.json",
        "line": null,
        "problem": "Nested backticks in mobx/pack.json buildCommands[1] produce broken inline code in the generated mobx-build-fixer.md step 1.2.",
        "impact": "Generated agent markdown renders malformed inline code.",
        "suggested_fix": "Escape or restructure the nested backticks in buildCommands[1].",
        "evidence": "Direct read of the generated mobx-build-fixer.md.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN7",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/angular/skills/angular-build-fix/evals.json",
        "line": null,
        "problem": "Wrong error class in an angular-build-fix scenario: fix-missing-provider-not-new says 'ng build ... fails with NullInjectorError', but that is a runtime-only error.",
        "impact": "The scenario's premise is technically inaccurate.",
        "suggested_fix": "Say ng build succeeds and the app throws NullInjectorError at runtime/bootstrap.",
        "evidence": "Direct read of the scenario prompt.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN8",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/nextjs-nuxt/skills/nextjs-nuxt-build-fix/evals.json",
        "line": null,
        "problem": "A strawman calibration answer: nextjs-nuxt-build-fix no-suppress-hydration-warning subtle_wrong admits its own flaw ('it can still differ...'), so it isn't plausible-but-wrong.",
        "impact": "Weakens the anti-gaming calibration for that scenario.",
        "suggested_fix": "Rewrite subtle_wrong to be genuinely plausible.",
        "evidence": "Direct read of the scenario's subtle_wrong text.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-MIN9",
        "severity": "minor",
        "file": "src/gdskills/bundled/stacks/nestjs/skills/nestjs-testing/evals.json",
        "line": null,
        "problem": "A positive that gives away the answer: nestjs-testing positive 6 already names the answer ('never calls app.close()').",
        "impact": "Weakens the trigger-accuracy signal for that positive.",
        "suggested_fix": "Rewrite the positive to describe the symptom rather than name the fix.",
        "evidence": "Direct read of nestjs-testing positive 6.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-INFO1",
        "severity": "info",
        "file": "src/gdskills/bundled/stacks/nextjs-nuxt/skills/nextjs-nuxt-build-fix/evals.json",
        "line": null,
        "problem": "The nextjs-nuxt regex graders (auth, setup, defineStore, 'use client', getServerSideProps) are matched by nearly any answer, including wrong ones, so they add no signal. The judge carries those scenarios.",
        "impact": "No signal loss in practice since the judge is authoritative, but the regex graders are dead weight.",
        "suggested_fix": "Consider removing or replacing the regex graders in a follow-up.",
        "evidence": "Reviewer tested the regex graders against wrong answers.",
        "confidence": "medium",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-INFO2",
        "severity": "info",
        "file": "src/gdskills/bundled/install-manifest.json",
        "line": null,
        "problem": "Stable modules now depend on experimental ones: nestjs-skills/angular-skills -> ts-js-node-skills, mobx-skills -> react-skills. Nothing enforces against it.",
        "impact": "A dependency-stability inversion, worth documenting.",
        "suggested_fix": "Add a sentence to W1 noting the dependency.",
        "evidence": "Direct read of install-manifest.json module dependency graph.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      },
      {
        "id": "R1-INFO3",
        "severity": "info",
        "file": ".metaproject/data/gdgraph/freshness-queue.jsonl",
        "line": null,
        "problem": "The freshness-queue.jsonl additions reference pre-rebase SHAs. That's harmless hook output.",
        "impact": "None; explicitly harmless.",
        "suggested_fix": "No action needed.",
        "evidence": "Direct read of freshness-queue.jsonl.",
        "confidence": "high",
        "reviewer": "opus-adversarial-r1"
      }
    ],
    "stats": {
      "blocker": 1,
      "major": 6,
      "minor": 9,
      "info": 3
    }
  }
]
```
