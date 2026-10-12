# Review of PR #889 (flow 403), head 9bc17751

Acceptance criteria AC1 to AC25 were checked against the merged diff of PR 889 (80 files): the card and press path (`src/intake/press.ts`, `src/intake/actions.ts`), the poll and card building (`src/intake/poll.ts`), the serve wiring (`src/commands/serve-intake.ts`) and the hub route and handler timeout (`src/remote/hub.ts`). The targeted tests of the flow (26 files, 289 tests) pass on the merge commit. The ledger claim is atomic (`appendIntakeIfState`), the actions come from the registry and not from the press, a press on a card of another message is journaled and ignored, and the hub answers every press even when the handler throws or times out. No blocking or major defect was found. Two minor observations on the work-root rule and on recovery are recorded.

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
