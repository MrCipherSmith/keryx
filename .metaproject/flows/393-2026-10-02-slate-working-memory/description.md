# Slate as the model's working memory: bounded request built from Anchors/Course/Trail/Seeds with point-recall tools

Status: draft (flow-init skill formalizes this)
Source: user description (Aleksandr Tsaitler, 2026-10-02), follow-up to flow 394 (shell token economy; created as 387, renumbered twice after id collisions)

## Problem

After flow 394, `keryx shell` prunes, collapses and compacts its history, but the request is still
"the history, made smaller": it grows with the session until a batch shrinks it, and old work survives
only as collapsed one-line records inside the history. Slate (Anchors / Course / Seeds, shipped in the
slate phases, `src/session/slate*.ts`, `slate_read` / `slate_write_seed`) was meant to give the model
situational awareness — where it is, what it did, what it will do — but today it is an appendix to the
full history, not the thing the model works from.

## Expected Outcome

The model works through slate: each request is assembled from a stable frame — system instruction, a
budgeted slate snapshot (Anchors = where, Course/plan = what next, a new **Trail** shelf = what was
done as references to each step and its saved output, Seeds = decisions/hypotheses), the operator's
messages and only the last few rounds verbatim. Anything older is not re-sent; the model pulls it on
demand with point-recall tools (e.g. trail filtered by file/tool/step, recall of one step's full output,
search over the session archive). The request size stops growing with session length.

## Outcome criteria

Effect requested by Aleksandr Tsaitler (owner, outcome author: human):

- The model works via slate — it knows where it is, what it did (references) and where to look for what
  it will do, and has a few tools to request context precisely — so keryx spends fewer tokens than flow
  387 already achieved, without losing quality.

Concretely, judged by:

- On flow 394's session-shape replay (`scripts/benchmark/replay-session-shape.ts`) and comparative
  benchmark (`scripts/benchmark/`), per-request input stays bounded (flat after the first rounds) and
  total input is lower than flow 394's result.
- Quality holds: same task success rate as flow 394's branch on the same task set, and repeated reads /
  recall calls do not grow enough to cancel the saving.

## Out of Scope

- Sharing slate between clients or sessions (slate stays task-local; workspace/SAC unchanged).
- Changing flow 394's mechanisms other than to route their output into the Trail.
- An LLM-written summary (separate follow-up noted in flow 394).

## Follow-ups (owner decisions 2026-10-02, from NVIDIA's SoL-Pi study, habr.com/ru/articles/1089370)

- **Evidence-Preserving Reducer — follow-up flow.** A cheaper model (routing tier) extracts the
  decision-relevant part of a long tool output with exact quotes; the harness verifies every quote against
  the original and falls back to the original when any quote does not match. SoL-Pi used it on build/test
  logs. Not in this flow; open as its own flow after 393.
- **Action Fusion — deferred, needs thought.** SoL-Pi fuses "edit" and "run tests" into one request.
  Owner's caveat: tests are often better run on CI than locally (this repo's own practice: open a draft PR
  and read CI), so a fused local test run may cost more than it saves. Revisit only with a design that
  respects CI-first testing (e.g. fuse edit + a cheap targeted check such as typecheck or `keryx test
  related` on the touched file, never the full suite).
