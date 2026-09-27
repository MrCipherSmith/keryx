---
Title: Code Search Routing Rule
Version: 0.1.0
Type: business-rule
Status: accepted
Summary: "Every text, symbol or pattern search an agent runs over this project's code goes through `keryx ctx rg`, never a bare `rg` or `grep`. A `PreToolUse` hook enforces the rule before the command runs and refuses the raw form with a message naming the routed replacement. The one sanctioned way out is an inline escape marker that states a reason."
---

# Code Search Routing Rule

## Summary

Every text, symbol, or pattern search an agent runs over this project's code
goes through `keryx ctx rg` — never a bare `rg` or `grep`. A `PreToolUse`
hook enforces the rule before the command runs and refuses the raw form with
a message naming the routed replacement. The one sanctioned exception is an
inline escape marker that states a reason.

> **Note on Status:** `Status: accepted` labels the **rule** as currently in
> force. It does not claim that every sentence on this page has been
> independently reviewed. The page was authored from the sources cited in
> each section; questions without a source are marked `unknown` rather than
> answered from the code.

## Scope

**Applies to:**

- Every shell command an agent runs in this repository through a runtime that has the gdctx routing guard installed
- The runtime's own native code-search tool

**Does not apply to:**

- How a human runs commands in their own terminal
- Editing commands — `sed -i` is explicitly exempt because it writes in place and produces no stdout (`classifyCommand`, `src/ctx/hook-classify.ts`)

The guard is installed with `keryx ctx install-hook [--runtime <id|all>]` and
removed with `keryx ctx uninstall-hook`. Installed runtimes and their block
signals are defined in `src/ctx/runtimes.ts`.

## The rule

Any text, symbol, or pattern search over project code must go through
`keryx ctx rg` — never a bare `rg` or `grep`. This applies even to:

- Single targeted searches
- Cases where the graph and wiki layers are skipped

Raw `rg`/`grep` is a last resort only, and requires a stated reason recorded
in the routing audit.

### Routed Command Families

The guard refuses these raw commands and names the replacement:

| Raw command | Routed form |
|---|---|
| `rg`, `grep`, `egrep`, `fgrep`, `ripgrep` | `keryx ctx rg "<pattern>" [path]` |
| `cat`, `head`, `tail` | `keryx ctx read <file> --mode compact` |
| `sed`, `awk` (file read, not `sed -i`) | `keryx ctx run -- <command>` |
| `find`, `ls -R` | `keryx ctx run -- <command>` |
| `git diff` | `keryx ctx diff [--staged\|--stat\|<revision>]` |
| `git log`, `git show` | `keryx ctx run -- git <sub> …` |

### Runtime Requirements

`keryx ctx rg` requires ripgrep on `PATH`. Install it with:

- macOS: `brew install ripgrep`
- Debian/Ubuntu: `apt install ripgrep`

Without ripgrep, code search is unavailable. The recorded fallback is to
read files directly — never to run raw `rg` (`CLAUDE.md`:24).

## Applicability

The guard fires from the runtime's `PreToolUse` hook (`runCtxHook`,
`src/ctx/hook.ts`) when **all** of the following hold:

1. The runtime is one `getRuntime` resolves — an unknown runtime never interferes
2. The payload either:
   - Parses as a shell command, **or**
   - Names the runtime's own native search tool (for Claude: `["Grep"]`)
3. The command stage is first in its pipeline, or names a file rather than reading stdin
4. The first token is not already `keryx` or `rtk`

## Exceptions

The one sanctioned way out is the inline escape marker below, and it requires a
stated reason recorded in the routing audit. The shell-reinterpretation shapes
listed under "Non-Firing Conditions" are not exceptions — they are gaps the
classifier does not see through, not permissions to bypass the guard.

### The Escape Marker

Appending `# keryx:raw <reason>` to the command allows the raw form.

**Placement:** The marker must sit where a shell reads it as a comment. The
`escapeReasonOf` function (`src/ctx/hook-classify.ts`) scans for `#` outside
quotes, because a marker inside a quoted argument could accidentally opt a
command out of the guard.

Example that passes:

```bash
grep -rn '#keryx:raw' src/   # keryx:raw checking for accidental escape markers
```

**When honored:** The reason is echoed to stderr:

```text
[keryx ctx] raw command allowed via escape marker — reason: <reason>
```

An empty reason renders as `(no reason given)` (`exitCodeAllow`,
`src/ctx/runtimes.ts`).

### Non-Firing Conditions (Not Permissions)

These command shapes pass unclassified and are **not** sanctioned escapes:

- `sh -c '<command>'`
- `$(…)`
- Backticks
- `eval`
- `xargs`

The classifier only tests `tokens[0]` against fixed name lists. Reaching for
one of these shapes to avoid the guard defeats the rule without triggering it.

