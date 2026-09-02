# Review — PR #431, round 3 (fix round)

Target: pull request MrCipherSmith/keryx#431
Head at review: e54718e97e0f2b3f0b1a2c9d4e5f6a7b8c9d0e1f (fix rounds 1 and 2)
Range reviewed: 868eae95..e54718e9 — the FIXES, not the original change
Reviewers: review-logic, review-security-code, review-testing-practices, review-regression

## Verdict: REQUEST_CHANGES

## Summary

Rounds 1 and 2 produced fixes; this round reviewed those fixes. The recorded
project lesson is blunt about why — "a fix round needs its own review: three
consecutive rounds each introduced a blocker" — and it held.

Thirteen majors, all on the fixes. The guard fixes are real where they were
mechanical, and the routing fixes are net-negative: word-boundary padding
removed the false positives and the TRUE positives together, and asymmetric
trigger tokenisation took the count of triggers without an order-free path from
11 to 17.

One root cause sits under every routing finding, and it is a method failure
rather than a coding one: the corpus had NO NEGATIVE PAIRS. Every round could
see improvements and none could see losses, so each optimised what was
observable and broke what was not.

The consequence: the routing work was REMOVED from the PR rather than patched a
third time, and flow 217 is blocked with the restart condition recorded — the
corpus with negative pairs and inflected forms comes before the scorer.

## Review Scope

- mode: diff (fix round)
- files 17, changed lines 1056, blocks 114, dropped 0
- prior findings carried into the dispatch with their claimed dispositions

## Stats

blockers 0, majors 14, minors 3, info 2

## Stage counts

- dropped by pre-filter: 0
- refuted by the verifier: 0. No separate Wave C: every major was reproduced by
  the orchestrator directly against the pre-fix build.
- retained: 19

## Mutation pass

20 mutations over the new gates, 9 survivors, all restored and hash-verified
against HEAD. Red on revert: readAllBounded, triggerTokensOf, the query floor,
all four runtimes/install gates, splitPipeline quote handling. Seven of the nine
survivors are gates this round introduced.

## Checked and cleared

- Install and uninstall across every historical build: uninstall keys on the
  managed sentinel and removes all of them; install upgrades and announces
  (claude Bash -> Bash|Grep, codex Bash|Grep -> Bash). Nothing orphaned.
- No untouched caller depends on the removed PRE_TOOL_USE_MATCHER constant, the
  sync routePrompt, or the old scoreBundledSkillRoute signature.
- No catalog gate asserts trigger contents or counts.
- A missing or malformed project-skill manifest cannot break a turn.
- The refusal text still cannot carry attacker-controlled content into context.

