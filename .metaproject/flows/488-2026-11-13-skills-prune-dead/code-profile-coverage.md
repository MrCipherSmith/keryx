# Coverage of the removed `code-*` review profiles

Flow 488. `code-ai-review`, `code-style-review` and `code-mobx-store-review` are
removed from the bundled tree and its `.metaproject/` mirror. The owner's
condition is that review quality must not drop, so this table names, for every
concrete check in the three SKILL.md files, the surviving text that raises the
same defect. A check counts as covered only when the surviving text names the same
defect, not the same topic. A check with no such text was moved into the surviving
reviewer whose scope it belongs to, in the same commit as this file.

Cites are `file:line` against the tree at the commit that adds this file.
Abbreviations: `FE` = `src/gdskills/bundled/skills/review/review-frontend/SKILL.md`,
`ST` = `.../review-style/SKILL.md`, `LG` = `.../review-logic/SKILL.md`,
`PF` = `.../review-performance/SKILL.md`, `AR` = `.../review-architecture/SKILL.md`,
`SEC` = `.../review-security-code/SKILL.md`, `CC` = `.../review-clean-code/SKILL.md`,
`TP` = `.../review-testing-practices/SKILL.md`, `UX` = `.../review-ui-ux/SKILL.md`,
`MST` = `src/gdskills/bundled/rules/core/mobx-store-template.mdc`,
`CSP` = `src/gdskills/bundled/rules/core/code-style-patterns.mdc`.

Status: **covered** (text already names the defect), **moved** (a line was added to
the named reviewer in this change).

## 1. code-ai-review

