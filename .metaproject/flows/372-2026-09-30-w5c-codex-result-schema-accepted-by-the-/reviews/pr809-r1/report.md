Review of PR #809: no fail-open path for an invalid result found (I probed it), but one exit-code regression can mask a real child failure. There is also a null-drop hole, a codex blocker/major finding dead end, a 2s to 10s settle latency change, and test gaps.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow372-pr809-review",
    "severity": "major",
    "problem": "On a `terminal` verdict the exit code is now ALWAYS derived from the transcript (`exitCodeFromEvents`), discarding a real exit code that the child had already delivered before our kill. `reportedExitCode` is set when `child.exited` resolves; if the child exits non-zero (crash or failure in teardown, post-turn hook, write-mode cleanup) after emitting `child_finished` while a pipe stays open (grandchild holding it), the verdict is `terminal` and the genuine non-zero code is replaced by 0. The old `code ?? exitCodeFromEvents` only fell back when no code arrived; the new line also overwrites a real code. The PR's reason (143 comes from OUR SIGTERM) only holds for a code produced by the kill, not one observed before it.",
    "impact": "`classifyCodexFailure` short-circuits to success on `exitCode === 0` plus `child_finished`, so a child that genuinely failed after its terminal event is reported Completed. In write mode (codex) this feeds the landing/approval path with a run whose process failed.",
    "suggested_fix": "Snapshot `reportedExitCode` before `handle.kill()` (e.g. `const exitedBeforeKill = reportedExitCode;`) and use `exitedBeforeKill ?? exitCodeFromEvents(events)` in the terminal branch, ignoring any code that arrives during the kill grace. Add a test: terminal event, child exits 2 before settle with pipes held open, expect exitCode 2 and a non-null classification.",
    "evidence": "Read supervise.ts 513-581: `reportedExitCode` is assigned in the `exited` then-handler; the `terminal` branch at 580 returns `build(exitCodeFromEvents(events), false)` ignoring both `code` and `reportedExitCode`. supervise.test.ts only covers exit 143 produced after our kill (holdExit / exitCode 143 with held stdout); there is no test for a non-zero code delivered before the kill.",
    "confidence": "medium",
    "file": "src/harness/external/supervise.ts",
    "line": 580,
    "quote": "  return build(exitCodeFromEvents(events), false);",
    "class_scope": {"sites": ["src/harness/external/supervise.ts"], "enumeration_method": "keryx ctx rg for exitCodeFromEvents and reportedExitCode in src/harness/external; only the terminal branch of superviseExternalRun overwrites a delivered code"}
  },
  {
    "id": "F-002",
    "reviewer": "flow372-pr809-review",
    "severity": "minor",
    "problem": "`dropNulls` removes a null for ANY key not in the original `required` set, including keys that are not declared in the original `properties` at all. A document carrying an undeclared key with a null value (`{..., \"bogus\": null}`) is silently cleaned and then validates, although the original schema has `additionalProperties: false` and forbids it. The drop should apply only to keys that are declared properties.",
    "impact": "A genuine additionalProperties violation is hidden. Practical risk is low (codex's constrained decoding should not emit unknown keys, and the value is null), but it is a hole in the 'validation against the full unchanged contract stays fail-closed' guarantee; for a nested object it also applies to extra keys with null.",
    "suggested_fix": "In `dropNulls`, only skip when `child === null && !required.has(key) && key in schema.properties`; leave undeclared keys in place so the full schema rejects them. Add a test.",
    "evidence": "Wrote and ran a probe under the scratchpad: for a full document plus `bogus: null`, `validateJson(dropOptionalNulls(d, schema))` returned [] while `validateJson(d, schema)` returned [{path:'$.bogus', message:'Additional property is not allowed'}].",
    "confidence": "high",
    "file": "src/harness/external/strict-schema.ts",
    "line": 123,
    "quote": "    if (child === null && !required.has(key)) continue;"
  },
  {
    "id": "F-003",
    "reviewer": "flow372-pr809-review",
    "severity": "major",
    "problem": "The strict transform drops the root `if/then` in review-finding.schema.json (severity blocker/major requires `class_scope`) and makes `class_scope` nullable, with all `description`/`title` guidance stripped too. A codex result that reports a blocker/major finding while emitting the natural strict-shape `class_scope: null` is normalised to an absent `class_scope` and then fails full validation ('Missing required property'). The strict copy therefore permits (and the model is never told about) a shape the full contract rejects, so any codex result with a major/blocker finding turns into Status Error unless the model happens to fill class_scope. Same for `disposition`/`verification`/`locator` `if/then/else` constraints (for example `locator.state: derived` without `method`).",
    "impact": "Fail-closed (not a security hole), but a functional dead end: codex review-style dispatches that find a blocker or major will fail AC13 validation instead of being accepted, and the model has no schema-level signal. The original schema text is in the prompt (`resultSchemaText`), which only partially mitigates this.",
    "suggested_fix": "Keep the conditional requirement expressible in the strict copy where possible: e.g. express `class_scope` as required-nullable but document it in the prompt, or emit findings per-severity with `anyOf` branches (`{severity: enum[blocker,major], class_scope: object}` | `{severity: enum[minor,info], class_scope: object|null}`) which the strict subset allows. At minimum add a test with a major finding and document the limitation.",
    "evidence": "Ran a probe against the real bundled schemas: a finding with severity 'minor' and every optional field null validates after `dropOptionalNulls` (returned []), but with severity 'major' and class_scope null validation returned [{path:'$.findings[0].class_scope', message:'Missing required property'}]. Read review-finding.schema.json 198-202 (root if/then requiring class_scope).",
    "confidence": "high",
    "file": "src/harness/external/strict-schema.ts",
    "line": 75,
    "quote": "      properties[key] = required.has(key) ? strict : makeNullable(strict);",
    "class_scope": {"sites": ["src/harness/external/strict-schema.ts", "src/gdskills/contracts/review-finding.schema.json"], "enumeration_method": "keryx ctx rg for if/then/allOf in the two bundled contract schemas; the only conditional constraint reachable from a codex result is the root if/then of review-finding (class_scope)"}
  },
  {
    "id": "F-004",
    "reviewer": "flow372-pr809-review",
    "severity": "minor",
    "problem": "DEFAULT_TERMINAL_SETTLE_MS is a global constant for every agent, raised 2s to 10s. The `terminal` verdict is the normal exit path for any child that emits its terminal event but never closes its pipes or exits, notably a steerable claude run (`stdin: \"pipe\"`, stream-json input, which the supervisor never closes) and any CLI with a lingering wrapper. Each such run now waits 10s instead of 2s after its final event before the kill. Also, a wall-clock `timeoutMs` that lands inside the widened window after a terminal event now yields `timedOut: true` (Timeout) for a run whose transcript already finished, and that window grew 5x.",
    "impact": "Up to +8s latency per steerable/hung-pipe run for claude, antigravity and gemini, none of which needed the codex write-mode teardown budget; a slightly larger window in which a finished run can be reclassified as Timeout.",
    "suggested_fix": "Keep the 2s default and let the codex write-mode path pass a larger `terminalSettleMs` (it is already a per-input option, `input.terminalSettleMs`), or derive it from the agent entry. If the global raise is intended, add a test/comment stating the steerable case was considered.",
    "evidence": "Read supervise.ts 188, 292-296 and 476-480: the settle timer starts on the first terminal event and races the drain; stdin is only ever closed by the port for `\"ignore\"`, never after a `\"pipe\"` run's terminal event. The only test that touches the settle uses `terminalSettleMs: 15`, so the 10s default is untested. I did not run a live steerable claude process, so the extent of the lingering is inferred from the code (medium confidence).",
    "confidence": "medium",
    "file": "src/harness/external/supervise.ts",
    "line": 296,
    "quote": "export const DEFAULT_TERMINAL_SETTLE_MS = 10_000;"
  },
  {
    "id": "F-005",
    "reviewer": "flow372-pr809-review",
    "severity": "minor",
    "problem": "Test gaps: (a) the 'real subagent-result schema' test only uses `findings: []`, so the nested review-finding schema (root if/then class_scope, disposition/verification/locator conditionals, anyOf-free but deeply optional objects) is never exercised through the strict transform plus normalise plus full validation; (b) no test covers a non-zero exit code delivered before our kill on the terminal path (F-001); (c) no test for undeclared-key nulls (F-002); (d) `finalMessageOnly` is only exercised via codex; there is no test asserting claude/antigravity/gemini outputs are unchanged by the joined-text path, and no test for a codex transcript whose last assistant_text is empty/whitespace (falls back to an earlier narration message and would pass as the answer); (e) the strict schema is never checked against an actual OpenAI strict-mode rule set, only against the PR's own predicate ('every object closed and fully required').",
    "impact": "The areas most likely to regress (nested findings, exit-code semantics, answer selection) have no coverage, which is how F-001 to F-003 slip through.",
    "suggested_fix": "Add tests with a populated findings array (minor and major), a terminal-path non-zero exit, an undeclared-null key, and a codex transcript ending in an empty agent_message.",
    "evidence": "Read strict-schema.test.ts (findings: [] at line 130; helper replaces `findings` by the raw finding schema) and supervise.test.ts 308-353; ran probes showing F-002 and F-003 are not caught by the existing suite.",
    "confidence": "high",
    "file": "src/harness/external/strict-schema.test.ts",
    "line": 130,
    "quote": "      findings: [],"
  }
]
```
