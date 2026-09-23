# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx flow ac update <id> --criterion ACn --text "<criterion>" --reason "<why>"` replaces that criterion's text in `acceptance-criteria.md`, or appends it when `ACn` is the next unused number, then re-freezes the file and clears confirmations exactly as `ac update` does today. The flow history records the criterion, its previous text and its new text alongside the reason, and a test reads all three back.
- AC2: `keryx flow ac update <id> --reason "<why>"` without `--criterion` keeps today's behaviour — it re-freezes the file as the operator edited it — so existing scripts and documentation keep working.
- AC3: Every `keryx flow ac` subcommand refuses an argument it does not use — an extra positional, `--text` without `--criterion`, `--criterion` without `--text`, or an unknown flag — with an error naming that argument, and changes nothing. A test runs the exact invocation that was silently accepted before, `flow ac update <id> AC1 --text "…" --reason "…"`, and asserts it is refused and the file and checksum are unchanged.
- AC4: The new text is validated before anything is written: it must be non-empty, fit on one line, and not carry its own `- ACn:` prefix; `--criterion` must name `AC` followed by a number. Each refusal names the rule it broke.
- AC5: The flow command help and the CLI reference describe both ways of amending criteria and state that the command refuses arguments it does not use.
- AC6: CI is green on the PR and `keryx health run` gate is pass.
