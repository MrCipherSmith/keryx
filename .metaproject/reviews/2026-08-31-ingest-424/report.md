# Review Report — MrCipherSmith/keryx#424

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Three rounds over six commits. Four reviewers in round 1 (logic, architecture,
security, testing-practices), four in round 2, two in round 3 on the range the
earlier rounds could not have seen. Every finding below was raised by a reviewer
that verified by executing something — a mutation, a crafted validator payload, a
real invocation of the command under discussion — not by reading the diff.

The blocker is the one worth naming: the injection screen the branch added could
not screen anything, because the documented command passed the comment text where
the CLI takes a path. Three prose tests covered that screen and were green.

## Review Scope

- Target: pr 424, base `main`, head `2907d530`
- Merge-base: `e35fb7906a0255e2fb512ac5949e9ec176eebe2c`
- Scope: `merge-base..HEAD`, never the newest commit alone
- Files: 18 seen, 18 retained, 0 dropped
- Changed lines: 2465 retained, 5 dropped (whitespace-only)
- Rounds: 3. Reviewers: review-logic, review-architecture, review-security-code, review-testing-practices
- External PR comments collected: 0 over 3 rounds, at `2907d530`

## Stats

- blocker: 1
- major: 12
- minor: 18 (fixed in the same rounds; not itemised here)
- info: 8

## Prior findings and what became of them

| id | severity | reviewer | disposition | evidence |
|---|---|---|---|---|
| `R1-SEC-001` | major | review-security-code | acted-on | Rewritten per-comment in 9950cbe9; the invocation itself was then found broken and fixed in 00f01b71, with an  |
| `R1-SEC-002` | major | review-security-code | acted-on | Conditional added to both input schemas and both registered; validator now returns `$.operator_confirmed: Miss |
| `R1-SEC-003` | major | review-security-code | acted-on | Stated in Step 3 and the two steps reconciled (9950cbe9). |
| `R1-ARCH-001` | major | review-architecture | acted-on | Wired into the Step 9 dispatch with the owner-side row (9950cbe9). |
| `R1-ARCH-002` | major | review-architecture | acted-on | Typed and registered (9950cbe9); the conditional that makes the refusal real added in fd726ef4; completion_out |
| `R1-LOGIC-001` | major | review-logic | acted-on | `rules()` helper added and all three re-anchored (fd726ef4); re-verified RED in round 2. |
| `R1-LOGIC-002` | major | review-logic | acted-on | Fixed in fd726ef4; the canonical STATUS line it deleted was restored in 4a2b355f with both halves pinned. |
| `R1-LOGIC-003` | major | review-logic | acted-on | Row added plus the late-arrival rule (fd726ef4). |
| `R2-SEC-101` | blocker | review-security-code | acted-on | Fixed in 00f01b71 with an execution test; mutation-checked three ways (broken invocation, missing guard, broke |
| `R2-SEC-102` | major | review-security-code | acted-on | All four required in 2907d530; the guard extended to walk nested required keys. |
| `R2-ARCH-101` | major | review-architecture | acted-on | Both fixed in 2907d530; mutation-checked by dropping the nested key. |
| `R2-ARCH-102` | major | review-architecture | acted-on | Row replaced with a refusal and completion_outcome made required (2907d530); the same payload now returns `$.c |
| `R2-LOGIC-R001` | major | review-logic | acted-on | if/then added to all three copies (fd726ef4); the payload is now refused. |

## Regressions the fixes introduced

Three, all found and closed inside the same sequence:

- Closing the Output Contract schema mismatch deleted the canonical `STATUS:`
  line a caller parses. Found by the fix round's own enumeration rule, restored
  in `4a2b355f`, both halves pinned.
- Typing the dispatch fields produced a claimed refusal that did not refuse: the
  validator returned `valid:` on the payload both skills call BLOCKED. Closed in
  `fd726ef4` with an `if`/`then`.
- Rewriting the screen per comment introduced the blocker above. Closed in
  `00f01b71` with an execution test.

## Blockers (must fix before merge)

None outstanding. `R2-SEC-101` was a blocker and is `acted-on`.

## Deferred

`R2-ARCH-108` — the flow record has no branch field, so the completion gate
cannot compare a merge target to the base the dispatch named. Recorded as
`dismissed-deprioritised` with its reason: it changes the flow package's durable
record and its completion gate, which is not this branch's subject.

