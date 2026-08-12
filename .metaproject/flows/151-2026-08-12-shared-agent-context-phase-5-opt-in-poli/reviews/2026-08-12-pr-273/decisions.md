# Decisions

- All actionable review findings were treated as merge blockers regardless of severity.
- The learned policy remains a constrained selection advisor and has no role,
  security-gate, acceptance-criteria, Flow-state, configuration or self-modification surface.
- The final corpus digest pins the complete manifest except its own digest,
  plus all rows and quarantine entries.
- Sandbox output is accepted only through an owner-bound opaque capability and
  an integrity-linked execution receipt for the exact request.
