# Code Search Routing Rule

Version: 0.1.0
Type: business-rule
Status: accepted

## Summary

Every text, symbol or pattern search an agent runs over this project's code
goes through `keryx ctx rg`, never a bare `rg` or `grep`. A `PreToolUse` hook
enforces the rule before the command runs and refuses the raw form with a
message naming the routed replacement. The one sanctioned way out is an inline
escape marker that states a reason.

`Status: accepted` here labels the **rule** as currently in force — it is
stated in this repository's agent entrypoints and enforced by a live hook (see
Authority and acceptance basis). It does not claim that a person has reviewed
this page's prose; nobody has. The page was authored from the sources cited in
every section below, and the one question with no source is marked `unknown`
rather than answered from the code.

## Questions this page must close

<!--
  Rule template (wiki-specification.md §4).
  Check question: Which rule applies in exactly this situation?

  These questions were fixed before this page's body was written. Every one
  carries covered | partial | unknown | not-applicable AND its basis. A filled
  heading is not an answer, and a count of headings — or of pages — is never
  the completeness check.
-->

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Which rule applies when an agent runs ripgrep or grep over this project's code? | covered | `CLAUDE.md`:22, `AGENTS.md`:22 and `.metaproject/index.md` step 8 state it in the same words. |
| Q2 | What is the sanctioned exception, and what must accompany it? | covered | `escapeReasonOf` and `ESCAPE_MARKER` in `src/ctx/hook-classify.ts`; the reason is echoed by `exitCodeAllow` in `src/ctx/runtimes.ts`. |
| Q3 | What enforces the rule, and what does the agent see when it fires? | covered | `runCtxHook` in `src/ctx/hook.ts`, `buildBlockMessage` in `src/ctx/hook-classify.ts`, `refusalAction` in `src/ctx/runtimes.ts`. Observed live in this repository: the refusal text is reproduced under Enforcement references. |
| Q4 | Which command shapes does the guard not classify? | covered | The `classifyCommand` doc comment in `src/ctx/hook-classify.ts` names them, and `classifyCommand` only ever tests `tokens[0]` against fixed name lists. |
| Q5 | Why was a hard refusal chosen over an advisory warning? | unknown | No decision record states it: searching `docs/decisions/` for `routing guard` / `ctx hook` / `keryx:raw` / `hook-classify` returns nothing, and the `docs/` pages that mention the guard cover installation and reference only. Not reconstructed from the code. |
| Q6 | Does the rule bind only searches over code, or over any file? | partial | The written rule scopes itself to "project code" (`CLAUDE.md`:22). The enforcement does not: the `ROUTES` table in `src/ctx/hook-classify.ts` matches on the command name alone and never inspects the target path, so a search over docs or a log is refused identically. Which of the two is authoritative is not recorded. |

## Scope

Applies to every shell command an agent runs in this repository through a
runtime that has the gdctx routing guard installed, and to that runtime's own
native code-search tool. Installed runtimes and their block signals are defined
in `src/ctx/runtimes.ts`; the guard is installed with
`keryx ctx install-hook [--runtime <id|all>]` and removed with
`keryx ctx uninstall-hook`.

It does not govern how a human runs commands in their own terminal, and it does
not govern editing: `sed -i` is explicitly exempt because it writes in place and
produces no stdout (`classifyCommand`, `src/ctx/hook-classify.ts`).

## The rule

Any text, symbol or pattern search over project code goes through
`keryx ctx rg`, never a bare `rg` or `grep` — even a single targeted search, and
even when the graph and wiki layers are skipped. Raw `rg`/`grep` is a last
resort only, with a stated reason recorded in the routing audit.

The same routing applies to the other command families whose raw output floods
an agent's context. `classifyCommand` in `src/ctx/hook-classify.ts` refuses each
of these and names the replacement:

| Raw command | Routed form |
|---|---|
| `rg`, `grep`, `egrep`, `fgrep`, `ripgrep` | `keryx ctx rg "<pattern>" [path]` |
| `cat`, `head`, `tail` | `keryx ctx read <file> --mode compact` |
| `sed`, `awk` reading a file (not `sed -i`) | `keryx ctx run -- <command>` |
| `find`, and `ls -R` | `keryx ctx run -- <command>` |
| `git diff` | `keryx ctx diff [--staged\|--stat\|<revision>]` |
| `git log`, `git show` | `keryx ctx run -- git <sub> …` |

## Applicability

The guard fires before the tool call, from the runtime's `PreToolUse` hook
(`runCtxHook`, `src/ctx/hook.ts`). It binds when all of the following hold:

- the runtime is one `getRuntime` resolves — an unknown runtime never
  interferes;
