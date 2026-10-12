# PR #788 review — flow 357 (Antigravity CLI external agent)

Scope: security (credential/env leakage, consent/block-list bypass, `--dangerously-skip-permissions`),
logic correctness (event parsing, outcome classification, the widened `agents external run` reaching
codex-cli/claude-cli, the new `DENIED_CAUSE_MARKERS` entries), test quality, AC1-AC8 conformance.

Read the code at worktree `~/keryx-agy` (branch `feat/antigravity-agent`, head
`24d8fe42a969dfc31945f3cdc0e6c86bb0253733`, merge-base `c623d5c8b6a6e39439fc1f64c887f7c9ae591d29`).
Ran the touched test files offline (`bun test`): antigravity codec/runtime/command/capability/env
suites (115 pass) and the pre-existing codex-cli/claude-cli/runtime/run-external-factory/agents-
external-run suites (181 pass) — 0 fail, confirming no regression from the widened `run` command or
the extended `DENIED_CAUSE_MARKERS`.

## What checked out clean

- **Credential handling (AC5)**: `buildExternalChildEnv` strips everything credential-shaped via the
  shared `isDeniedForMcpChild` check; `EXTERNAL_RUNTIME_CREDENTIAL_ALLOW["antigravity-cli"] = []`
  (no exemption — `agy` has no API-key path). Tests exercise Google/OpenAI/Anthropic/GitHub keys
  against an `antigravity-cli` child and assert none reach it; only `HOME`/`PATH` pass.
- **`--dangerously-skip-permissions`**: never emitted on any path (fresh run, resume); asserted by
  multiple tests including one against the real `agy` stderr fixture that itself suggests the flag —
  confirmed the codec's own output never repeats it.
- **`/external` block-list + one-time consent (AC6)**: `checkExternalAgentVendorGates` is the single
  shared gate used by both `keryx agents external run` (`src/commands/agents-external.ts`) and the
  model-initiated path (`src/harness/run-external-factory.ts`); block-list check precedes consent;
  consent is TTY-only and refuses `consent-required` off a TTY; decline records nothing; accept
  persists via a merge-write that never materialises unrelated defaults into the config file. Covered
  end-to-end (command-level and factory-level tests) for both `antigravity-cli` and, negatively, for
  `codex-cli`/`claude-cli` (no consent required, block-list is a no-op).
- **Sandbox scope (AC7)**: `worktree-write` for a line-stream agent (`antigravity-cli` included) is
  refused with `not-implemented` in `dispatch.ts`'s `validateRuntimeBlock`, before any spawn or
  worktree creation; read-only runs in the disposable worktree; no patch artifact.
- **Event parsing/outcome classification (AC3/AC4)**: `parseAntigravityEvents`/`classifyAntigravityFailure`
  replay the real recorded transcripts (`read-only-ok.stream.jsonl`, `tool-denied.stream.jsonl`) and a
  full row-by-row synthetic suite for the AC4 table (WAITING, ERROR/auth, ERROR/other, CANCELED,
  INTERRUPTED, INVALID, timeout, argv-rejected). `SUCCESS` + `denied_actions` correctly produces
  `Denied` naming the denied action, never a plain success.
- **Widened `keryx agents external run` (codex-cli/claude-cli now reachable directly)**: confirmed via
  diff that this only removed the command's own early ACP-only refusal — `runExternalChild` already
  drove both transports. The vendor gate (`checkExternalAgentVendorGates`) runs unconditionally for
  every agent id and is a no-op for ids absent from the block-list/consent-required sets, so nothing
  new is exposed for `codex-cli`/`claude-cli`; `worktree-write` for them is still refused the same way.
- **AC5 second half**: neither the codec, the registry, nor a fake-spawn run's argv/env ever
  references `~/.gemini/antigravity-cli` (asserted directly against the source files).
- **AC8**: live proof fixtures (`fixtures/external/live/antigravity-cli/2026-09-28/keryx-run-ok.*`)
  show a real end-to-end dispatch through keryx's own command, config restored after
  (`externalAgents.enabled`/consent both reverted); `docs/requirements/keryx-antigravity-agent/README.md`
  status line updated to "implemented (read-only)"; `docs/docs/harness.md` and CHANGELOG both describe
  install/consent/data-collection/read-only limit; `package.json` bumped.

## Finding

### [F-001] `DENIED_CAUSE_MARKERS` is one flat, agent-unscoped list, and this PR adds two markers whose wording is specific to antigravity-cli's `WAITING`/blocked-tool vocabulary

- **Severity**: minor