```json keryx:findings
[
  {
    "id": "F-101",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/ctx/hook-classify.ts",
    "line": 179,
    "problem": "readsStdin lets `grep -e PAT FILE` through: when the pattern arrives via a value flag the pattern operand is never spent, so operandsAllowed absorbs the first PATH instead. Attached spellings (-efoo, --regexp=foo) are missed by the value-flag set entirely.",
    "impact": "A full file read past the guard, recorded as ctx_used-compliant — the exact false-clean the change exists to close. Regression: `grep -e foo file.ts` BLOCKED at 868eae95 and passes after the fix.",
    "suggested_fix": "Zero the operand allowance when a pattern-supplying flag is seen, and normalise --flag=value / -fvalue before the loop.",
    "evidence": "classifyCommand and end-to-end through the hook: allow `grep -e foo file.ts`, `grep -efoo file.ts`, `grep --regexp=foo file.ts`, `grep -f pats.txt src/app.ts`. At 868eae95 the first was BLOCK.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/hook-classify.ts readsStdin operand budget"
      ],
      "enumeration_method": "Every VALUE_FLAGS.search entry that also SUPPLIES the pattern (-e, --regexp, -f, --file), plus the --flag=value and -fvalue spelling of every value flag in the table."
    }
  },
  {
    "id": "F-102",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/ctx/hook-classify.ts",
    "line": 187,
    "problem": "The recursive check /^-[a-zA-Z]*[rR]/ cannot match a long option: after ^- the next character is -, which [a-zA-Z]* cannot consume.",
    "impact": "`grep --recursive foo` and `grep --dereference-recursive foo` walk the tree unguarded, including after a statement split (`cd src && grep --recursive foo`).",
    "suggested_fix": "Test the long forms explicitly, sharing one predicate with the ls branch which already handles --recursive.",
    "evidence": "allow `true | grep --recursive foo`; the short form blocks. The same short-only pattern is duplicated for ls where --recursive IS handled, so the two copies already disagree.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/hook-classify.ts readsStdin recursive test",
        "src/ctx/hook-classify.ts ls -R branch"
      ],
      "enumeration_method": "Both copies of the short-only recursive pattern in the file; the ls branch already handles --recursive explicitly, so the two disagree. Long forms enumerated from grep's documented options: --recursive, --dereference-recursive."
    }
  },
  {
    "id": "F-103",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/ctx/hook-classify.ts",
    "line": 179,
    "problem": "operandsAllowed is 1 only for search-like commands. sed and awk take a SCRIPT as their first operand exactly as grep takes a pattern, so a downstream filter's script is misread as a path.",
    "impact": "This is the false-positive class that made the guard unusable and motivated the change in the first place. The fix moved it one command over: `bun test | sed -n '1,5p'` and `bun test | awk '{print $1}'` are refused.",
    "suggested_fix": "Give sed/awk an operand allowance when no -e/-f supplied the script.",
    "evidence": "BLOCK on `bun test | sed -n '1,5p'`, `bun test | awk '{print $1}'`, `true | sed 's/a/b/'`, `true | awk -F, '{print $2}'`. End-to-end hook exit 2.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/hook-classify.ts readsStdin operand budget, for sed",
        "same, for awk"
      ],
      "enumeration_method": "Every routed command whose FIRST operand is a script or expression rather than a path. Walked the ROUTES table and the per-command branches: sed and awk are the two today."
    }
  },
  {
    "id": "F-104",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/ctx/hook.ts",
    "line": 22,
    "problem": "ctx hook's own stdin read is still unbounded. The round-1 fix bounded orient's read and argued 'a hook that never exits hangs the harness just as surely as one that never writes'; hook.ts was edited in the same commit range and its read was left.",
    "impact": "ctx hook is a PreToolUse gate. A stdin that is not promptly closed wedges the tool call rather than failing open — the opposite of the module's stated fail-open contract.",
    "suggested_fix": "Reuse readAllBounded (lifted into a shared module), treating expiry as the fail-open no-payload case.",
    "evidence": "Same fifo harness: orient claude exits in 1202ms; ctx hook claude still running at 14s, a first attempt ran past 120s. Control with closed stdin: 665ms.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/orient.ts readPromptFromStdin (bounded by the fix)",
        "src/ctx/hook.ts readStdin (left unbounded)"
      ],
      "enumeration_method": "Grepped the diff scope for stdin reads; two sites of the same shape, only one bounded."
    }
  },
  {
    "id": "F-105",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/skills.ts",
    "line": 640,
    "problem": "Round 1 removed `review` from the провер synonym family and left it in the longer sibling stem проверк, so a single non-technical Russian word again produces a confident single-arrow route.",
    "impact": "`проверка почты` (check the mail) routes to review-orchestrator at 65 and the orient hook injects it into the turn. The named instance (проверь почту) is fixed; the class is not.",
    "suggested_fix": "Drop review from проверк too; add the negative assertion to route-synonyms.test.ts and negative pairs to the corpus.",
    "evidence": "Real hook output for 'проверка почты' names review-orchestrator (65) with reason trigger. Also проверка баланса, нужна проверка документов.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "провер / проверк",
        "ревью / ревьюер"
      ],
      "enumeration_method": "Every prefix family in RU_SYNONYM_PREFIXES with a longer sibling entry."
    }
  },
  {
    "id": "F-106",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/skills.ts",
    "line": 541,
    "problem": "The word-boundary padding was applied to the trigger test and the skill-NAME test 25 lines below was left a bare substring match, as were three more in scoreProjectSkillRoute.",
    "impact": "The finding's own reproduction case still gives a wrong recommendation from the CLI: `skills route 'commitment issues'` names commit, `'preview the deck'` names pr. Below ROUTING_FLOOR so the hook is unaffected.",
    "suggested_fix": "One containsWord(haystack, needle) helper used by all four sites.",
    "evidence": "skills route output for both strings, with reason 'skill name'.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/skills.ts scoreBundledSkillRoute skill-name includes",
        "scoreProjectSkillRoute fields.name",
        "scoreProjectSkillRoute fields.module",
        "scoreProjectSkillRoute fields.targetBase"
      ],
      "enumeration_method": "Grepped both scorers for unpadded .includes() against a name/module/basename; four sites, one padded by the fix and three not."
    }
  },
  {
    "id": "F-107",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/skills.ts",
    "line": 405,
    "problem": "The fix removed the short-token filter from the TRIGGER side only, so triggerTokens.every(t => queryTokens.has(t)) fails permanently for any trigger containing a stopword or one-character word.",
    "impact": "Net regression measured over the whole catalog: 15 triggers lost the order-free path, 9 gained; round 1 complained about 11 and the count is now 17. It produces a WRONG route, not just silence: 'learn lessons from this review' names review-orchestrator while entity-skill-learner scores 30, below the floor.",
    "suggested_fix": "Apply the same stopword/length filter to triggerTokensOf that the query gets, and keep the source-word rule as the degeneration guard.",
    "evidence": "Reimplemented the base scorer and diffed reachability over all 78 catalog entries: lost=15 gained=9, with the lost list including 'create a reviewer', 'learn from review', 'issue to flow', 'does this change break anything'.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "all 17 multi-word triggers containing a stopword or one-character word"
      ],
      "enumeration_method": "Programmatic reachability diff of every BUNDLED_GDSKILLS trigger between the base scorer and HEAD."
    }
  },
  {
    "id": "F-108",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/ctx/orient-routing.ts",
    "line": 31,
    "problem": "routePrompt filters match.reasons.includes('trigger'), and scoreProjectSkillRoute has no trigger concept at all, so no project skill can ever pass the filter. Separately, one malformed registry entry disables the whole routing block silently.",
    "impact": "The manifest read added to every prompt buys nothing: an exact-name project skill scoring 320 is dropped while two catalog skills are named. And a registry entry missing target throws, so every prompt in that project loses routing with no diagnostic.",
    "suggested_fix": "Give project skills a trigger source or relax the filter for source === 'project'; otherwise remove the manifest read from the per-prompt path. Validate registry entries at load.",
    "evidence": "Synthetic manifest with one entry: project entry scores 320 and routePrompt returns the catalog pair instead. Entry without target -> routing block absent.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/orient-routing.ts routePrompt trigger filter",
        "src/commands/skills.ts scoreProjectSkillRoute reason vocabulary",
        "src/commands/skills.ts rankSkillsForQuery project branch"
      ],
      "enumeration_method": "Enumerated scoreProjectSkillRoute's complete reason vocabulary (exact skill, target, path, target basename, module, skill name, tokens:) and confirmed none is 'trigger'; then every field read on an untrusted registry entry (target, path, module, name)."
    }
  },
  {
    "id": "F-109",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/ctx/runtimes.ts",
    "line": 518,
    "problem": "The type === 'command' ownership test was added to managedGroupsFor, but ANTIGRAVITY_RUNTIME.validate is a separate hand-rolled walker that still matches on command alone. The managedGroupsFor comment predicts this literally, and the fourth shape was already in the file.",
    "impact": "antigravity validate returns [] for an inert type:'prompt' entry and for an absent matcher. Separately the flat ownership branch is applied to every runtime, so a flat entry validates clean for claude, which only executes nested groups.",
    "suggested_fix": "Route antigravity's validate through managedGroupsFor; make the flat-vs-nested ownership test per-runtime.",
    "evidence": "antigravity validate(inert type prompt) = [], validate(no matcher) = []; claude validate(flat command) = [].",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/runtimes.ts ANTIGRAVITY_RUNTIME.validate",
        "src/ctx/runtimes.ts managedGroupsFor flat branch as applied to nested-shape runtimes"
      ],
      "enumeration_method": "Every validate in the file that is NOT routed through managedGroupsFor (antigravity is the only one today), plus the flat ownership branch, which is applied to every runtime rather than per-runtime."
    }
  },
  {
    "id": "F-201",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/skills.ts",
    "line": 455,
    "problem": "The word-boundary padding added this round is untested; removing it leaves all 99 routing tests green while restoring the exact misroutes its own comment names.",
    "impact": "This round ADDED the one-word triggers that made substring matching dangerous. The guard and the hazard shipped together and only the hazard is pinned.",
    "suggested_fix": "Add a negative corpus asserting routePrompt returns [] for the strings the comment names.",
    "evidence": "MUTATION (survived): bare includes -> 0 fail. Behaviour delta: 'commitment issues' gains commit:85, 'preview the deck' gains review-orchestrator:55. Neither string appears anywhere in the suite.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "every guard added this round whose only record is a prose comment naming a regression string absent from the assertions"
      ],
      "enumeration_method": "Mutated each new guard and grepped the suite for the strings its comment names."
    }
  },
  {
    "id": "F-202",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/route-synonyms.test.ts",
    "line": 78,
    "problem": "The synonym test asserts presence only and never absence (except one hand-written case), so over-expansion — the defect class that caused the reported incident — passes silently.",
    "impact": "The incident was провер -> check+verify+REVIEW: one prefix expanding to a token it should not. The suite pins deletions and remappings and cannot see the additive defect.",
    "suggested_fix": "Make each row a closed contract: assert the full expansion set, or add forbidden-token columns for the routing-hot English tokens.",
    "evidence": "MUTATION (survived): ['найд', ['find','review']] -> 0 fail, and 'найди файл' gains review-orchestrator:65. Deletion (M19) and remapping (M18) are both RED.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/route-synonyms.test.ts all 51 EXPANSIONS rows"
      ],
      "enumeration_method": "Every row is a presence loop over a hand-written expectation list; only one row (провер) asserts absence. Confirmed by mutating one family additively and watching the suite stay green."
    }
  },
  {
    "id": "F-203",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/orient-stdin.test.ts",
    "line": 100,
    "problem": "The test named 'inside the envelope' cannot observe the envelope: every test in the file spawns orient claude, whose format is plainStdout (identity), so no assertion there can distinguish the two orderings.",
    "impact": "Reverting the fix leaves the suite green. This is the second round in which this specific claim has been made — the round-2 fix replaced a test that did not check its property with another that cannot.",
    "suggested_fix": "Assert the composition in-process against the cursor runtime, whose format is non-identity: JSON.parse the result and assert additional_context contains both the orientation and the routing block.",
    "evidence": "MUTATION (survived): folding routing AFTER runtime.format -> orient-stdin 7 pass / 0 fail.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/orient-stdin.test.ts, all 7 tests"
      ],
      "enumeration_method": "Every test in the file spawns `orient claude`, whose format is plainStdout (identity). Enumerated ORIENT_RUNTIMES: claude and codex use plainStdout, cursor uses cursorAdditionalContext — so no test in the file exercises a non-identity envelope, and cursor/windsurf/antigravity formatting is unasserted."
    }
  },
  {
    "id": "F-204",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/ctx/hook-classify.ts",
    "line": 137,
    "problem": "Two guards added this round are unpinned: emptying the per-command VALUE_FLAGS, and dropping the isFirst half of the rg branch, both leave the suite green while over-blocking.",
    "impact": "The file header says a false block is the failure mode that gets a hook uninstalled. `bun test | head -n 20` is the canonical form of the command the ALLOWED list protects and it flips to block under the mutation; the list exercises no value flag and contains no downstream rg.",
    "suggested_fix": "Extend ALLOWED with the value-flag forms and a downstream rg; add tail -f app.log as a BLOCKED row for the per-command asymmetry.",
    "evidence": "MUTATION (survived): VALUE_FLAGS emptied -> green, with four commands flipping pass->block. rg isFirst dropped -> green, two commands flipping.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/hook-classify.ts VALUE_FLAGS (all five per-command sets)",
        "src/ctx/hook-classify.ts rg isFirst branch"
      ],
      "enumeration_method": "Mutated each guard and diffed the verdict for every string in hook-pipeline.test.ts's ALLOWED list plus the value-flag forms it omits; the whole readsStdin operand model is unpinned in the over-block direction, including sed/awk value flags, grep -e PATTERN FILE and head -c."
    }
  },
  {
    "id": "F-205",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/ctx/orient-routing.ts",
    "line": 30,
    "problem": "Three guards added this round are untested and two are currently unreachable: the source-word rule, the requireTrigger filter, and the project-skill merge.",
    "impact": "With no test they are indistinguishable from dead code and the next simplifier deletes them and sees green. The source-word rule has no live input because the same round also removed review from the провер synonyms.",
    "suggested_fix": "Unit-test each directly with synthesised inputs rather than through a corpus round trip.",
    "evidence": "MUTATIONS (all survived): drop sources.size, drop requireTrigger, drop project skills from the merge. The first two produce zero behaviour delta over a 55-query probe.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-206",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/orient.ts",
    "line": 120,
    "problem": "The isTTY fail-safe that round 2 claimed to cover is still untested and now arguably redundant, since the 250ms deadline covers the same hazard.",
    "impact": "If the deadline is ever lengthened, the untested isTTY branch is the only thing between a TTY invocation and a visible stall.",
    "suggested_fix": "Extract shouldReadStdin(isTty) and assert both branches, or delete the branch and record that the deadline subsumes it.",
    "evidence": "MUTATION (survived): isTTY guard deleted -> orient-stdin 7 pass / 0 fail. Every test in the file pipes or ignores stdin.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-207",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/gdskills/catalog.ts",
    "line": 153,
    "problem": "Two of the three trigger additions fit the test rather than fix the router: 'проверь безопасность' and 'узкие места' are each a verbatim substring of the one corpus query they unblock, bypassing the expansion mechanism the corpus is meant to prove. 'migrate database' corresponds to no corpus pair at all.",
    "impact": "route-synonyms.test.ts's own header names this hazard — the literal 'полное ревью' trigger masked the полн prefix — and the round reintroduced that masking for two more pairs.",
    "suggested_fix": "Keep the literals as routing data but add a second query per intent that the literal does not cover, so the pair proves the mechanism rather than the lookup.",
    "evidence": "Verbatim-substring check per pair: проверь безопасность and узкие места match verbatim; 'open pull request' fires through synonym expansion across three distinct source words (открой->open, пулл->pull, реквест->request).",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-301",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/ctx/hook-classify.ts",
    "line": 66,
    "problem": "The docblock claims 'Position was never the right discriminator. Whether the stage NAMES A FILE is.' Only half true: the block decision still requires tokens[0] to be a member of a fixed name list, so sh -c, $(...), backticks, eval and xargs pass unclassified.",
    "impact": "A run that floods context is recorded as compliant. Not a regression — every form was equally unblocked before — but a comment that overstates a fix is how the next reviewer stops looking.",
    "suggested_fix": "Do not chase the parser. Correct the docblock, and treat sh/bash/eval -c and xargs as explicitly unclassifiable so the routing audit can say so.",
    "evidence": "allow: `echo $(grep -rn foo src/)`, `sh -c 'grep -rn foo src/'`, `echo src | xargs grep -rn foo`, `eval 'grep -rn foo src/'`. Confirmed to execute for real.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-302",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/ctx/hook-classify.ts",
    "line": 1,
    "problem": "The escape marker is matched against the raw command string with no quote awareness, so a command that merely contains '# keryx:raw' in a quoted argument opts itself out.",
    "impact": "Mostly self-inflicted: searching the guard's own source, tests or docs for the marker silently disables the guard for that command.",
    "suggested_fix": "Apply the same quote awareness splitPipeline received.",
    "evidence": "allow: `grep -rn '#keryx:raw' src/`, `git log --grep='# keryx:raw'`.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-401",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/gdskills/catalog.ts",
    "line": 292,
    "problem": "The word-boundary padding matches only the standalone word and there is no stemming, so every one-word trigger in the untouched catalog stops matching the inflected forms operators type. The token fallback cannot recover it because expandTokens compares by exact equality.",
    "impact": "Silent wrong result on the surface the project's routing rule depends on. `run the deployment` deploy(95) -> silence; `reviewing the diff now` review-orchestrator(55) -> gone, top becomes context-router(10); `commits are failing`, `brainstorming ideas`, `interviewing me first` all -> silence.",
    "suggested_fix": "Keep the boundary test but compare on a stem: match a query word when it equals the trigger word or starts with it and the remainder is a known inflection, gated on a minimum stem length.",
    "evidence": "Differential execution of keryx orient and skills route between a worktree at 868eae95 and HEAD, same cwd and manifest: eight queries confirmed end-to-end.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "29 one-word triggers across 24 catalog entries, including deploy, commit, push, brainstorm, interviewer, review-orchestrator, review-performance, hookify, autodoc-orchestrator"
      ],
      "enumeration_method": "Programmatic over BUNDLED_GDSKILLS: every trigger with no space after normalizeRouteText, since that is the case where the substring test was the only path that could fire. Multi-word triggers lose the same way when their LAST word inflects, so 24 entries is the floor."
    }
  }
]
```