- the payload parses as a shell command, **or** names the runtime's own native
  search tool. For Claude that list is `["Grep"]` (`CLAUDE_RUNTIME`,
  `src/ctx/runtimes.ts`), refused because a native search bypasses the shell
  entirely and the Bash guard would otherwise report a clean run over it;
- the command stage is first in its pipeline or names a file rather than
  reading stdin;
- the first token is not already `keryx` or `rtk`.

`keryx ctx rg` itself requires ripgrep on `PATH` (`brew install ripgrep`, or
`apt install ripgrep`). Without it, code search is unavailable and the recorded
fallback is to read files directly — not to run raw `rg` (`CLAUDE.md`:24).

## Exceptions

**The escape marker.** Appending `# keryx:raw <reason>` to the command allows
the raw form. The marker must sit where a shell would read it as a comment:
`escapeReasonOf` (`src/ctx/hook-classify.ts`) scans for a `#` outside quotes,
because a marker inside a quoted argument used to opt a command out of the
guard by accident — `grep -rn '#keryx:raw' src/` passed. When the marker is
honoured, the reason is echoed to stderr: `[keryx ctx] raw command allowed via
escape marker — reason: <reason>`, and an empty reason renders as
`(no reason given)` (`exitCodeAllow`, `src/ctx/runtimes.ts`).

**Non-firing conditions, which are not permissions.** An unknown runtime, an
unparseable payload, or a non-shell tool the guard does not claim all fail
open (`runCtxHook`, `src/ctx/hook.ts`). So does any command shape the
classifier cannot read: `sh -c '<command>'`, `$(…)`, backticks, `eval` and
`xargs` pass unclassified, because the block decision requires `tokens[0]` to
be a member of a fixed name list. The module's own comment states the
consequence — this is a nudge, not a boundary — and the accepted lesson
`.metaproject/memory/lessons/allowlist-not-a-boundary.md` records why the
ceiling is structural: a list of command names is incomplete by construction,
and the shell re-interprets text the pattern already matched. Reaching for one
of these shapes to avoid the guard defeats the rule without triggering it.

## Authority and acceptance basis

The rule is stated in this repository's agent entrypoints — `AGENTS.md` and
`CLAUDE.md`, both at the same line — and imported into
`.metaproject/index.md` as step 8 of the Agent Workflow, where the index's own
Rules table marks `AGENTS.md`/`CLAUDE.md` as `high` priority. That is the
acceptance basis: the rule binds because the project's entrypoint files say so
and every agent session reads them.

Why a hard refusal was chosen over an advisory warning is `unknown` — no
decision record in this repository states it. `docs/decisions/` holds one
package, `keryx-harness/`, and a search of it for the routing guard
(`routing guard`, `ctx hook`, `keryx:raw`, `hook-classify`) returns nothing;
the documentation that does mention the guard describes how to install it, not
why it denies. The reason has deliberately not been reconstructed from the
code.

## Enforcement references

- `src/ctx/hook.ts` — `runCtxHook`, the process the harness invokes before a
  shell command runs; fail-open by construction except for a named native
  search tool.
- `src/ctx/hook-classify.ts` — `classifyCommand` (the decision),
  `escapeReasonOf` (the exception), `buildBlockMessage` (what the agent reads).
- `src/ctx/runtimes.ts` — per-runtime block/allow signals. Claude, Codex,
  Windsurf and the OpenCode bridge are refused with exit code 2 plus stderr;
  Cursor and Antigravity are refused through a stdout JSON document.
- `src/ctx/hook.test.ts`, `src/ctx/hook-pipeline.test.ts`,
  `src/ctx/hook-native-search.test.ts`, `src/ctx/runtimes.test.ts` — the tests
  that pin the classification, the pipeline-stage rule, the native-search
  refusal and the per-runtime signals. There is no `hook-classify.test.ts`:
  the classifier is covered through these, not by a file of its own.

Observed refusal text, from a live `PreToolUse` block in this repository:

```text
[keryx ctx] Raw `cat` bypasses the gdctx routing layer (raw output floods context).
Use instead:  keryx ctx read <file> --mode compact
The routed form is compressed and recorded in the routing audit (ctx_used).
If raw output is genuinely required, append an escape marker with a reason:
  cat <file>   # keryx:raw <why raw is needed>
```

## Related Code

- `src/ctx/hook.ts`
- `src/ctx/hook-classify.ts`
- `src/ctx/runtimes.ts`

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/ctx](../components/src-ctx.md)

## Changelog

- 0.1.0 - Initial version. Authored for AFC-W02 (flow 235) from the entrypoint
  rule text, the guard's implementation, and the accepted lesson on allowlists;
  Q5 left `unknown` because no decision record states it.
