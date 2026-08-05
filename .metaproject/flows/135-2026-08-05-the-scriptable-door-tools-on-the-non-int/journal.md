# Flow Journal

- 2026-08-05T19:40:27.454Z - flow created
- 2026-08-05T19:41:04.453Z - task-added: T5: T1 register read-only tools on harness run
- 2026-08-05T19:41:04.540Z - task-added: T6: T2 provider validation from OPENAI_COMPAT_PROVIDERS
- 2026-08-05T19:41:04.630Z - task-added: T7: T3 stop defaulting to an undeclared model id
- 2026-08-05T19:41:04.714Z - task-added: T8: T4 tests
- 2026-08-05T19:41:04.800Z - task-added: T9: T5 CLI reference correction and draft PR
- 2026-08-05T19:41:52.137Z - frozen: 7 criteria; checksum recorded
- 2026-08-05T19:41:52.223Z - started
- 2026-08-05T19:52:39.407Z - task-done: T1: Collect remaining context
- 2026-08-05T19:52:39.504Z - task-done: T2: Implement per plan
- 2026-08-05T19:52:39.604Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-05T19:52:39.706Z - task-done: T5: T1 register read-only tools on harness run
- 2026-08-05T19:52:39.800Z - task-done: T6: T2 provider validation from OPENAI_COMPAT_PROVIDERS
- 2026-08-05T19:52:39.896Z - task-done: T7: T3 stop defaulting to an undeclared model id
- 2026-08-05T19:52:39.994Z - task-done: T8: T4 tests
- 2026-08-05T19:58:16.722Z - task-done: T9: T5 CLI reference correction and draft PR
- 2026-08-05T19:58:16.819Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-05T19:58:36.833Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/252

## Review round 1 — CHANGES REQUESTED on PR #252 (no blocker)

Seven findings fixed, one decision taken. Recorded here rather than only in the
PR because two of them are corrections to claims this flow itself made, and a
flow opened to stop documentation over-promising should keep the record of
having done it twice.

- **A new over-promise in the file AC4 names.** The reference said the
  non-interactive door "reaches the same project knowledge the TUI does". It
  does not: `runOffline` takes one provider turn and never returns a tool result
  to the model. The PR body said so honestly while the shipped page said the
  opposite. Corrected, and pinned by a test that fails if the sentence returns.
- **A containment claim that was not enforced.** "ollama (loopback)" was
  documentation, not behaviour: `--base-url https://public-host/` passed the
  credential gate and the provider's egress guard, which rejects private hosts
  but not public ones. Now enforced (`refuseBaseUrl`).
- **A tautological AC5 test guarding dead code.** It asserted `models[0]` was in
  `models`, through a helper with no production caller. Replaced with an
  assertion over `defaultModelFor`, the resolver production actually uses; the
  helper is deleted.
- **Unearned freshness dates.** Seven `modelsVerified` strings claimed
  2026-08-05 for lists last changed 2026-07-20 and untouched by this work. The
  field is now a struct — source, `listedOn`, `checkedAgainstProvider` — dated
  from the commits that established each list, with only DeepSeek claiming a
  check. A boolean is harder to write inattentively than a date.
- **A credential could be redirected.** `--base-url` with a registry provider
  sent that provider's Bearer key to an arbitrary host — pre-existing in the
  shell, newly reachable here because this flow widened the accepted set.
  Refused, with a test per registry provider.
- **A false comment.** `run.ts` claimed neither live adapter had ever received
  `request.tools`; `commands/agent.ts` sets it. The true statement is narrower:
  `runOffline` never set it.
- Nice-to-haves taken: the documented 12-tool list is now asserted against
  `METAPROJECT_OPERATIONS`, the redaction branch on the tool-output path has
  tests (masked and scan-failed), and the benchmark protocol no longer tells a
  runner to pass `--model deepseek-chat`, the alias D5 removed.

**Decision — tool registration is opt-in (`--tools`), default OFF.** With a real
provider the command was advertising twelve tools whose results the single-turn
loop can never return, so a model that stops on a tool call answers worse than
one told about no tools at all — a regression on the default path, for exactly
the prompts tools were meant to help. Agreed with the reviewer's call. The flag
is documented with the reason and the default flips when the loop takes a second
turn.

**Effect on AC1, stated rather than reinterpreted.** The frozen criterion reads
"`keryx harness run` registers the read-only metaproject tools". It now does so
when asked (`--tools`), not unconditionally. The criterion is NOT edited — an
implementor does not rewrite the target after aiming at it. Whether a flag-gated
registration satisfies AC1 is the reviewer's call to make at completion, with
the shortfall in front of them.
