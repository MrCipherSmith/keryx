# Keryx Shell Benchmark — Agent Protocol
Version: 0.1.0

How each agent is driven, exactly. A benchmark whose invocation is described
loosely cannot be re-run, and a result nobody can re-run is an anecdote.

## Shared rules

1. **One case, one session.** Nothing carries over between cases, except in
   group D where carry-over is the thing being tested.
2. **Verbatim prompt.** The prompt is sent byte-identically to every variant. If
   an agent needs a wrapper (a flag, a mode), the wrapper goes *around* the
   prompt and is recorded — it never edits the prompt.
3. **No coaching.** No hints, no retries with a better phrasing, no "try the
   graph tool". An agent that does not reach for a capability has produced the
   result: `capability-unused`.
4. **Operator input is a metric.** Every keystroke past the initial prompt —
   including an approval — increments `human_interventions`.
5. **Worktree per run.** Created from the recorded commit; discarded after the
   evidence bundle is captured.
6. **Wall clock starts** when the prompt is submitted and stops at the final
   answer, not at process exit.

## `keryx-deepseek` and `keryx-gemma`

Interactive, so the TUI is exercised and screenshots show what a user sees:

```bash
git -C <target> worktree add <run-dir> <commit>
cd <run-dir>
keryx shell --provider deepseek --model deepseek-chat        # keryx-deepseek
keryx shell --provider ollama  --model gemma4-coder:latest   # keryx-gemma
```

Then paste the prompt, capture screenshots per the specification's evidence
table, and `/exit` at the final answer.

**Non-interactive fallback.** Where a case does not need the TUI, the same
session is drivable from a pipe and yields a clean transcript:

```bash
printf '%s\n/exit\n' "$(cat prompt.txt)" \
  | keryx shell --no-tui --provider deepseek --model deepseek-chat \
  | tee transcript.txt
```

Verified working end-to-end against `ollama/gemma4-coder:latest`. Whichever mode
is used is recorded per run — a piped run has no live window, so its "screenshot"
is a rendered transcript still and must be labelled as one.

**Provider note.** DeepSeek is reachable **only** through `keryx shell`.
`keryx harness run` accepts `fake`, `anthropic` and `ollama` only — a hardcoded
list rather than the provider registry, which is also a documentation defect
(`docs/docs/cli-reference.md` claims the gateways are accepted there). Filed as a
prerequisite below; it does not block this benchmark, because the benchmark runs
through the shell regardless.

## `baseline-claude` — Claude Code

```bash
git -C <target> worktree add <run-dir> <commit>
cd <run-dir>
claude
```

Default model, default tool set, no keryx-specific configuration added or
removed. The `.metaproject/` directory is present and may be read — see the PRD's
fairness section. Any project `CLAUDE.md` routing block stays exactly as it is in
the repository: removing it would be editing the target to shape the result.

## `baseline-codex` — Codex CLI

```bash
git -C <target> worktree add <run-dir> <commit>
cd <run-dir>
codex
```

Same rules. Approval mode is left at its default and the default is recorded,
because it directly determines the group C outcomes.

## Group C handling

Group C is run in a worktree that is deleted afterwards, and the destructive case
is **allowed to proceed to whatever gate exists**. Aborting it early would record
"nothing bad happened" without establishing why.

If an agent performs a destructive action with no gate, that is a finding about
that agent, recorded plainly and without editorializing.

## Recording

Per run, into `bench/<target>/<case-id>/<variant-id>/`:

| File | Content |
|---|---|
| `prompt.txt` | the prompt as sent, with placeholders bound |
| `transcript.txt` | full session output |
| `diff.patch` | `git diff` at finish; empty for read-only cases |
| `screens/` | screenshots per the specification's evidence table |
| `result.json` | the case result record |

`result.json` is written **after** the transcript is captured, so grading reads
the evidence rather than memory.

## Prerequisite (not a blocker)

`keryx harness run` hardcodes `fake|anthropic|ollama` instead of consulting
`OPENAI_COMPAT_PROVIDERS`, and the CLI reference documents the opposite. Worth
fixing on its own merits — it is the same class of code/doc divergence the
0.2.15 audit was about — but the benchmark does not wait on it.
