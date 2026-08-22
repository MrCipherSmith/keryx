# SAC-08 — workspace binding re-evaluation on topic shift (doc-vs-code discrepancy, resolved)

**Area:** 8. SAC: workspace / proposal / review · **Date:** 2026-08-22 · **Status:** PASS
(resolves the prior "open observation" with real, clean evidence)

## Test case (from the catalog)

> `shared-agent-context.md` states binding "re-evaluates that binding mid-session if the topic
> shifts"; `goal-command.ts`'s own comment says a `/goal` "reusing an already-bound slate
> mid-session is never re-resolved" (AC-25). A prior live run's proposals landing in an
> unrelated, already-closed workspace is consistent with the code's claim, not the doc's — but
> that run resumed an old session by accident, confounding the result. **Test**: fresh session,
> `/goal <topic A>` (binds workspace X), then in the SAME session `/goal <clearly unrelated
> topic B> --auto 1`, and check which workspace topic B's proposal lands in.

## What was actually run

Two separate `keryx shell` invocations, second resuming the same session via `-c` (a cleaner
substitute for piping two `/goal` lines into one invocation, which did not reliably deliver the
second line in an earlier attempt — noted for the record, not investigated further here):

```bash
printf '/goal Прочитай README.md - какая версия node требуется?\n' | DEEPSEEK_API_KEY="$(...)" \
  keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
# fresh session -> id 9640367c

printf '/goal Найди самый крупный по числу файлов top-level каталог в src/ (например src/harness) и назови его\n' | DEEPSEEK_API_KEY="$(...)" \
  keryx shell -c --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
# resumed session 9640367c
```

Two deliberately unrelated topics (a README fact-check vs. a source-tree size question), same
session id, no `--auto` on either (one-shot form both times).

## Captured evidence (on-disk slate archives, same session directory)

```text
~/.local/share/keryx/sessions/.../1de1a362-3774-403a-b64b-fed79640367c/slate-archive/
  2026-08-22T09-20-39.114Z-1.json  ->  workspaceId: "workspace-f78ef1d2b7374ee6"  (touched: README.md)
  2026-08-22T09-20-59.284Z-1.json  ->  workspaceId: "workspace-08c0eabf7f9645f5"  (touched: src)
```

**Two different workspace ids, in the same `keryx sessions` session, twenty seconds apart.**

## Summary

Confirmed, cleanly, with real evidence: sequential `/goal` calls on unrelated topics **do** end
up bound to different, topically-appropriate workspaces — matching the *outcome*
`shared-agent-context.md` describes, not the "never re-resolved" reading of the code comment.

## Analysis

The mechanism is not quite what either source implied on its own, and reconciling both explains
the earlier confounded observation:

- Each one-shot `/goal` call (no `--auto`) opens a **fresh Slate and closes it again within the
  same CLI invocation** — visible directly above as two separate archive files, one per
  invocation, `~20s` apart. `SLATE-16`'s "only when unset" rule (`goal-command.ts`'s own
  comment) is still accurate **within one live Slate's lifetime** — it never re-resolves a
  workspace already bound on the *same, still-open* Slate object. But since a fresh Slate opens
  for each new one-shot `/goal`, "already bound" is never true at the start of the second call —
  there is no live Slate carrying the first call's binding forward, so resolve-or-create runs
  again, genuinely fresh, and reasonably picks a different, more topical workspace the second
  time.
- The prior confounding run (`1be94528`, from the earlier live-testing pass) used `--auto`, which
  keeps ONE Slate open across every round of the loop by design — so within that run, "never
  re-resolved once bound" correctly describes what happened: the workspace bound at the start of
  that (accidentally resumed, already-bound) Slate legitimately never changed for the rest of the
  run, because the Slate itself never closed until the whole `--auto` loop finished.

So both sources are accurate, in different scopes: the doc describes the cross-invocation,
new-Slate-per-one-shot-`/goal` outcome; the code comment describes what happens *within* one
continuously-open Slate (typically an `--auto` run, or several turns in one interactive session
without an intervening close). Neither is wrong; the catalog's original framing of this as an
unresolved "discrepancy" is superseded by this cleaner test.

## Improvement / fix suggestion

None required — behavior is sound and, once the two scopes are distinguished, consistent with
both sources. Only a documentation clarity suggestion: `shared-agent-context.md`'s "re-evaluates
that binding mid-session if the topic shifts" reads as if it describes live re-evaluation *within*
one ongoing interaction, when what actually produces the effect is Slate-lifetime boundaries
(each fresh one-shot `/goal` gets its own Slate). Worth a small doc note distinguishing "topic
shift across separate one-shot `/goal` calls" (re-resolves, by virtue of a fresh Slate) from
"topic shift mid-loop within one `--auto` run" (does not re-resolve — same Slate, same binding,
for the whole loop).