`src/harness/external/runtime.ts:188-202` defines `DENIED_CAUSE_MARKERS` as a single `RegExp[]`
matched in `buildOutcome` (line 681) against the free-text `cause` string returned by **any** codec's
`classifyFailure` — codex-cli, claude-cli, and antigravity-cli alike, with no per-agent scoping. This
PR adds two new entries for antigravity-cli's headless-denial vocabulary:

```
/waiting (for|on) .*(approval|permission)/i,
/blocked (on|waiting) .*(approval|permission)/i,
```

Because the match is against the whole `cause` string (for codex: narrated stdout lines plus
structured `retry`/`child_failed` event text; for claude: `terminal.message` plus `stderr` plus retry
messages), a future codex-cli or claude-cli failure whose vendor-reported text happens to contain
this wording (e.g. a permission-mode denial phrased differently by a newer CLI version) would be
reclassified from `Error` to `Denied` for the wrong reason. This is an extension of a weakness the
module's own comment already documents and accepts ("A known weakness... matching text... a false
positive costs a mislabelled status and never a wrong verdict on a healthy run") — so it is a
deliberate, accepted tradeoff, not a new class of defect. Today it does not misfire: no fixture under
`fixtures/external/` for any agent contains this wording, and the full codex-cli/claude-cli/runtime
test suites (181 tests) pass unchanged. But there is no test that pins this non-interference for the
two *new* markers specifically, so a future codex/claude vendor-text change could regress silently
into a wrong `Denied` label with nothing to catch it.

- **Impact**: a codex-cli or claude-cli run that genuinely errored could be mislabelled `Denied`
  instead of `Error` if the vendor's own error text ever contains "waiting for/on ... approval" or
  "blocked on/waiting ... approval/permission" wording — cosmetic (status label only; `output`/
  `partial` still carry the real message) but could mislead an operator or a caller branching on
  `ExternalCompletionStatus`.
- **Suggested fix**: add one regression test (in `runtime.test.ts` or the codex-cli/claude-cli codec
  tests) asserting a codex-cli/claude-cli failure whose text contains the two new phrases still
  classifies as intended today (documenting the accepted risk), or scope the two new markers to
  antigravity-cli specifically (e.g. codec-supplied marker sets) if the risk is judged worth closing
  now rather than documenting.
- **Confidence**: medium

```json keryx:findings
[
  {
    "status": "DONE_WITH_CONCERNS",
    "reviewer": "flow357-pr788-review",
    "summary": "PR #788 (antigravity-cli external agent, flow 357) is well-built and thoroughly tested against real recorded transcripts; credential stripping, the /external block-list, one-time consent, sandbox-scope refusal and the widened `agents external run` command are all correctly gated and covered end to end. One minor finding: the two new DENIED_CAUSE_MARKERS entries are matched globally across every codec agent, not scoped to antigravity-cli, with no dedicated cross-agent regression test.",
    "findings": [
      {
        "id": "F-001",
        "severity": "minor",
        "file": "src/harness/external/runtime.ts",
        "line": 188,
        "problem": "DENIED_CAUSE_MARKERS is a single flat regex list matched against ANY codec's classifyFailure() cause string in buildOutcome (line 681), with no per-agent scoping. This PR adds two markers (`waiting (for|on) .*(approval|permission)`, `blocked (on|waiting) .*(approval|permission)`) written for antigravity-cli's headless-denial wording, but they apply to codex-cli and claude-cli failures equally.",
        "impact": "A future codex-cli or claude-cli failure whose vendor-reported error text happens to contain this wording would be misclassified ExternalCompletionStatus 'Denied' instead of 'Error', with no current test guarding against that regression for the two new markers specifically.",
        "suggested_fix": "Add a regression test asserting a codex-cli/claude-cli failure containing the two new phrases still classifies as intended, or scope the two new markers to antigravity-cli only.",
        "evidence": "Read src/harness/external/runtime.ts:188-202 (DENIED_CAUSE_MARKERS) and :679-683 (buildOutcome's unscoped match against `cause`). Confirmed no existing fixture under fixtures/external/ (codex-cli or claude-cli) contains this wording via `keryx ctx rg`, and ran `bun test` on src/harness/external/codec/codex-cli.test.ts, src/harness/external/codec/claude-cli.test.ts, src/harness/external/runtime.test.ts, src/harness/run-external-factory.test.ts, src/commands/agents-external-run.test.ts: 181 pass, 0 fail — no current regression, but no test pins the new markers' cross-agent scope either.",
        "confidence": "medium"
      }
    ],
    "stats": { "blocker": 0, "major": 0, "minor": 1, "info": 0 }
  }
]
```