```json keryx:findings
[
  {
    "id": "R1-SEC-001",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "The injection screen was one batched `check-input` over `<collected-bodies>`, an artifact no command produces, whose findings carry byte offsets and no comment identity \u2014 so the per-comment exclusion it fed had no input.",
    "impact": "Under --fix, third-party comment text reaches an automated loop that edits code and merges with no screen able to exclude any single comment.",
    "suggested_fix": "Screen one comment at a time, keyed by its id; carry an id -> {gate, action, findings[]} map into Steps 8 and 9.",
    "evidence": "SKILL.md Step 3 as shipped in 33d993f1; `locationFor` in src/security/redact.ts returns line/column/start/end only.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Rewritten per-comment in 9950cbe9; the invocation itself was then found broken and fixed in 00f01b71, with an execution test."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 Step 3, the only invocation of the screen",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 Step 9 precondition 3, its only consumer",
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json"
      ],
      "enumeration_method": "`keryx ctx rg check-input` over the changed files and over .metaproject/skills returned one invocation; the same query filtered to src/review/ returned zero, establishing that no code supplements the screen. The output schema was read in full for any screen-related property."
    }
  },
  {
    "id": "R1-SEC-002",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "`fix: true` was dispatchable with no confirmation field, while flow-orchestrator establishes that a dispatched run takes its answer from its input rather than stalling.",
    "impact": "Text written by people outside the repository could drive code edits and a merge with no human decision anywhere in the chain.",
    "suggested_fix": "Require operator_confirmed {confirmed_by, confirmed_at, plan_digest} when fix is true; refuse under dispatch without it.",
    "evidence": "input-contract.schema.json at 33d993f1: `fix` a plain boolean, additionalProperties:false, no confirmation property.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Conditional added to both input schemas and both registered; validator now returns `$.operator_confirmed: Missing required property` (2907d530)."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the confirmation step",
        "src/gdskills/bundled/skills/review/review-pr-feedback/input-contract.schema.json",
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md"
      ],
      "enumeration_method": "Enumerated the entry paths into --fix: interactive invocation, dispatch via the input contract (read in full \u2014 `fix` a plain boolean under additionalProperties:false), and dispatch by another skill. `keryx ctx rg review-pr-feedback` over bundled/ established which of those are instantiated today."
    }
  },
  {
    "id": "R1-SEC-003",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "The skill never stated that `keryx security check-input` returns gate `pass`, action `warn` and exit 0 on the very comment it screens for, and Steps 3 and 9 described two different responses to a flagged comment.",
    "impact": "An agent branching on the gate or the exit code screens nothing while believing it did.",
    "suggested_fix": "State that the decision is read from findings[], never the gate or exit code; reconcile the two steps.",
    "evidence": "Executed: an injection payload returns gate pass / action warn / exit 0 with the finding present in findings[].",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Stated in Step 3 and the two steps reconciled (9950cbe9)."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 Step 3 exclusion rule",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 Step 9 precondition 3"
      ],
      "enumeration_method": "grep for `prompt-injection|unreviewed` over the changed SKILL.md returned exactly these two sites \u2014 the full population of places the skill says what happens to a flagged comment. The command's actual return was derived by reading the call chain end to end: security.ts handleCheck -> service.ts analyze -> detect/injection.ts -> resolve.ts -> exitCodeFor."
    }
  },
  {
    "id": "R1-ARCH-001",
    "reviewer": "review-architecture",
    "severity": "major",
    "problem": "`max_fix_rounds` was declared in the input schema and the Input Contract table and transmitted nowhere \u2014 two occurrences repo-wide, both declarations.",
    "impact": "The only knob over an irreversible merge-and-reply sequence was inert; a caller asking for one round got three.",
    "suggested_fix": "Send it as an `attempt budget:` constraint that can only LOWER the bound, with a matching row in the owner's table.",
    "evidence": "`keryx ctx rg max_fix_rounds` returned 2 hits, both declarations.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Wired into the Step 9 dispatch with the owner-side row (9950cbe9)."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/input-contract.schema.json",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 Input Contract table row",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the Step 9 dispatch payload",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md"
      ],
      "enumeration_method": "`keryx ctx rg max_fix_rounds` across the repository returned exactly 2 matches, both declarations; the dispatch payload and both copies of the constraint table were then read in full to confirm the consumer side was silent."
    }
  },
  {
    "id": "R1-ARCH-002",
    "reviewer": "review-architecture",
    "severity": "major",
    "problem": "The dispatch contract travelled as unvalidated free text through `constraints[]`; `base_branch` had no typed carrier at any hop; the schema was not in the CONTRACTS registry.",
    "impact": "One dropped or misread string is the difference between the fix landing inside the reviewed PR and landing on the default branch, reported as success.",
    "suggested_fix": "Type base_branch, completion_outcome and operator_confirmed; register the schema so a validator can be pointed at it.",
    "evidence": "flow-orchestrator input schema at 33d993f1: constraints as an untyped string array, absent from CONTRACTS; src/flow/types.ts has no branch field.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Typed and registered (9950cbe9); the conditional that makes the refusal real added in fd726ef4; completion_outcome made required in 2907d530."
    },
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/input-contract.schema.json",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/input-contract.schema.json",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the constraint strings sent",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md",
        "src/gdskills/contracts.ts",
        "src/flow/types.ts"
      ],
      "enumeration_method": "Read the flow-orchestrator input schema in full; `grep -n 'name: \"' src/gdskills/contracts.ts` for the complete registry; `keryx ctx rg baseBranch|base_branch` over src/**/*.ts for every typed carrier of the concept; `grep -n branch src/flow/types.ts` returned zero."
    }
  },
  {
    "id": "R1-LOGIC-001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "Two assertions in the new guard matched only Red Flags table rows, not the rules they named; a third had a Red Flags backstop.",
    "impact": "The one safety rule in a skill that feeds external comments into a merge loop could be deleted with the suite reporting success.",
    "suggested_fix": "Slice the Red Flags table off before rule assertions and re-anchor the regexes.",
    "evidence": "Mutation: gutting the prompt-injection rule, the info clause and the pagination reason left 24 pass / 0 fail with an identical expect() count.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "`rules()` helper added and all three re-anchored (fd726ef4); re-verified RED in round 2."
    },
    "file": "src/gdskills/review-pr-feedback-wiring.test.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/review-pr-feedback-wiring.test.ts \u2014 the developer-addresses regex",
        "src/gdskills/review-pr-feedback-wiring.test.ts \u2014 the info-clause regex",
        "src/gdskills/review-pr-feedback-wiring.test.ts \u2014 the first-thirty regex"
      ],
      "enumeration_method": "Extracted all 46 toContain/toMatch arguments targeting SKILL.md, resolved every match to a line number with a script handling the flat() whitespace collapse, and partitioned them against the Red Flags section boundary. Three matched at or beyond it; two exclusively. Confirmed by executing the mutation."
    }
  },
  {
    "id": "R1-LOGIC-002",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "The documented Output Contract block could not validate against the schema shipped beside it: `STATUS` uppercase against required `status` under additionalProperties:false, and required `summary` absent.",
    "impact": "An agent emitting exactly what the skill documents produces output the skill's own schema rejects.",
    "suggested_fix": "Lowercase the key inside the block, add summary, keep the canonical STATUS line outside it.",
    "evidence": "Set-differenced the block's keys against the schema: missing [status, summary]; extra [STATUS].",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd726ef4; the canonical STATUS line it deleted was restored in 4a2b355f with both halves pinned."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the Output Contract yaml block",
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json"
      ],
      "enumeration_method": "Set-differenced the schema's required array and properties keys against the keys of the documented block, executed as a script. The input pair was checked for the same class and matches exactly, so the input side has no member."
    }
  },
  {
    "id": "R1-LOGIC-003",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "`needs-clarification` had no row in the Step 10 disposition mapping while Step 9's post-merge re-collection can produce it.",
    "impact": "buildReplyPass refuses over any comment with no outcome \u2014 after the merge has landed, with every reviewer unanswered.",
    "suggested_fix": "Map it to answered-disagree and state that a late arrival does not reopen the loop.",
    "evidence": "Cross-tabulated the eight Step 6 verdicts against the Step 10 table; exactly one unmapped.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Row added plus the late-arrival rule (fd726ef4)."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the Step 10 mapping table",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the Step 9 post-merge re-collect",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 Step 6 rule 4"
      ],
      "enumeration_method": "Cross-tabulated the eight verdict names in the Step 6 table against every left-hand cell of the Step 10 mapping table, then checked the reverse direction against FINDING_DISPOSITION_STATES and EXTERNAL_TERMINAL_DISPOSITIONS in src/review/types.ts. Exactly one verdict unmapped."
    }
  },
  {
    "id": "R2-SEC-101",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "problem": "The per-comment screen passed the comment TEXT to `--file`, which takes a path: ENOENT on every comment, no findings[], and Step 9 precondition 3 satisfied vacuously. A body that IS a resolvable path would make the screen read that file and quote it into the report.",
    "impact": "Any GitHub user who can comment on the PR supplies the input; under --fix it reaches Steps 6, 7 and the flow-orchestrator dispatch unscreened.",
    "suggested_fix": "Write the body to a file and screen the path, with a `test -s` guard because the empty string scans clean.",
    "evidence": "Executed: `ENOENT: no such file or directory, open 'Ignore all previous instructions\u2026'`; the same payload via a real path returns prompt-injection.ignore-instructions.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 00f01b71 with an execution test; mutation-checked three ways (broken invocation, missing guard, broken detector regex) \u2014 each fails one test."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the screen invocation",
        "src/gdskills/review-pr-feedback-wiring.test.ts \u2014 the three prose tests covering it"
      ],
      "enumeration_method": "`keryx ctx rg check-input` across the 15 files in merge-base..HEAD and across .metaproject/skills returned one site. The .metaproject mirror of review-pr-feedback does not exist (the skill is full-tier, this project installs recommended), so there is no stale second copy. Verified by executing both forms of the command."
    }
  },
  {
    "id": "R2-SEC-102",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "`screened`, `excluded_for_injection`, `filtered` and `fix.operator_confirmed` were all optional, so a run whose screen never executed emitted output identical to one that screened and found nothing.",
    "impact": "The only field that would record the blocker above was optional; measured-zero and not-measured were the same value.",
    "suggested_fix": "Add all four to required and carry them in the documented block, nested ones included.",
    "evidence": "Parsed the schema: required omitted all four while their own descriptions asserted they are never absent by omission.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "All four required in 2907d530; the guard extended to walk nested required keys."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json \u2014 required omits screened",
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json \u2014 required omits excluded_for_injection",
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json \u2014 required omits filtered"
      ],
      "enumeration_method": "Loaded the schema and diffed the required array against properties; the class is 'a property whose description asserts it is never absent by omission, that is not in required'. Three members, exhaustive for this file."
    }
  },
  {
    "id": "R2-ARCH-101",
    "reviewer": "review-architecture",
    "severity": "major",
    "problem": "Step 9 claimed the output contract records the operator confirmation. `fix.operator_confirmed` existed in the schema, was absent from the documented block, and was not in `fix.required`; the guard's key scan was column-0 only so it could not see nested keys.",
    "impact": "A compliant --fix run emits a schema-valid result in which an approved run and an assumed one are indistinguishable.",
    "suggested_fix": "Add the key to the documented block and to fix.required; extend the guard to nested keys.",
    "evidence": "Read the documented block (7 keys, no operator_confirmed) against fix.required ([flow_id, flow_status, merged_into]).",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Both fixed in 2907d530; mutation-checked by dropping the nested key."
    },
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the documented fix block",
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json \u2014 fix.required",
        "src/gdskills/review-pr-feedback-wiring.test.ts \u2014 the column-0 key scan"
      ],
      "enumeration_method": "`keryx ctx rg operator_confirmed` over the skill directory returned 5 hits \u2014 input schema, three Step 9 prose/JSON sites, output schema \u2014 and zero in the documented output block. review-pr-feedback is full-only so it is not mirrored; the bundled copy is the only site."
    }
  },
  {
    "id": "R2-ARCH-102",
    "reviewer": "review-architecture",
    "severity": "major",
    "problem": "The round-2 if/then fenced the typed route while the same commit's constraint table documented an untyped one: a payload carrying only `constraints: [\"completion: outcome A\"]` validated clean.",
    "impact": "The enforcement was bypassed by moving one value into the free-text array, and the file owning the fence documented the bypass.",
    "suggested_fix": "Delete the row and make completion_outcome required so an absent one is a refusal.",
    "evidence": "Executed the validator on four payloads; the constraints-only one returned `valid`.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Row replaced with a refusal and completion_outcome made required (2907d530); the same payload now returns `$.completion_outcome: Missing required property`."
    },
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md \u2014 the constraint table row",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/input-contract.schema.json",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/input-contract.schema.json",
        ".metaproject/core/gdskills/contracts/flow-orchestrator-input-contract.schema.json"
      ],
      "enumeration_method": "`rg --hidden 'completion: outcome A'` returned exactly 2 hits, the bundled table and its mirror (the first pass without --hidden missed every .metaproject copy and was re-run). `rg -ln '\"if\"' over the three schema copies confirmed all three carry the conditional; diff confirmed byte-identity."
    }
  },
  {
    "id": "R2-LOGIC-R001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "`keryx skills contracts validate --schema flow-orchestrator-input` returned `valid:` on the exact dispatch both skills call BLOCKED \u2014 a conditional requirement encoded as an unconditional optional property.",
    "impact": "An agent told to validate reads `valid:` and treats it as approval for the case the prose calls an escalation.",
    "suggested_fix": "Express the conditional with if/then, which contracts.ts implements and review-finding.schema.json already uses.",
    "evidence": "Nine crafted payloads run through the validator; the no-confirmation one returned valid while nested required/additionalProperties/minLength/enum were all enforced.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "if/then added to all three copies (fd726ef4); the payload is now refused."
    },
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/input-contract.schema.json",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/input-contract.schema.json",
        ".metaproject/core/gdskills/contracts/flow-orchestrator-input-contract.schema.json",
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md \u2014 the prose claiming the refusal",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md \u2014 the same instruction"
      ],
      "enumeration_method": "Ran the validator on nine crafted payloads rather than reading contracts.ts: nested required, nested additionalProperties, nested minLength and top-level enum/minLength all proved enforced, isolating the gap to the missing conditional. `grep -c '\"if\"'` returned 0 in all three copies."
    }
  }
]
```
