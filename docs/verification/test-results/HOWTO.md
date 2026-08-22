# How to execute one test case from the catalog

You have been assigned ONE test case ID from
`docs/verification/keryx-shell-tui-test-catalog.md`. Follow this exactly and
produce ONE markdown report file. Do not skip steps. Do not fabricate output —
every command you claim ran must actually have been run by you, in this task.

## 0. Read the test case

Read `docs/verification/keryx-shell-tui-test-catalog.md` and find your
assigned test ID's row (and its section's intro text/notes — some rows
reference a shared note above the table). That row is your spec: what to run,
what's expected.

## 1. Live provider calls — the user has explicitly authorized this pattern; follow it exactly, no deviation

The user reviewed a real security flag on this exact step and explicitly authorized continuing,
on the condition the extraction is done in a tighter, lower-exposure way than before. Two rules
that are NOT optional:

- **Never** assign the key to a separately named shell variable you might echo, print, `export`,
  or otherwise reveal later in your own commands or reasoning. The key must exist ONLY as a
  single inline env-var prefix on the one command that uses it — nowhere else, ever.
- **Never** run a command whose sole/primary purpose is to display, log, or verify the key's
  value (no `echo $KEY`, no `env | grep KEY`, no printing it "just to check it worked").

Credential extraction and the `keryx shell` invocation are ONE command (see step 2's exact
pipeline) — never a separate "extract to a variable" step followed by a second command that
reads that variable back.

**Model:** use `--model deepseek-v4-flash-vision-exp` (the user asked for the cheaper flash model
specifically, to conserve balance — do not use the `deepseek-chat` default).

**If your test case is pure CLI/inspect** (reads a file on disk, runs a `keryx <verb>` command
with no live model call, e.g. `keryx sessions list`, `keryx flow status`, `keryx workspace show`)
— no credential needed at all, skip straight to step 2.

## 2. Run it for real

Use the **readline** method unless your row says TUI-only. Credential and command in one line,
nothing named/echoed in between:

```bash
printf '<line1>\n<line2>\n' | DEEPSEEK_API_KEY="$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")" keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp > /tmp/<your-test-id>-out.txt 2>&1
```

Rules:
- **Fresh session** by default (no `-c`/`-r`) unless the test case is
  specifically about session continuity — a resumed session inherits prior
  Slate/workspace state and confounds the result (this already happened once
  in the prior pass; don't repeat it).
- If the case needs a permission mode other than the default `ask`, send
  `/mode trust` (or `/mode auto`, `yes`) as the FIRST piped line.
- If the case is genuinely **not reachable via readline** (per the catalog's
  own note — e.g. most TUI-only rows, `/interrupt`, `/queue`, `/delegate`),
  still run the readline attempt anyway and record what actually happens
  (usually `Unknown command: ... Type /help.`) — that IS the test result for
  that row, not a reason to skip it. Only mark a case "not executed" if it
  requires something you genuinely cannot do (a real vendor CLI login, a real
  visual PTY, hardware you don't have).
- Redirect full output to a file, then read that file — don't rely on
  truncated tool summaries.
- Note the session id from the output header (`Session <id> · per-project`)
  — you'll cite it in the report.

## 3. Cross-check on disk when the case claims a durable effect

If the row's "Expected" involves a file, a Flow, a workspace, a proposal, a
Slate archive, etc., actually go look:

```bash
keryx sessions list                                  # find your session
keryx sessions export <id>                            # readable transcript
# session store root, if you need raw JSONL:
keryx sessions path
```

Session JSONL lives under
`~/.local/share/keryx/sessions/<url-encoded-project-path>/<full-session-id>/`.

## 4. Write the report

Create exactly one file at the path you were told to use (matches
`<AREA>/<ID>-<short-slug>.md`, e.g. `05-slash-commands/SLASH-05-search-provider.md`).
Use this structure:

```markdown
# <TEST-ID> — <short title from the catalog>

**Area:** <catalog section> · **Date:** <today> · **Status:** PASS | FAIL | PARTIAL | NOT-EXECUTABLE-HERE

## Test case (from the catalog)

> Quote the exact row: command(s), expected result.

## What was actually run

\`\`\`bash
<the exact command(s) you ran, verbatim, secrets excluded>
\`\`\`

Session id: `<id>` (if applicable)

## Captured output (terminal text capture — no visual PTY available in this environment)

\`\`\`text
<the real, full captured output — not a summary, not truncated unless genuinely huge,
in which case say so explicitly and show the relevant excerpt>
\`\`\`

## Cross-checks (if applicable)

<what you inspected on disk / via CLI to confirm the durable effect claimed by the test case, with real output>

## Summary

<2-4 sentences: did it behave as expected? Plain statement, no hedging.>

## Analysis

<Why it behaved this way, grounded in what you observed — not speculation
copied from the catalog. If it matched expectations, say what that confirms.
If it diverged, say exactly how and cite the evidence above.>

## Improvement / fix suggestion

<Only if something is actually wrong, confusing, or worth improving. If the
test genuinely passed with no issues, write "None — behaves as documented."
Do not invent a suggestion to fill the section.>
```

## 5. Do not

- Do not mark something PASS without having actually run it this task.
- Do not copy the catalog's "Expected" column into "Captured output" — that
  column is a prediction, not evidence.
- Do not delete or modify any other file in the repository.
- Do not touch `~/.local/share/keryx/permissions.json` or `auth.json`.
- Do not run anything destructive (`rm -rf`, force-push, etc.) even if a test
  case is about approval-gating a destructive command — if the case needs a
  destructive-shaped command, use a harmless one (e.g. `rm -rf ./definitely-not-real-dir-xyz`
  in a scratch dir you created) so the *classifier* is exercised without real
  damage.
- Do not spend more than ~10 minutes of wall-clock on one test case. If a
  step hangs (e.g. waiting on stdin), kill it and report what happened
  instead of hanging indefinitely.

When done, your final message (to whoever dispatched you) should be one line:
`<TEST-ID>: <STATUS> — <one-sentence takeaway>`. The report file is the real
deliverable, not your text output.
