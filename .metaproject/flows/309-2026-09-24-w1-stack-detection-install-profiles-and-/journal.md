# Flow Journal

- 2026-09-24T04:09:00.843Z - flow created
- 2026-09-24T04:13:34.163Z - task-added: T5: Lane A: keryx stack detect (src/stack/, command, persistence, determinism)
- 2026-09-24T04:13:34.251Z - task-added: T6: Lane B: install manifest, plan/apply, install-state, doctor, uninstall
- 2026-09-24T04:13:34.341Z - task-added: T7: Lane C: governance gates scout/eval/stocktake + authoring lint + metadata.origin
- 2026-09-24T04:13:34.435Z - task-added: T8: Lane D: minimal python stack pack + stack-pack guard tests (paths/extends, scout record, eval-for-stable, export limits)
- 2026-09-24T04:13:34.528Z - task-added: T9: Verify: stack detect twice offline on fixture repo, identical output (Wave-2 exit)
- 2026-09-24T04:13:34.615Z - task-added: T10: Verify: scout/eval/stocktake run on the existing bundled catalog; record outputs in journal
- 2026-09-24T04:13:34.707Z - task-added: T11: Docs: W1 spec status + CLI help for stack/skills commands
- 2026-09-24T04:13:42.201Z - task-done: T2: Implement per plan
- 2026-09-24T04:13:42.283Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-24T04:13:42.364Z - task-done: T1: Collect remaining context
- 2026-09-24T04:13:42.449Z - frozen: 15 criteria; checksum recorded
- 2026-09-24T04:13:42.534Z - started
- 2026-09-24 - completion_outcome=create-pr-and-merge, operator_confirmed=true, base_branch=feat/agent-platform-expansion: answered by the dispatch from the program orchestrator on behalf of MrCipherSmith (flow-runner brief).
- 2026-09-24 - Decisions: (1) stack.json `detectedAt` is preserved when the input fingerprint is unchanged so re-runs are byte-identical (Wave-2 exit); (2) manifest install path triggers on new flags or manifest-only profile ids, legacy `--profile minimal|recommended|full|custom` without new flags unchanged; (3) v1 install destinations only for targets `claude` and `keryx-shell`, others fail the plan with a named reason; (4) stack-aware profiles reuse EXISTING bundled content (react/nestjs/mobx review skills + rules); one new experimental `python` pack exercises the gates; (5) no mass edit of 72 skills for metadata.origin; lint strict on stack content only; (6) eval behavior scenarios need an explicit runner capability, otherwise reported not-run (honest), trigger evals are deterministic.
- 2026-09-24 - AC frozen (15 criteria); T2/T3 closed as skipped (superseded by lanes T5-T8).
