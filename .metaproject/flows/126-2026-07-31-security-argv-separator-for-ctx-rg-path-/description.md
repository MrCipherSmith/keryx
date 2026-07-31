# security: argv separator for ctx rg + path containment for caller-supplied paths (S-001/S-003)

Status: formalized
Source: security review of PR #213 (flow 087)

## Problem

Two runtime defects, both predating the branch that surfaced them. They were
found while making the command registry an authorization input: the registry now
tells a consumer which commands may run unattended, which turns "what can this
command actually be made to do" from a curiosity into a security question.

### S-001 — `ctx rg` does not separate its pattern from ripgrep's flags

The caller-supplied search pattern is forwarded into the ripgrep argv with no
`--` separator, so a value beginning with `-` is parsed by ripgrep as one of its
own options rather than as a pattern. Ripgrep has options that cause it to
execute an external program for each file it considers. A search — the most
innocuous-looking operation in the toolkit, and one agents are *instructed* to
prefer over raw grep — therefore reaches arbitrary command execution.

The registry previously declared this command read-only, which on the future
remote surface would have made it eligible to run without asking.

### S-003 — caller-supplied paths are not constrained to the project

`test suggest <file>` resolves the caller's path against the working directory
with no containment check, reads it, and sends its contents to a model provider.
Nothing stops the path escaping the project: a relative traversal or an absolute
path reaches any file the process can read, including the user-global credential
store, and the contents leave the machine.

`security scan <path>` and `agents monitor <events-file>` take a caller path of
the same shape.

Why now: PR #213 mitigated the exposure by marking both commands as writers so
they are no longer auto-allowable, but that only removes one path to them. The
defects are in the commands themselves and are reachable today from the CLI.

## Expected Outcome

- A pattern beginning with `-` is treated as a pattern by `ctx rg`, never as a
  ripgrep option, and cannot select an option that executes a program.
- A caller-supplied path that resolves outside the project root is refused
  before the file is opened, for every command that accepts one.
- Both refusals are explicit and testable, not incidental consequences of some
  other check.
- Regression tests that fail if either guard is removed.

## Out of Scope

- Re-auditing the descriptor flags — done in flow 087.
- Sandboxing ripgrep or the model call. Containment is a separate layer; this
  flow fixes the argument handling that lets the layer be bypassed in the first
  place.
- The remote surface itself.
