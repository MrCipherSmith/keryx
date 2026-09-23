# Review — flow 295, scheduled agent tasks (PR #664), round 2 — security re-review

Re-review of the round-1 fixes, run on top of commit `60dab15d` (folded into `95c54166`). Six
findings were raised: one high (the scheduler-control matcher could be bypassed by shell
quoting/escaping or wrapper commands, and `schedule add|resume|run` accepted non-interactive
invocation), three medium, two low. All six were acted on, and N2 was later revised per a
coordinator decision (a `#!` wrapper script outside the project is allowed, with its interpreter
pinned, rather than refused outright). Re-verified below against the code that merged to `main`
as `89dbea8dc25d80639ead9f7497287767138a040c` (PR #664, squash-merged from head
`4be4004daf96599ec3f2e28b1e6e4e8ab94a1c9d`; identical trees).

```json keryx:findings
[
  {
    "id": "N1",
    "reviewer": "security-reviewer (flow 295, round 2)",
    "severity": "major",
    "file": "src/lib/command-risk.ts",
    "quote": "touchesSchedulerControl",
    "problem": "The round-1 scheduler-control matcher could be bypassed by shell quoting/escaping (e.g. `keryx 'schedule' add`) or by a wrapper stripping the tool-call marker (e.g. `env -u KERYX_TOOL_CALL keryx schedule add`); and `keryx schedule add|resume|run` accepted non-interactive/scripted invocation outside a detected tool-call context.",
    "impact": "An agent could still install or resume a schedule unattended by quoting around the raw-regex matcher, or by piping input to `keryx schedule add --yes` from a context the KERYX_TOOL_CALL heuristic did not catch, defeating the always-ask floor F2 was meant to close.",
    "suggested_fix": "Match on PARSED shell words (handling quotes, escapes, env/sudo/nice/nohup/exec/timeout wrappers, `sh -c`/`eval` reparsing, and `cd` into a unit directory) with the raw regex kept as a second net; and require both stdin and stdout to be a real TTY for `add|resume|run`, `--yes` included.",
    "evidence": "Pre-fix, `touchesSchedulerControl` matched only raw regex patterns against the whole command string, and `keryx schedule add|resume|run` had no terminal requirement beyond the KERYX_TOOL_CALL check.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/lib/command-risk.ts (parsedSchedulerControl, segmentControlsScheduler, peelWrappers)",
        "src/commands/schedule.ts (NEEDS_TERMINAL check on add/resume/run)"
      ],
      "enumeration_method": "enumerated every way a command string reaches the scheduler-control check without matching the raw regex: shell quoting, escape sequences, prefix wrappers, `sh -c`/`eval` reparsing, and `cd` into a unit directory — each needed its own handling in the parsed-word matcher; separately, every entry point that can install/resume/run a schedule (add, resume, run) needed the same TTY requirement."
    }
  },
  {
    "id": "N2",
    "reviewer": "security-reviewer (flow 295, round 2)",
    "severity": "minor",
    "file": "src/trigger/granted-binary.ts",
    "quote": "granted-cwd",
    "problem": "Granted tool execs (and the `gh auth token` lookup) ran with the project directory as their cwd, and a shell-shim binary (asdf/mise/PATH shims) could substitute a different real binary than the one that was verified.",
    "impact": "A granted tool running from the project directory could pick up project-local config/binaries it should not see, and a shim could redirect execution to an unverified real binary without the pin catching the substitution.",
    "suggested_fix": "Run granted execs and the `gh auth token` lookup from a dedicated empty directory; refuse shims at draft time (suggesting `mise which`/`asdf which`); and, per a later revision, allow a `#!` wrapper outside the project by pinning both the wrapper AND its resolved interpreter (realpath+sha256+inode+mtime each), re-verified before every exec with the interpreter re-resolved on the runtime PATH.",
    "evidence": "Pre-fix, granted execs ran with the project as cwd, and no shim/wrapper distinction existed at draft time.",
    "confidence": "high"
  },
  {
    "id": "N3",
    "reviewer": "security-reviewer (flow 295, round 2)",
    "severity": "minor",
    "file": "src/commands/trigger-agent-task.ts",
    "quote": "ensureScratchParent",
    "problem": "The scratch working-directory parent for agent-task runs had no check on its owning uid or permission mode, so another local user (or a symlink) could redirect or read a run's scratch space.",
    "impact": "On a shared machine, another local user could pre-create the scratch parent as world-writable or as a symlink, letting them read or tamper with an agent-task run's scratch files.",
    "suggested_fix": "Require the scratch parent to be a plain directory (not a symlink), owned by the current uid, and mode 0700; refuse otherwise before any model call.",
    "evidence": "Pre-fix, the scratch parent directory was created with no ownership or mode verification if it already existed.",
    "confidence": "medium"
  },
  {
    "id": "N4",
    "reviewer": "security-reviewer (flow 295, round 2)",
    "severity": "minor",
    "file": "src/harness/process/sandbox/unattended.ts",
    "quote": "keryxConfigDir",
    "problem": "When `XDG_DATA_HOME` pointed outside `$HOME`, keryx's config directory (holding the HMAC signing key and saved credentials) was not hidden inside the hardened sandbox used for unattended/agent-task runs.",
    "impact": "A sandboxed run with a non-default XDG_DATA_HOME could read keryx's own signing key and credentials from inside the sandbox, defeating the F1 HMAC-key protection.",
    "suggested_fix": "Always hide keryxConfigDir in the unattended sandbox regardless of where it resolves, for both the agent-task and flow-next dispatch paths; refuse a config dir located inside the project; pin XDG_DATA_HOME into the generated units.",
    "evidence": "Pre-fix, the sandbox only hid the config directory when it resolved under $HOME.",
    "confidence": "medium"
  },
  {
    "id": "N5",
    "reviewer": "security-reviewer (flow 295, round 2)",
    "severity": "info",
    "file": "src/lib/command-risk.ts",
    "quote": "trigger run --schedule",
    "problem": "`trigger run --schedule` (the scheduler's own self-invocation) had no distinguishing marker in the scheduler-control pattern family.",
    "impact": "A pattern-based allowlist could not specifically recognise the scheduler's own invocation as scheduler-control, weakening pattern refusal coverage.",
    "suggested_fix": "Explicitly treat `trigger run … --schedule` as scheduler-control, and refuse the wildcard pattern `keryx trigger run *` too.",
    "evidence": "Pre-fix, `trigger run --schedule` matched no explicit rule in the scheduler-control family.",
    "confidence": "low"
  },
  {
    "id": "N6",
    "reviewer": "security-reviewer (flow 295, round 2)",
    "severity": "info",
    "file": "src/trigger/granted-binary.ts",
    "quote": "sameIdentity",
    "problem": "Granted binaries were re-verified (pinned realpath/sha) only once per agent-task run, not before each individual exec within that run, leaving a TOCTOU window if a binary changed mid-run.",
    "impact": "A binary swapped after the first verification but before a later grant call within the same run could execute unverified content.",
    "suggested_fix": "Record dev/inode/size/mtime at verification time and re-check all four before every single exec, not just once per run.",
    "evidence": "Pre-fix, the pinned identity was checked once at run start and not re-checked before subsequent execs in the same run.",
    "confidence": "low"
  }
]
```

## Coverage

Reviewed: `src/lib/command-risk.ts`, `src/commands/schedule.ts`, `src/trigger/granted-binary.ts`,
`src/commands/trigger-agent-task.ts`, `src/harness/process/sandbox/unattended.ts`,
`src/trigger/schedule-verify.ts`, `src/trigger/install.ts`. Not reviewed: the rest of the
repository, unchanged by this flow.

## Outcome

Six findings recorded: one major, three minor, two info. All six were acted on (N2 per a later
revision, described in its own finding), and are independently re-verified below against
`89dbea8dc25d80639ead9f7497287767138a040c` (== worktree HEAD `4be4004daf96599ec3f2e28b1e6e4e8ab94a1c9d`),
each against its own named regression test in `src/commands/schedule-security.test.ts`.