This is by design, and documented in the accepted lesson
`.metaproject/memory/lessons/allowlist-not-a-boundary.md`. A list of command
names is incomplete by construction, and the shell re-interprets text that
the pattern already matched.

**Fail-open conditions** (not block decisions):

- Unknown runtime
- Unparseable payload
- Non-shell tool the guard does not claim

## Authority and acceptance basis

The rule is stated in this repository's agent entrypoints:

- `AGENTS.md` (line 22)
- `CLAUDE.md` (line 22)

Both are imported into `.metaproject/index.md` as step 8 of the Agent
Workflow, where the index's Rules table marks `AGENTS.md`/`CLAUDE.md` as
`high` priority.

This is the acceptance basis: the rule binds because the entrypoint files say
so, and every agent session reads them.

**Q5 remains `unknown`:** No decision record in `docs/decisions/` states why a
hard refusal was chosen over an advisory warning. The reason has deliberately
not been reconstructed from the code.

## Enforcement references

| File | Key symbols | Role |
|------|-------------|------|
| `src/ctx/hook.ts` | `runCtxHook` | Process the harness invokes before a shell command runs; fail-open by construction |
| `src/ctx/hook-classify.ts` | `classifyCommand`, `escapeReasonOf`, `buildBlockMessage` | Decision logic, escape marker parsing, refusal message |
| `src/ctx/runtimes.ts` | `refusalAction`, `exitCodeAllow` | Per-runtime block/allow signals |
| `src/ctx/hook.test.ts` | — | Classification tests |
| `src/ctx/hook-pipeline.test.ts` | — | Pipeline-stage rule tests |
| `src/ctx/hook-native-search.test.ts` | — | Native-search refusal tests |
| `src/ctx/runtimes.test.ts` | — | Per-runtime signal tests |

> Note: There is no `hook-classify.test.ts`. The classifier is covered
> through the test files above, not by a dedicated test file.

### Observed Refusal Text

From a live `PreToolUse` block in this repository:

```text
[keryx ctx] Raw `cat` bypasses the gdctx routing layer (raw output floods context).
Use instead:  keryx ctx read <file> --mode compact
The routed form is compressed and recorded in the routing audit (ctx_used).
If raw output is genuinely required, append an escape marker with a reason:
  cat <file>   # keryx:raw <why raw is needed>
```

## Questions this page must close

Short answer to Q1: every text, symbol or pattern search over project code goes through `keryx ctx rg`; a bare `rg`/`grep` is a last resort with a stated reason.

> Rule template (wiki-specification.md §4): "Which rule applies in exactly
> this situation?"

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Which rule applies when an agent runs ripgrep or grep over this project's code? | covered | `CLAUDE.md`:22, `AGENTS.md`:22, and `.metaproject/index.md` step 8 state it identically. |
| Q2 | What is the sanctioned exception, and what must accompany it? | covered | `escapeReasonOf` and `ESCAPE_MARKER` in `src/ctx/hook-classify.ts`; the reason is echoed by `exitCodeAllow` in `src/ctx/runtimes.ts`. |
| Q3 | What enforces the rule, and what does the agent see when it fires? | covered | `runCtxHook` in `src/ctx/hook.ts`, `buildBlockMessage` in `src/ctx/hook-classify.ts`, `refusalAction` in `src/ctx/runtimes.ts`. Live refusal text appears under Enforcement References. |
| Q4 | Which command shapes does the guard not classify? | covered | The `classifyCommand` doc comment in `src/ctx/hook-classify.ts` names them; `classifyCommand` only tests `tokens[0]` against fixed name lists. |
| Q5 | Why was a hard refusal chosen over an advisory warning? | unknown | No decision record states it. Searching `docs/decisions/` for "routing guard", "ctx hook", "keryx:raw", or "hook-classify" returns nothing. The `docs/` pages that mention the guard cover installation and reference only. |
| Q6 | Does the rule bind only searches over code, or over any file? | partial | The written rule scopes itself to "project code" (`CLAUDE.md`:22). The enforcement does not: the `ROUTES` table in `src/ctx/hook-classify.ts` matches only on command name, never inspecting the target path. A search over docs or a log is refused identically. Which is authoritative is unrecorded. |

## Related Links

**Code:**

- `src/ctx/hook.ts`
- `src/ctx/hook-classify.ts`
- `src/ctx/runtimes.ts`

**Wiki:**

- [Wiki Index](../index.md)
- [Module src/ctx](../components/src-ctx.md)

## Changelog

- **0.1.0** — Initial version. Authored for AFC-W02 (flow 235) from entrypoint
  rule text, guard implementation, and accepted lesson on allowlists. Q5 left
  `unknown` due to absence of decision record.
