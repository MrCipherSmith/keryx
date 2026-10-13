# Flow 415 — AC12: installed-release operator checklist

Status: NOT EXECUTED / AC12 OPEN. This checklist does not confirm acceptance.
Do not edit frozen acceptance-criteria.md. Operator confirmation is separate from CI.

## 0. Release and safe setup

- [ ] PR996 (or a reviewed successor) merged; final implementation SHA, main gates,
  release tag and published npm version recorded. Current candidate: PR996
  `94302b72fe572c816bd24fa113d104ebf20d4433` — not a released artifact.
- [ ] Install the published release using the operator's normal installation method.
  Record `command -v keryx`, `keryx -v`, OS, shell, date and installed package
  provenance. Test the installed executable, not `bun src/...` or a worktree build.
- [ ] Use a disposable project and test workspace with no secrets or production
  changes. Record project/data-directory paths; keep KERYX_DATA_DIR consistent
  across shell, restart and retry if overridden. Save transcripts securely.
- [ ] Bind the shell to the intended test workspace through its supported binding
  workflow; verify the binding with workspace_show. A local unbound snapshot is
  not a successful workspace-delivery test. Record initial pending proposal IDs
  and accepted items; do not accept test proposals during the scenarios.

## 1. Normal exit — Notes without Seeds

- [ ] Start installed `keryx shell`. Record session ID and an identifiable harmless
  marker, e.g. AC12-NORMAL-<timestamp>.
- [ ] Ask the agent to call slate_note with that marker and a concrete result;
  record a successful read-only tool outcome. Do not add Seeds for this scenario.
  Verify the note exists and the session has zero Seeds before exit.
- [ ] Exit via /exit. After alternate-screen restoration, capture stderr progress:
  saving started, truthful local/proposed/deferred/failed outcomes and recovery
  reference. Do not infer delivery merely from an archived Slate.
- [ ] Restart in the same project. Verify saved history, Notes and tool evidence
  contain the marker, and the original snapshot remains readable.
- [ ] Verify a reviewable proposal OR a named durable deferred/unbound/blocked
  outcome with reason and recovery reference. Resolve binding/policy if needed
  before counting workspace delivery as passed. Accepted items remain unchanged.

## 2. Busy exit — streaming and tool work

- [ ] New session: record AC12-BUSY-<timestamp> in Notes and add one explicit Seed
  for a harmless evidence-backed result. Verify successful scratch-write receipt.
- [ ] Start a sufficiently long response. While tokens stream, request exit using
  the shell's supported busy-exit action or Ctrl+C; record the actual action.
  A Ctrl+C that merely cancels the turn is not itself a shell-exit test: finish
  with a supported exit and record both operations.
- [ ] Repeat while a harmless bounded tool is running (no production changes).
  Record whether the tool finished, was cancelled or remained uncertain.
- [ ] Verify saving progress and bounded shutdown, no false saved-success, and
  successful acknowledged Notes/tool outcomes recover after restart. Compare
  the last received history with the snapshot; do not require unseen tokens or
  invent a successful outcome for an interrupted tool.

## 3. Offline / external-off and recovery

- [ ] New session: record AC12-DEFERRED-<timestamp>, a Note, Seed and tool evidence.
  Turn external off using the supported setting; record the effective policy.
- [ ] Exit and verify local checkpoint survives without external inference.
  Record separate local and delivery outcomes. External off need not prevent
  deterministic local proposals: do not assume it always produces deferred work.
- [ ] Repeat with network unavailable, without deleting credentials or changing
  other sessions. Verify local preservation. If this delivery path is entirely
  local, use a reversible supported delivery-policy refusal to exercise a real
  deferred/blocked case; document the reason. Never bypass ACL/security guards.
- [ ] Restore permitted conditions and restart once. Inspect recovery outcome,
  original snapshot/session identity, proposal IDs and pending group states.
- [ ] From the original project/data directory run:
  `keryx workspace catch-up --retry-preservation --json`.
  Record preservationReplay counts and recovery references. Repeat the command
  and restart again: no duplicate proposal per snapshot/group; completed groups
  are not redelivered. Named security refusals may remain blocked, not lost.
- [ ] For queues larger than the bounded replay pass, repeat until unfinished
  groups have delivered or have explicit documented deferred/blocked outcomes.

## 4. Documentation, evidence and confirmation

- [ ] Installed-release docs describe local checkpoint vs pending proposals vs
  human acceptance, explicit retry, startup recovery, SIGKILL/streaming-tail
  limits and filesystem/storage limitations. Do not promise a SIGKILL finalizer.
- [ ] Keep a scenario table: version/path, session/snapshot IDs, marker, exit
  trigger, expected/actual result, local receipt, proposal IDs/recovery reference,
  retry counts, transcript paths and PASS/FAIL. Redact secrets, not useful IDs.
- [ ] Human reviewer checks all scenarios and records their explicit AC12 verdict.
  Only then attach installed-artifact evidence to flow415 and confirm AC12 using
  the normal flow acceptance process. CI alone must not close this criterion.

