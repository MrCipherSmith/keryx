# Implementation Plan

Status: ready

## Approach

Give the classifier the one distinction it is missing: a pipeline stage that is
not the first reads stdin. Everything else follows from that, and nothing about
what counts as a routable command changes.

`segments()` flattens `&&`, `;`, newline and `|` into one list, which is what
loses the distinction. Split in two levels instead — statements, then pipeline
stages within a statement — and classify only the first stage of each statement.
`cd x && rg y` is two statements, so the second is still stage 0 and still
blocked; `npm test | grep foo` is one statement whose stage 0 is `npm test`.

For the native tool, extend the runtime with an explicit list of tool names that
ARE a code search. Anything not on that list keeps failing open, which is the
property that makes the guard safe to leave installed.

## Steps

1. `hook-classify.ts` — replace `segments()` with `statements()` + first-stage
   selection. Keep the shallow-parser approach; a real shell parser is not
   warranted and the escape marker covers what a shallow split gets wrong.
2. `runtimes.ts` — add `nativeSearchTools` to the runtime, `["Grep"]` for
   Claude/Codex. `parseToolInputCommand` keeps returning null for other tools.
3. `hook.ts` — when the payload is not a shell call, check whether it is a
   native search on the runtime's list, and refuse with a message naming
   `keryx ctx rg`. Unknown tool: exit 0, unchanged.
4. `runtimes.ts` — `preToolUseGroup` matcher becomes `Bash|Grep`; `validate`
   updated so an old `Bash`-only install is reported as needing a reinstall
   rather than silently passing.
5. Tests: the five pipeline cases as a table, the statement cases that must stay
   blocked, the native-tool refusal, and fail-open for an unknown tool.
6. Re-run the shipped classifier over the outside proposal's own pass/block
   specimens and record which of its five now behave as it asked, including the
   one that deliberately does not.

## Risks

- **Over-allowing is the expensive direction here.** `grep -rn foo src/ | head`
  must stay blocked; a rule that allowed any piped command would silently
  disable the guard for the most common code-search shape.
- Changing the matcher means an existing install is stale. `validate` has to say
  so rather than report a clean guard, or the fix is invisible to anyone who
  already ran `install-hook`.
- Blocking a native tool is the first refusal a user cannot escape in-line. It
  is acceptable only because `keryx ctx rg` does the same job and Bash with
  `# keryx:raw` remains available; if either stopped being true this would need
  its own hatch.
