# W3: self-learning loop — observe, extract, consent-gated learned patterns, reviewer profiles, promote and graduate

Status: formalized (flow-orchestrator, 2026-09-24)
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W3-self-learning.md (v0.1.3), wave 3 of the agent-platform-expansion program.

## Problem

Keryx learning today is command-invoked and isolated: `skills learn` proposes
and `applyLearningProposal` applies, and `review learn` turns configured
reviewers' comments into project-skill lessons. Nothing observes what happens
during a session, nothing extracts repeated signals deterministically, the
confidence model is a 3-value enum that never moves, there is no notion of
"the same project" across clones, and there is no bounded, human-confirmed path
from a candidate pattern to a skill, agent, rule or cross-project (user-scope)
pattern. W6 shipped a `keryx.learning-observer` built-in hook whose sink is a
no-op; W5 shipped the harness registry with an `observe` flag nobody feeds.

## Expected Outcome

- Observe: a real `LearningObservationSink` writes bounded (200-char previews,
  5000 events/day), redacted (security check-output), TTL'd (30 days) JSONL
  lines per the C-14 event mapping under
  `.metaproject/data/learning/observations/<date>.jsonl`, wired into the keryx
  shell hook runtime, plus an opt-in host-harness observer (Claude Code) through
  the W5 registry. Hash-only derived edit fields; never a full transcript.
- Extract: deterministic signals (repeated correction, reverted edit,
  failing→passing test pair, configured-reviewer PR comments, health
  regressions) produce `learned-pattern` candidates with the deterministic
  confidence formula; the model extractor exists only behind an explicit
  capability and ships disabled.
- Consent: `keryx learn list|review|accept|reject|prune|observe|extract`;
  `accept` is the only path to `accepted` and records the human decision;
  accept/promote refuse a non-TTY context with no bypass flag.
- Apply: `keryx learn apply <id>` renders a `LearningProposal` and calls
  `applyLearningProposal`; `keryx review learn --reviewer <id>` writes
  `.metaproject/rules/reviewers/<id>.mdc` (generalized, unattributed).
- Promote: ≥2 distinct project identities at indexed confidence ≥0.8 in
  `~/.keryx/learning/index.json`, interactive confirm, writes a user-scope
  candidate.
- Graduate: proposals only; W1 scout `--record` gains learned origin; W2 agent
  candidates `.metaproject/agents/<name>.md` (origin.kind learned) behind a
  separate consent-gated apply.
- D-3: `skill-lifecycle.mdc` (project + bundled copy) amended.
- Wave-3 exit criterion proven by a guard test: no learned pattern can reach
  `accepted` without a recorded human accept action.

## Out of Scope

- W4 bundles (`keryx bundle *`) and the rest of the `~/.keryx` layout (flow 313).
- Renaming / editing bundled agents in `src/gdskills/bundled/agents` (flow 311).
- A shipped model-backed extractor implementation (only the capability gate/port).
- Host observers for harnesses other than Claude Code (recorded as follow-up).
- Graduation apply for skill and rule targets beyond the W1 scout record step
  (SKILL.md / rule writes stay with their own human-run commands).