The skill's own checks are its scope list (L35-39), the category headings of its
output template (L121-143), the rules it takes from `code-review-ai-assistant.mdc`
(L99-102 and that rule's L40-44) and its Red Flags rows (L212-219). It has no
checklist of individual defects of its own; each category is delegated below to the
reviewer that has one.

| # | Check (source line) | Status | Where it lives now |
|---|---|---|---|
| A1 | Correctness and logic bugs (L35) | covered | `LG:100-101`, `LG:103-127` (the change that does nothing), `LG:163-169` |
| A2 | Type safety and TypeScript contract violations (L36) | covered | `LG:155-161` (return type, cast hiding a mismatch, implicit `any`), `FE:345-358` |
| A3 | Security issues (L37) | covered | `SEC:82-198` (injection, auth and IDOR, input validation, secrets, crypto, CSRF, path traversal, redirects, React and NestJS patterns) |
| A4 | Null-safety issues (L37) | covered | `LG:131-135` |
| A5 | Error handling completeness (L38) | covered | `LG:144`, `LG:149-153` (swallowed catch, lost stack, unchecked `response.ok`, partial success as full) |
| A6 | Performance anti-patterns (L39) | covered | `PF:100-104`, `PF:114-117`, `PF:189-191` |
| A7 | Output category "Architecture & State" (L127) | covered | `AR:102` (API call in a component), `AR:172-184` (logic in a component, store layer), `FE:148-155`, `FE:310-317` |
| A8 | Output category "Readability & Style" (L130) | covered | `ST:79-192` (naming, dead code, complexity, DRY, imports, comments, file length, console), `CC:115-310` |
| A9 | Output category "UX/UI" (L136) | covered | `UX:99-128` (usability, hierarchy and distinctiveness passes) |
| A10 | Output category "A11y" (L139) | covered | `FE:181-192` (alt text, accessible name, label, keyboard support), `UX:80-98` |
| A11 | Output category "Tests" (L142) | covered | `TP:107-134` (location and tiers, boundary mocking, behaviour assertions) and the mutation pass `TP:49-76` |
| A12 | "Flag unsafe casts" (rule L42) | covered | `LG:159`, `FE:346` (`as any` / `as unknown as T` without a comment) |
| A13 | "Flag hidden complexity" (rule L42) | covered | `ST:134-136` (more than ten branches), `ST:121-127` (condition and nesting depth), `CC:155` (function size) |
| A14 | One entry per occurrence is not more thorough: report the class once with every site (Red Flags L218) | covered | shared law 3, `FE:60`, and the same text in every surviving reviewer |
| A15 | "The pattern is usually wrong" with no reachable path is an observation (Red Flags L219) | covered | shared laws 1 and 2, `FE:58-59` |
| A16 | Every finding anchored to a line the branch slice changed (Verification L235) | covered | `ST:67`, `FE:96` (supplied text first, never rebuild the diff) |
| A17 | A store problem or a naming problem is not this profile's finding (Red Flags L217) | covered | routing, not a defect: `FE:46-50` and `ST:313-323` send each to its reviewer |

Not checks, so not rows: the verdict labels and the output structure
(`code-review-ai-assistant.mdc` L14-29), "do not request massive refactors", "align
suggestions with project patterns", Severity/Location/Problem format (L151-158), the
Job Context block (L187-202), and the Red Flags rows that say the profile's prose
cannot be ingested, that its Russian is an accident, and that an unqualified review
request belongs to `review-orchestrator`. Those describe the removed profile, not a
defect in reviewed code. The rule `code-review-ai-assistant.mdc` stays: its verdict
vocabulary is still cited by `code-review-learned-profile.mdc:65`.

## 2. code-style-review

| # | Check (source line) | Status | Where it lives now |
|---|---|---|---|
| S1 | `any` forbidden; use `unknown` plus guards (L70) | covered | `FE:345`, `FE:354`, `CSP:16` |
| S2 | Component props via `interface`, `I` prefix (L71) | covered | `FE:348`, `FE:356`, `ST:95`, `CSP:17` |
| S3 | Prefer `?.` and `??`, avoid `!` (L72) | covered | `FE:347`, `FE:349`, `LG:133`, `CSP:18` |
| S4 | Store without `makeObservable(this)` (L75) | covered | `FE:200`, `FE:206`, `MST:18` |
| S5 | `runInAction` after `await` (L76) | covered | `FE:279`, `FE:288`, `AR:180`, `MST:100` |
| S6 | Action methods `@action.bound` (L77) | covered | `FE:273`, `FE:285`, `MST:57` |
| S7 | Derived state in `@computed` (L78) | covered | `FE:202`, `FE:208`, `PF:189-191` |
| S8 | `@observable.shallow` for lists where it applies (L79) | moved | `FE:249` and `FE:254` (new): a list of plain items that is only replaced whole uses `shallow`/`ref`, not deep `@observable`; flag is `minor`. `FE:201` only listed the decorators; `FE:248` covered large external objects, not lists |
| S9 | Inter-store callbacks `onChangeX`/`onFireX`/`handleX`/`syncX` are `private` (L80) | covered | `FE:85-86`, `FE:294-307`, `MST:133-143`, `CSP:33`, `CSP:53`, `AR:184` |
| S10 | Components that read observables are `observer(...)` (L83) | covered | `FE:76-78`, `FE:136-143`, `CSP:32`, `CSP:38` |
| S11 | MVVM: logic and side effects in Store/Service, not View (L84) | covered | `FE:147-155`, `AR:172`, `CSP:39`, `CSP:43-45` |
| S12 | No business logic in `useEffect` (L85) | covered | `FE:159`, `FE:168` |
| S13 | File structure order: imports, interfaces, component, helpers (L86) | moved | `ST:182` (new): a React component file whose parts are out of order, `minor`. `ST:152` covered import grouping only |
| S14 | API/IO not in the View: in Service/Store (L89) | covered | `FE:148`, `FE:152-153`, `FE:323`, `FE:327`, `AR:102`, `CSP:49` |
| S15 | Interact with a Store through actions, no direct mutation outside one (L90) | covered | `FE:74-75` (frontend law 1), `AR:182`, `CSP:51` |
| S16 | Critical: API in View, missing `observer`, direct store mutation, MobX async violations (L93) | covered | the same rows: S14, S10, S15, S5. Severity differs on purpose and is set by the canonical rubric (`FE:564-566`): missing `observer` is `major`, not `critical` |
| S17 | Warning: `console.log` instead of `AppLogger` (L94) | covered | `ST:188-190` |
| S18 | Warning: inline object props without memo or const (L94) | covered | `PF:100-101`, `PF:103` |
| S19 | Warning: heavy logic in render (L94) | covered | `PF:102`, `PF:114-117`, `FE:155` |
| S20 | Warning: questionable types (L94) | covered | `LG:155-161`, `FE:350-358` |
| S21 | Warning: public inter-store callbacks and handlers (L94) | covered | same as S9 |
| S22 | `public` keyword on a member is an ESLint error (Red Flags L183) | covered | `FE:81-84`, `FE:239`, `FE:582`, `MST:27` |
| S23 | Missing `observer` is silent: check what the component reads through props and getters (Red Flags L184) | covered | `FE:76-78`, `FE:139` (conditional access still needs the wrapper) |
| S24 | A "temporary" `any` is still rated; fix is `unknown` plus a guard (Red Flags L185) | covered | `FE:345`, `FE:354` |
| S25 | A real bug found while reading for style goes to the logic reviewer (Red Flags L186) | covered | `ST:318` |
| S26 | Anchored to changed lines only; no discussion of legacy outside the slice (L26, L133) | covered | `ST:67`, `ST:146` |

Not checks: Russian-language instructions, the Critical/Warnings/Suggestions report
template, unified-diff-only fixes, "no new libraries unless asked", the Job Context
block, and the Red Flags rows about routing and ingestion. The rule
`code-style-patterns.mdc` stays; many loaders cite it (`context-resolver.ts:90-92`,
`task-implementer/SKILL.md:214-216`, `feature-analyzer/SKILL.md`).

## 3. code-mobx-store-review

| # | Check (source line) | Status | Where it lives now |
|---|---|---|---|
| M1 | `makeObservable(this)` in the constructor (L55) | covered | `FE:200`, `FE:206`, `MST:18` |
| M2 | State in `@observable` / `.shallow` / `.ref` (L56) | covered | `FE:201`, `FE:203`, `FE:207`, `MST:248-274` |
| M3 | Derived values in `@computed`, not in the View (L57) | covered | `FE:202`, `FE:150`, `FE:155`, `FE:208`, `PF:189-191` |
| M4 | Member ordering (L59-68) | covered | `FE:210-223`, `MST:37-53`. The removed text put `@observable` fields before `private` fields; the surviving, canonical order (and the order `MST` ships) puts `private` fields first. The defect is the same (members out of the project's order), the surviving order wins and is the one the template shows |
| M5 | The word `public` is forbidden by ESLint (L71) | covered | `FE:81-84`, `FE:239`, `MST:27` |
| M6 | Accessibility modifiers by role: no modifier / `private` / `private readonly` / `readonly` / `protected` (L73-77) | covered | `FE:229-236`, `MST:29-35` |
| M7 | A `private` field that can be `private readonly` (L81) | moved | `FE:242` widened: any private field never reassigned, not only injected dependencies (no line added) |
| M8 | Internal state or helper without `private` (L82) | covered | `FE:241` |
| M9 | Mutation inside an action or `runInAction` (L85) | covered | `FE:74-75`, `FE:255`, `FE:288` |
| M10 | `runInAction` after `await` (L86) | covered | `FE:279`, `FE:288` |
| M11 | No direct mutation from outside the action layer (L87) | covered | `FE:74-75`, `AR:182` |
| M12 | `@action.bound` only for UI-called methods, as thin wrappers (L90) | covered | `FE:273-274`, `FE:285`, `MST:55-60` |
| M13 | API calls and mutation in a private method with `runInAction` (L91) | covered | `FE:277-282`, `FE:321-327`, `MST:94-103` |
| M14 | Never `@action.bound` on a private method, except for an inter-store callback (L92-93, L97) | covered | `FE:308`, `MST:102-103`, `MST:159` |
| M15 | `@action.bound` that calls the API directly (L96) | covered | `FE:287`, `FE:326` |
| M16 | A method another store calls is `@action.bound` where a plain method would do (L98) | covered | `FE:286` (an action wrapper on a method that mutates nothing). A method that does mutate must stay an action (`FE:273`, `MST:57-59`), so the removed suggestion is right only in the non-mutating case, which `FE:286` names |
| M17 | Inter-store callbacks and handlers are `private`; decision question "is it called from JSX" (L101-113) | covered | `FE:85-86`, `FE:294-307`, `FE:240`, `MST:133-157` |
| M18 | Bidirectional sync needs an equality guard in one direction (L116, L139-140) | covered | `FE:310-317`, `MST:161-190` |
| M19 | Truthy guard on an optional field blocks clearing (L143, L160-161) | covered | `FE:317`, `MST:192-210`, `CSP:55` |
| M20 | API/IO only in private store methods; `@action.bound` thin (L164-166) | covered | `FE:319-327`, `MST:240-245` |
| M21 | API call in a component (L168-170) | covered | `FE:79-80`, `FE:327`, `FE:566` |
| M22 | A child store's `init()`/`onMount()` is called by the parent store, not a component `useEffect` (L173) | covered | `FE:331`, `FE:464`, `MST:214-216` |
| M23 | A component `useEffect` calling `store.loadX()`/`store.init()` (L174, L178) | covered | `FE:160`, `FE:166`, `FE:337`, `FE:464` |
| M24 | No `dispose()` or `disposed` guard in a store with async work (L175, L179) | covered | `FE:262`, `FE:267`, `FE:339`, `MST:98-101` |
| M25 | Parent store does not call `child.dispose()` in `onUnmount()` (L175, L180) | covered | `FE:333`, `FE:338`, `MST:217` |
| M26 | Business logic and IO stay in Store/Service, not View (L183) | covered | `FE:147-155`, `AR:172` |
| M27 | Components that read observables are `observer(...)` (L184) | covered | `FE:76-78`, `FE:136-143` |
| M28 | `useEffect` must not stand in for store lifecycle (L185) | covered | `FE:160`, `FE:330-337`, `FE:449-464` |
| M29 | No `any` or unsafe casts (L188) | covered | `FE:345-346`, `LG:159` |
| M30 | Explicit interfaces for store state and public API (L189) | moved | `FE:350` and `FE:357` (new): store state and public API typed with explicit interfaces, `minor`. `FE:348` named props interfaces only |
| M31 | `!` only with proof of initialisation (L190) | covered | `FE:347`, `FE:355`, `LG:133` |
| M32 | Red Flags: absence of the guard is the finding, not the absence of a reproduction (L276) | covered | `FE:586`, `FE:315-316` |
| M33 | Red Flags: a store problem and a naming problem go to other lanes (L280) | covered | `FE:46-50`, `ST:313-323` (routing) |

Not checks: the Russian-language framing, the Critical/Warnings/Suggestions report
template, "no new libraries", the Job Context block and the Red Flags rows about
ingestion. The rule `mobx-store-template.mdc` stays and is the source for most rows
above.

## Result

| Profile | Checks | Covered | Moved | Not placed |
|---|---|---|---|---|
| code-ai-review | 17 | 17 | 0 | 0 |
| code-style-review | 26 | 24 | 2 (S8, S13) | 0 |
| code-mobx-store-review | 33 | 31 | 2 (M7, M30) | 0 |
| Total | 76 | 72 | 4 | 0 |

Lines added to surviving reviewers: `review-frontend` +4 (B4 checklist and flag, Part
C checklist and flag; the M7 change is in place), `review-style` +1. Their length
ceilings in `skill-length-ceilings.ts` were raised by exactly those lines (607 to
611, 353 to 354).
