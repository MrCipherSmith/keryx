# the gdctx routing guard blocks pipe filters, and its Bash-only matcher lets the native search tool bypass it

Status: formalized
Source: user description, from a proposal filed by another session that
believed the guard did not exist

## Problem

The gdctx routing guard ships and works: `keryx ctx install-hook` writes a
`PreToolUse` hook, and `keryx ctx hook claude` exits 2 with feedback on a raw
`grep`. Two defects make it either unusable or trivially bypassed, and both were
predicted, in the abstract, by an outside proposal that did not know the guard
already existed.

### 1. Every stage of a pipeline is classified, so filtering output is blocked

`segments()` splits a command on `||`, `&&`, `;`, `|`, and newline, and
classifies each piece independently. A command downstream of a pipe reads
stdin — it is filtering a stream, not searching a tree — but it is classified as
though it named a file. Measured against the shipped classifier:

```
BLOCK  npm run test:unit | grep -E 'Test Files|Tests '
BLOCK  bun test 2>&1 | tail -5
BLOCK  keryx ctx rg 'foo' | grep -c 'bar'
BLOCK  echo hi | grep hi
```

The third is the one that gives the game away: routing the search through
`keryx ctx rg`, exactly as the rule demands, and then counting the results, is
refused. This is the failure mode that gets a hook uninstalled, and it is the
most likely reason the guard is opt-in rather than installed by `keryx init`
like every other module hook.

### 2. The matcher is `Bash`, so the native search tool walks past it

`preToolUseGroup` installs `matcher: "Bash"`, and `parseToolInputCommand`
returns null for any other `tool_name`, which fails open. An agent that reaches
for its runtime's own search tool instead of the shell is not guarded at all —
and the Bash guard then reports a clean run, which is worse than no guard,
because the routing audit records compliance that did not happen.

## Expected Outcome

- A command downstream of a pipe is treated as a filter and allowed. The first
  stage of each statement is still classified, so `grep -rn foo src/ | head`
  stays blocked: piping a code search into a pager does not stop it being a code
  search.
- `cd x && rg y` and `cat f | rg y` stay blocked, which the current shallow
  split exists to catch.
- The native code-search tool is refused with a message naming
  `keryx ctx rg`, and the installed matcher covers it.
- Refusal stays escapable: `# keryx:raw <reason>` on a Bash command is the
  pressure valve, and it remains reachable for anything the native tool would
  have done.

## Out of Scope

- Installing the guard by default from `keryx init` (no `--no-ctx-routing-hook`
  flag exists, unlike the seven other module hooks). Defensible once the false
  blocks are gone, but it is a policy change and belongs to whoever owns the
  init contract.
- `git log --format=%B | grep -v ...`, which the outside proposal lists as a
  case that must pass. It stays blocked, deliberately: `git log` is in the
  guard for output volume rather than for being a code search, a downstream
  filter does not bound it, and `keryx ctx run -- <command>` exists for exactly
  this. The escape marker covers the exception.
- `Glob`. It returns paths rather than file content, so it is not "a text,
  symbol, or pattern search over project code" in the sense the rule means, and
  guarding it would generate false blocks for no routing gain.
- The settings-resolution problem observed separately: the guard is installed at
  this repo's root and did not fire for a session whose working directory was
  `src/gdskills/bundled`. Real, and a different subsystem.
