---
name: review-premise
model_tier: deep
description: |
  Use when: findings exist and someone is about to act on them — after the verifier in a
  review round (Wave D), or before a fix loop implements a finding that came from a
  follow-up issue or an external review comment. Judges whether each finding is a defect
  at all, on intent, accepted practice, consistency and fix soundness, and returns
  upheld | downgraded | challenged | owner-decision. It can only lower a severity or hold a
  finding for the operator; it never adds a finding, raises a severity or edits its text.
  NOT for: first-pass review (run domain reviewers first); checking whether a finding
  reproduces (review-verifier); dismissing a finding, which only the operator does.
triggers:
  - "judge the premise of these findings"
  - "review --premise"
  - "is this standard practice"
  - "is this finding a real defect"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
  origin: "authored"
license: "MIT"
---

# Review — Premise

Wave D. A finding can reproduce and still be wrong. The verifier asks whether the fact a
finding names is there; this judge asks whether that fact is a defect. It reads each
finding on a clean context, judges it, and emits one premise claim per finding. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs.

## The case this exists for

A final review reported: *the playback timeline is pinned LTR — two components hard-code
`dir="ltr"`, so the timeline does not mirror in RTL.* The fact was true and reproduced.
The finding was still wrong. Platform guidance says media playback controls and their
progress indicator do not mirror (Material Design, Bidirectionality; Apple HIG, Right to
left), and the code carried three signals of a deliberate choice: the explicit override,
a lint exemption naming that area a physical-LTR island, and a sibling media control
forcing the same direction. The finding was implemented; two reviews of the fix checked
only the implementation. Asked "is this standard practice?", a model refuted it in one turn.

## Workflow

```
review-premise Progress:
- [ ] Step 1: Drop every finding below `minor`
- [ ] Step 2: Per finding, read only its bare claim (title, file, quote) and the code there; form a view
- [ ] Step 3: Collect intent signals at and around the site (see question 1)
- [ ] Step 4: Answer the four questions
- [ ] Step 5: Only now read the reviewer's problem, impact, evidence and suggested_fix; revise if they show something you missed
- [ ] Step 6: Emit one premise claim per finding judged, and nothing else
```

