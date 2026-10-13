# Review of PR #889 (flow 403), head 9bc17751, round 2

Recheck round of PR 889 (head 9bc17751). The two findings of the first round are re-raised here under their original identity so that their fixes are verified. The fixes are not in PR 889 but in follow-up PR 896 (fix commit 5a8c877f, merge commit 3f80f9a1), so the verifier ran the new tests against a clean extract of 3f80f9a1 and records the commands in `verifications.json`. Nothing new was found: AC13 and AC16 hold at 3f80f9a1.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/intake/actions.ts",
    "line": 165,
    "problem": "The work-root rule is applied before the claim from a project lookup whose failure is swallowed (`project = undefined`), and `workRefusal` then returns undefined; `runFlow` looks the project up a second time and never applies the rule again.",
    "impact": "If the first lookup throws and the second succeeds, a take or review-flow press on a card of a work-root repository runs although `allowTakeInWork` is off, which AC16 forbids.",
    "suggested_fix": "Fail closed: refuse the press when the pre-claim lookup throws, or re-apply `workRefusal` inside `runFlow` with the project it just found.",
    "evidence": "decide(): `try { project = await projectFor(view.repo) } catch { project = undefined }` followed by `workRefusal(action, project, ...)`, which returns undefined when project is undefined; runFlow() calls `projectFor` again and goes straight to `flows.init`.",
    "confidence": "medium"
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/intake/actions.ts",
    "line": 245,
    "problem": "`recoverIntakeTaking` awaits `projectFor(card.repo)` outside any try, so one throwing lookup aborts the recovery of every later stuck card and rejects the call.",
    "impact": "In `runTick` the call sits in the same try as the poll of that root, so while a stuck `taking` card has a repository whose lookup throws, the whole poll of that root is skipped on every tick and the card stays in `taking`.",
    "suggested_fix": "Catch the lookup per card and fall through to the `failed` branch for that card, so recovery always finishes and the poll still runs.",
    "evidence": "for (const card of stuck) { ... const project = await projectFor(card.repo); ... } has no catch, while `flows.findByCard` right below has `.catch(() => undefined)`; serve-intake.ts runs recoverIntakeTaking, readIntakeConfigFile and runIntakeTick in one try.",
    "confidence": "medium"
  }
]
```
