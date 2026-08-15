# Plan

## Approach

After the host exists: add slash tokens, TUI handler that calls `openModal`
with Session + Usage tabs, readline text dump, clipboard via existing
`/copy`/OSC-52 path. TDD via `shell-slash-registry.test.ts` plus host tests.

Rejected: implementing a second `overlayBox` inspector. Rejected: inventing
Grok-only fields.

## Tasks

T1 context — confirm host API landed; stack if needed.
T2 test — slash registry + inspector field tests first.
T3 implement — commands + tab bodies + readline dump.
T4 review — verifier + review-orchestrator; fix before PR.
T5 verify — focused tests; mid-turn does not stream.

## PR

Draft PR `feat/tui-session-info` → `main` (or stacked onto modal-tabs PR).
