# Grader reliability: rubric LLM judge with anti-gaming tests for skill evals, validated on batch 1

Status: formalized (flow-orchestrator, 2026-09-24)
Source: owner decisions in chat (relayed by the program coordinator); the flow 314 journal follow-up; flow 314 review rounds r1-r3 (R2-6)

## Problem

Stack-pack skill evals (`stacks/*/skills/*/evals.json`) grade behavior scenarios with
string graders (`contains`, `regex`, `not-contains`). Flow 314 showed two ways this goes wrong:

1. Gaming. Skills and graders were tuned to each other, with answer-key phrasing and
   token avoidance, until the eval passed without proving any behavior (review round 1).
2. Mis-specification. An honest DeepSeek run scored 0 on three "don't suppress the error"
   scenarios. Those graders use `not-contains "@ts-ignore"`-style checks, so a correct
   answer that says "do not add @ts-ignore" fails.

The stable-pack gate has three further gaps (R2-6):
- It trusts self-declared provenance: any non-empty runner/model is accepted.
- It ties trigger results only to the skill's own files, not to the catalog they were
  scored against.
- Nothing checks that a skill keeps naming the anti-pattern it forbids.

## Expected Outcome

- An LLM judge grades behavior scenarios against a per-scenario rubric. The judge is
  DeepSeek `deepseek-chat`, called separately from the model under test. Deterministic
  checks remain only for unambiguous facts.
- The judge prompt treats the answer as data and requires a structured JSON verdict.
- Reports record judge provenance and the raw per-trial outputs, so pass counts can be
  re-derived from the artifact.
- The gate pins the runner and the judge to an allowlist and ties trigger results to the
  bundled catalog. A guard keeps skills naming the anti-patterns they forbid.
- Every behavior scenario is proven hard to game. Under the judge, these answers FAIL:
  empty, echo, known-wrong, and two variants of known-wrong (with an injection, and with
  rubric keywords stuffed in). The known-right answer PASSES.
- Batch 1 (18 skills in four packs) is migrated to rubric scenarios and re-run honestly.
  The gate decides stability from the raw outputs only.

## Out of Scope

- Tuning any SKILL.md toward passing. The owner forbids it.
- Batches B2-B6.
- Changing the gate floor (0.8), strictness (high), trials (>=5) or scope (bundled).
- Files owned by flow 315: src/security/audit-harness, src/learning, src/commands/init.ts,
  src/assets, src/gdskills/install.ts, src/lib/*.