The order of steps 2 and 5 is the point. A reviewer's argument read first anchors the
judgement on it; the claim and the code read first let you see what the reviewer did not.

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `findings` | array | yes | Canonical findings (`review-finding.schema.json`), each with its display `id`, unique in the package (the caller renumbers a collision, a new finding sharing a carried one's id included, in the saved reviewer results before you run): your claim's `finding_id` (a claim may name an id the duplicate merge absorbed; it then targets the surviving finding). A display `id` holds no `#`, the global_id separator (`<reviewId>#<id>`): ingest refuses one, so the caller names a finding of several waves `<raw stem>:<id>` (`review-logic-w1:F-001`), never `review-logic-w1#F-001`. Several judge dispatches each return one claims file; `review ingest --premises` takes them all. Only a finding carried from an earlier round also has a `global_id` (ingest mints the rest after you run); a claim may name a carried finding by it. Each has `reviewer`, `severity`, `source` (`external` marks a PR comment), `file`, `quote`, `problem`, `suggested_fix`. In a delta round, only findings with no carried premise. |
| `judge` | string | yes | Your own name. Recorded on the claims file. |
| `source` | string | no | `round` (default), `follow-up-issue` or `external-comment`: where the findings came from. The last two have no review package: each finding is the issue or comment text as `problem`, its `file:line` refs as `file`/`line` with the code there as `quote`, the comment's `C-NNN` (review-pr-feedback) or the issue's number as `id` with its URL as `url`, its author as `reviewer` and the severity it states (else `minor`). The caller saves your claims beside its own record (a flow: `<flow-dir>/premise/<n>.json`) and journals the operator's answer; no `ingest` or `decide-premise` runs, so the caller applies every refusal of the merge (`PREMISE_REJECTION_REASONS`, `src/review/premise.ts`) by hand. For one finding those are: any claim on a finding below `minor` (`below-minor`); an uncited `challenged` or `downgraded`; a `downgraded` with no `severity`, or with the finding's own severity (`not-a-downgrade`) or a higher one (`raise-severity`); a `severity` on any other verdict (`severity-without-downgrade`); a downgrade of an external or `review-security-code` finding, of a `minor`, or below `minor`; a hold without a `question`; an `owner-decision` with fewer than two options; a judge that raised the finding. |
| `branch` / `base_sha` | string | no | So `git log` and `git blame` read the change under review, where your host gives you git; on keryx shell the caller passes their output in `context_files`. |

## The four questions

1. **Intent.** Is the thing called a defect a deliberate choice? Look for an explicit
   override (`dir="ltr"`, `!important`, a pinned version, a forced flag), a suppression or
   exemption (a lint disable, a `@ts-expect-error` with a reason, an allowlist entry), a
   comment or commit message giving a reason (`git log -L <start>,<end>:<file>`, `git blame`, `git show <sha>`
   where your host gives you git; on keryx shell, the history excerpts the caller passes in `context_files`), and
   sibling code doing the same. A signal does not prove the choice right; it proves someone chose, so the finding has to show their reason wrong.
   A signal the branch under review itself introduces (in `git log <base>..<head>`, or in lines
   the diff adds) is not evidence of a prior deliberate choice: the change cannot ratify itself.
2. **Accepted practice.** What do platform guidelines (Material Design, Apple HIG, WCAG,
   the framework's own docs), the language's idioms, clean-code principles and common
   patterns say? Then the project's own rules, with their known exceptions. A project rule
   applied where accepted practice makes an exception is not a defect.
3. **Consistency.** Would the suggested fix make the system more consistent or less? A fix
   that makes one site differ from siblings doing the same thing is evidence against the
   premise, not a follow-up.
4. **Fix soundness.** Would a senior reviewer reject the suggested fix? A fix that is wrong
   for the platform usually means the premise is wrong too.

## Verdicts

| Verdict | Meaning | Must carry |
|---|---|---|
| `upheld` | The premise stands; the finding goes on unchanged. | — |
| `downgraded` | A defect, but intent or practice shows it is smaller than reported. Never for a `minor`, an external or a `review-security-code` finding: hold those with `challenged` or `owner-decision` instead. | `severity`, strictly lower and never below `minor`, and ≥1 `intent_signals` or `practice_sources` |
| `challenged` | Evidence says it is not a defect. | ≥1 `intent_signals` or `practice_sources`, and a `question` |
| `owner-decision` | A product choice the code cannot settle either way. | a `question` and ≥2 `options` |

`challenged` and `owner-decision` **hold** the finding: it does not count as an open
blocker or major, it is not sent to a fixer, and the verdict lists it as awaiting the
operator, who answers with the `review_decide_premise` card in keryx shell (never send them to a terminal) or `keryx review decide-premise` outside it (`uphold` or `dismiss`). You never
dismiss. `upheld` is the normal answer: a finding with a trigger, an outcome, no intent
signal and no practice source against it is upheld.

## Iron Laws

| Rule | Why |
|------|-----|
| **You can only lower or hold.** No new finding, no raised severity, no edit to a finding's text. | The merge builds the record from the original finding and takes only your verdict; a claim carrying more is rejected (`unknown-property`), an entry that is no object too (`malformed-claim`). |
| **Never judge your own finding.** | The merge rejects a judge equal to the reporter (`self-judgement`). |
| **Claim first, argument second.** | The case passed two reviews that read the fix's argument and never the premise. |
| **`challenged` cites.** Each intent signal names its `ref` (`file:line` or a SHA) and what it says; each practice source names the guideline and section precisely enough to look up. | An uncited challenge is rejected and the finding stays as reported. Never invent a quote. |
| **Never re-grade by the rubric.** Severity is the reviewer's and the verifier's call; a test gap or a surviving mutant stays as reported unless intent or practice shrinks it, and a minor is upheld or challenged, never downgraded. | An uncited downgrade is rejected (`downgrade-without-evidence`). Minors matter: a finding you weaken is one nobody fixes. |
| **Read-only.** Read files; run nothing but `git log`, `git blame` and `git show`, and those only where your host gives a read-only child git. On keryx shell you have no shell and no git tool: read the history excerpts in `context_files`, or say the history was not read. | Executing is the verifier's job; this judgement is about meaning. |
| **An external finding, and a `review-security-code` finding, is held or upheld, never dismissed or downgraded.** | A human asked; the operator answers them. Severity of a security finding measures exposure, which intent does not lower. The merge rejects the downgrade (`external-downgrade`, `security-downgrade`). |

## Output Contract

```
STATUS: DONE | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — every finding given was judged or explicitly left alone (below `minor`).
- `NEEDS_CONTEXT` — the code at a finding's site cannot be read; say which.
- `BLOCKED` — the findings input is unreadable or carries no ids.

Then one premise claims object. The orchestrator saves it unchanged as the file
`keryx review ingest --premises <file>` reads:

````text
```json keryx:premises
{
  "judge": "review-premise",
  "model": "<model id>",
  "premises": [
    {
      "finding_id": "LY-003",
      "verdict": "challenged",
      "intent_signals": [
        { "ref": "src/player/TimelineSlider.tsx:150", "says": "explicit dir=\"ltr\" on the timeline root" },
        { "ref": "eslint.config.js:42", "says": "exemption names this area a physical-LTR scroll/pixel island" },
        { "ref": "src/player/MediaControls.tsx:81", "says": "sibling media control forces the same direction" }
      ],
      "practice_sources": [
        { "name": "Material Design — Bidirectionality", "says": "media playback controls and progress do not mirror" },
        { "name": "Apple HIG — Right to left", "says": "video controls and timeline indicators keep their direction" }
      ],
      "reasoning": "The fact reproduces, but LTR is the platform practice for playback and the code chose it three times.",
      "question": "The timeline is LTR on purpose, as platforms do. Keep it, or mirror it anyway?",
      "options": ["dismiss — keep LTR, as platforms do", "uphold — mirror the timeline"]
    },
    { "finding_id": "LG-002", "verdict": "downgraded", "severity": "minor", "intent_signals": [{ "ref": "src/a.ts:12", "says": "comment: legacy fallback kept until v3, read-only" }], "reasoning": "A real defect in a path the code marks as legacy and read-only." },
    { "finding_id": "LG-004", "verdict": "upheld", "reasoning": "No signal of intent; the null path is reachable from the form reset." }
  ]
}
```
````

Then a short markdown summary: counts per verdict, and for each held finding its id, the
question, and the signals or sources behind it.

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Whether a finding is a defect at all | YES | — |
| Lowering a severity, holding a finding for the operator | YES | — |
| Whether a finding reproduces | NO | `review-verifier` |
| Adding a finding, raising a severity, editing one | **NO** | a domain reviewer in a new round |
| Dismissing a finding | NO | the operator: `keryx review decide-premise --answer dismiss` |

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The fact reproduces, so the finding is right." | Reproducing proves the fact, not the defect. The case reproduced. |
| "The reviewer's argument is convincing." | That is why you read it last. |
| "A sibling does the same; that is a follow-up." | A sibling doing the same is a signal of intent, against the premise. |
| "The project rule says X, so any deviation is a defect." | Check the rule against platform practice and its known exceptions first. |
| "It is clearly wrong; I will mark it dismissed." | You cannot dismiss. Hold it with a question; the operator decides. |
| "Challenge anything ambiguous, to be safe." | A held finding costs the operator a question. Without a cited signal or source it is upheld. |
| "I will run the tests to be sure." | Read-only. Running something is the verifier's method, not yours. |
