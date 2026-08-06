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

## Review round 2 — CHANGES REQUESTED on PR #252 (no blockers)

Round 1's four must-fixes confirmed by mutation testing, not by reading. Two new
findings, both mine, both the same shape as everything else in this flow.

- **A third doc left asserting the opposite of shipped behaviour, and this flow
  made it false.** `docs/docs/architecture.md` still said "no shipped path
  registers a tool", citing `harness.ts:247` — a line that had moved and now
  reads the opposite. AC4 pins only `cli-reference.md`, and `check:doc-links`
  checks that links resolve, not that claims are true, so nothing caught it.
  Rewritten: the `keryx serve` half is still true, the harness half is not, and
  the stale line number is gone rather than re-pinned.
- **The test guarding against exactly that was a prose grep.** It matched one
  bolded sentence; the reviewer mutated the sentence NEXT to it into the
  opposite claim and got a green suite. Replaced with two assertions over the
  loop: a tool-calling run opens exactly ONE provider stream, and no tool result
  ever appears in the messages the provider receives. Prose can now drift; the
  behaviour it describes cannot drift silently.

Cheap items taken: the blanket `listedOn === "2026-07-20"` pin is gone (it would
have forced the next person refreshing a model list to edit the test policing
provenance — the load-bearing assertion, that a claimed check must cite
evidence, stays); `refuseBaseUrl` now checks the scheme, so `ftp://127.0.0.1/`
is refused; `--tools` reached the other synopses and the `harness.test.ts`
header no longer quotes the three-name provider list.

**F5, redirects — noted, not changed.** Nothing sets `redirect: "manual"`, so a
process listening on loopback could 3xx a run to a public host. The refusal
message was making a claim about the session ("this command will not point it at
a remote host") when it could only honestly make one about the flag; that
sentence is corrected and the residual is written down at the function. Not
fixed here because the fix belongs in `OllamaProvider`, which every
OpenAI-compat gateway shares — pinning `redirect: "manual"` there would break a
legitimate gateway that 3xx-es, and it needs its own tests. Reaching the hole
requires local code execution, and an ollama request carries no credential.

**Not done: `docs/docs/harness.md`.** It never mentions tools on the CLI door
and should. It is in flow 1's reserved file set, and the dispatch says to stop
and report rather than edit one of those. Reported to the coordinator instead.

**Effect on AC1, stated rather than reinterpreted.** The frozen criterion reads
"`keryx harness run` registers the read-only metaproject tools". It now does so
when asked (`--tools`), not unconditionally. The criterion is NOT edited — an
implementor does not rewrite the target after aiming at it. Whether a flag-gated
registration satisfies AC1 is the reviewer's call to make at completion, with
the shortfall in front of them.
- 2026-08-05T20:48:15.862Z - ac-confirmed: AC1: DEVIATION, stated not silent: met behind an opt-in flag. `keryx harness run --tools` registers the read-only metaproject tools and executes them end to end; the default is OFF because runOffline takes a single provider turn, so twelve advertised tools whose results never return degrade the default path. Evidence: harness.scriptable-door.test.ts asserts a scripted graph_affected call runs and its output appears under `tools`; that exactly one provider stream is opened; that no tool result reaches the messages; and that without the flag nothing is registered or advertised. Frozen criterion text unchanged.
- 2026-08-05T20:48:28.075Z - ac-confirmed: AC2: Test iterates OPENAI_COMPAT_PROVIDERS; no literal list in the test. Each declared provider reaches the credential gate rather than the usage message.
- 2026-08-05T20:48:28.236Z - ac-confirmed: AC3
- 2026-08-05T20:48:28.402Z - ac-confirmed: AC4: cli-reference.md corrected in this PR; also architecture.md, modules.md, complete-setup-and-agent-workflows.md and the cli.ts usage line. Tests assert the documented tool list equals METAPROJECT_OPERATIONS (set equality) and that every registry provider is named. check:doc-links exit 0, 639 links, 0 broken.
- 2026-08-05T20:48:28.569Z - ac-confirmed: AC5: Asserted over defaultModelFor, the production resolver, which consults DEFAULT_MODELS before the registry. DeepSeek pinned to the two declared ids. Provenance is structured (source/listedOn/checkedAgainstProvider) with only deepseek claiming a check. LIMIT: no offline test can prove a curated list matches what a gateway publishes today; that is the criterion's escape clause.
- 2026-08-05T20:48:28.733Z - ac-confirmed: AC6: Per-provider abort enumerated from the registry, fetch spy asserts zero calls; credential-free set pinned to exactly [fake, ollama]. Additionally --base-url can no longer redirect a credential-bearing provider. Reviewer verified independently by mutation.
- 2026-08-05T20:48:28.896Z - ac-confirmed: AC7: bun run check exit 0: 3107 pass, 14 skip, 0 fail. The 14 skips are pre-existing; none added or weakened.
- 2026-08-05T22:23:59.803Z - completing
- 2026-08-05T22:23:59.811Z - completion-failed: main-merge: 0c544c2e is not contained in origin/main
