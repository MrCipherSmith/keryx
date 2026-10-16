# Review findings get an independent premise check before anyone acts on them

Status: formalized
Source: owner (origin: human-request)

## Problem

A keryx final review of vantage-frontend #7435 reported "Playback slider pinned LTR": `MultiLayerPlaybackSlider.tsx:150` and `PlaybackHeader.tsx:101` hard-code `dir="ltr"`, so the timeline does not mirror in RTL (issue #7849). The finding was wrong: Material Design and Apple's RTL guidance say media playback controls and timelines do not mirror, and the code carried three signals of a deliberate choice (an explicit `dir="ltr"` override, a lint exemption noted as a "physical-LTR scroll/pixel island", and `MediaPlaybackControls` doing the same). The agent implemented the mirroring (#7908, then #7966); two keryx-style reviews of that fix checked only the implementation (RTL maths, tests, lint) and passed it; a reviewer even noted the inconsistency with `MediaPlaybackControls` and filed it as a follow-up. When a human asked "is this standard practice?", the model refuted the finding at once, and the PR was closed after costing reviewer time and trust.

Verified on 0.3.120:
- The shared reviewer laws (copied into every reviewer `SKILL.md`, enforced by `src/gdskills/review-skills-iron-laws.test.ts`) cover reachability, no theoretical findings and one finding per class. Nothing tells a reviewer that an explicit override, suppression or exemption is a decision whose reason must be read before calling it a defect, or to check a project rule against accepted platform practice and its known exceptions. The finding passed all three laws: the harm (an LTR timeline in Arabic) is reproducible.
- `review-layout` § "Logical properties and RTL" lists what must flip and nothing that must not.
- `review-verifier` confirms a finding when its procedure "reproduced the defect" (`review-verifier/SKILL.md:127`). A fact ("`dir="ltr"` is hard-coded") always reproduces; whether it is a defect at all is asked by no role.
- A fix round treats the finding's premise as settled: flow-orchestrator treats `suggested_fix` as a hypothesis about HOW, not about WHETHER.

## Expected Outcome

1. Prevention in the reviewers: a fourth shared law — a deliberate choice (explicit override, suppression, exemption, comment or commit giving a reason, a sibling doing the same) is not a defect until its reason is read and shown wrong, and a project rule is checked against accepted platform practice and its known exceptions. `review-layout` names what does not mirror.
2. An independent final check, `review-premise`: after the verifier, on a clean context and without the reviewer's reasoning first, it judges every finding that asks for a behaviour or structure change on intent, accepted practice (platform guidelines, language idioms, clean code, common patterns), consistency and fix soundness, and returns `upheld | downgraded | challenged | owner-decision`. `challenged` and `owner-decision` findings do not block and are not sent to a fixer; they become operator questions (card in keryx shell, question tool elsewhere).
3. The same premise check runs in flow-orchestrator (and the other fix-loop orchestrators) before a finding that changes user-visible behaviour is implemented.

## Outcome criteria

- Запрос: «главное нужно понять почему ревьюер нашел ошибку там где ее нет, и почему в пре было неправильное исправление… Можем ли мы для keryx реализовать дополнительного независимого верификатора, который в самом конце перепроверяет находки на логику, смысл, клинкод, и другие обще принятые паттерны? что бы он находил вот такое»; «может это растет изза того что reviewing не достаточно четко описан?» (claude-code session 2026-10-16, after vantage-frontend #7966)
- Эффект: ложные находки «по правилу, но против практики/намерения» не доходят до исполнителя; вместо неверного фикса оператор получает вопрос.
- Как наблюдать: на эталоне #7849 (playback LTR) review-premise выдаёт challenged/owner-decision; на наборах реальных находок #992/#1005 он не гасит ни одной подтверждённой; владелец видит то же на следующем PR vantage-frontend.

## Out of Scope

- Changing what each reviewer looks for beyond the shared law and the review-layout "does not mirror" list.
- Re-opening vantage-frontend #7966/#7908 (owner already closed and reverted).
