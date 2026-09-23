# Review — flow 290, Triggers wave 2 (PR #650)

Three security review passes ran over the unattended `flow-next` dispatcher: the hardened
sandbox, the health gate, the unattended permission floor, spend accounting and the shared
maintenance lock. The first pass, run against the initial T5-T11 implementation, found that
containment was not real — the health gate ran agent-written code with the operator's full
rights and no sandbox at all, and the sandbox itself (once added) still left network, tokens,
machine-specific credential directories and a shared `/tmp` reachable — and that spend could go
unrecorded in four separate ways. All of it was fixed in T13. The second pass, run against the
T13 fix with live probes from inside the sandbox, found that `--unshare-net` does not isolate
AF_UNIX path sockets and the host's `/run` (systemd-resolved, tailscaled, D-Bus, libvirt) was
still reachable with the network off — a DNS/egress channel through a profile that believed
itself network-isolated. Fixed in T14. The third pass re-ran the same live probes against the
T14 fix and found no gap: the boundary holds. All findings were acted on before merge. PR #650
merged as `4752910c` with 18/18 checks green at head `2c5afcb10f4a2f3514fd0223819091aa97a92527`.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "blocker",
    "file": "src/commands/trigger-dispatch.ts",
    "quote": "health gate",
    "problem": "The dispatcher's health gate ran `keryx health run` and `keryx health gate` directly in the worktree, with the operator's full process rights and no sandbox at all — even though every other step of an unattended `trust` run was contained.",
    "impact": "The worktree's own tests and configs are agent-written content. Running them unsandboxed handed an unattended agent a second, uncontained execution path into the operator's environment that the dispatch boundary did not cover, defeating the whole point of `trust` refusing to run uncontained.",
    "suggested_fix": "Run the health gate through the same sandbox `wrap` and env the dispatched agent runs under, and fail the gate rather than run the worktree's code at all when no sandbox is available.",
    "evidence": "trigger-dispatch.ts called health run/gate as a plain child process, with no reference to the sandbox planner used for the agent's own shell_exec calls.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/trigger-dispatch.ts sandboxedHealthGate call site (pre-fix: unsandboxed health run/gate)"],
      "enumeration_method": "Every place the dispatcher shells out after the agent turn ends was listed; the health gate was the only one not already routed through the sandbox wrap used for shell_exec."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/commands/trigger-dispatch.test.ts describe(AC13) tests 'the default health gate runs `keryx health run` and `health gate` INSIDE the sandbox, with its env' and 'with no sandbox the health gate does not run the worktree's code at all' both pass against the merged code. Re-run today on this machine: bun test src/commands/trigger-dispatch.test.ts — 42 tests, 0 fail. Fixed by `sandboxedHealthGate` in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "sandboxedHealthGate routes health run/gate through the sandbox wrap and env, and refuses to run the worktree's code with no sandbox; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-002",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "major",
    "file": "src/harness/process/sandbox/unattended.ts",
    "quote": "network",
    "problem": "The sandbox as first implemented allowed network, passed exported tokens and SSH_AUTH_SOCK into the run's environment, exposed machine-specific credential directories such as ~/.config/gh-work, and shared a writable /tmp with the host.",
    "impact": "An unattended, agent-driven shell command could reach the network, read operator credentials from the environment or from a credential directory, and read or plant files in a /tmp shared with the rest of the host — none of which an operator granting `trust` would expect.",
    "suggested_fix": "Build the sandbox profile from allow-lists: filesystem read-only with $HOME hidden except detected toolchain roots, network unshared unless the entry opts in, an environment allowlist excluding tokens and SSH_AUTH_SOCK, and a private /tmp.",
    "evidence": "The pre-fix sandbox planner had no filesystem allow-list, no environment allow-list, and did not unshare the network namespace.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/harness/process/sandbox/unattended.ts filesystem plan", "src/harness/process/sandbox/unattended.ts env plan", "src/harness/process/sandbox/unattended.ts network plan"],
      "enumeration_method": "Every resource class an unattended shell command could reach (filesystem, environment, network, /tmp) was probed from inside the pre-fix sandbox and each reachable one was listed."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/harness/process/sandbox/unattended.test.ts describe(AC13: the plan is built from allow lists) — 'env: only the allowlist passes...tokens and SSH_AUTH_SOCK do not pass', 'filesystem: home hidden wholesale, private /tmp..., network unshared by default', 'a machine-specific credential dir under $HOME (e.g. ~/.config/gh-work) is invisible', 'an exported token and SSH_AUTH_SOCK are not in the environment', 'the host's /tmp is not visible; the sandbox /tmp is private' all pass. Re-run today on this machine with the real bwrap launcher: bun test src/harness/process/sandbox/unattended.test.ts — 23 pass, 0 fail, 64 expect() calls (not skipped). Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the allow-list-built hardened sandbox profile in src/harness/process/sandbox/unattended.ts; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-003",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "major",
    "file": "src/trigger/unattended.ts",
    "quote": "hardDeny",
    "problem": "The unattended forbidden-verb floor was text analysis over the shell command string and was bypassable by quoting (`sh -c '...'`), by reaching the same effect through `gh api`, `curl`, or `git update-ref` instead of the named verb, and by other interpreters.",
    "impact": "An agent under `trust`, or a prompt injection reaching it, could route around every floor rule the AC list names by re-expressing the same forbidden operation through a command the text matcher did not recognise, defeating the floor's purpose as the last line of defence.",
    "suggested_fix": "Do not rely on the text floor as the boundary; move the boundary to a hardened sandbox that denies the underlying capability (network, credential access, write access) regardless of how the command is phrased. Keep the floor as defence in depth and close the specific gaps found.",
    "evidence": "The pre-fix floor matched a fixed list of verb strings against the raw command with no normalisation for `sh -c`, alternate CLIs (`gh api` vs `gh pr merge`), or git plumbing (`update-ref`) equivalent to the denied porcelain commands.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/trigger/unattended.ts unattendedRefusal (forbidden-verb matcher)"],
      "enumeration_method": "Every denied verb in AC5's list was tried through an alternate expression (quoting, a different CLI, git plumbing) and the ones that reached the tool unblocked were recorded."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/commands/trigger-unattended.test.ts describe(AC5) test.each(FORBIDDEN_SHELL) now includes 'git push hidden in sh -c', 'gh api with -X POST', 'gh api with --method=DELETE', 'gh api with a body field', 'git update-ref', 'git branch -f/-D' as denied cases, alongside the plain-omission cases (flow start, flow task skip, a nested trigger run, shell writes to flow.json/acceptance-criteria.md/triggers.json/the run record). Re-run today: bun test src/commands/trigger-unattended.test.ts — part of the 181-test / 0-fail run across the 10 flow-290 test files. Disposition: the floor stays as defence in depth (it still runs, and these specific bypasses are closed); the boundary that actually contains an unattended run is the sandbox verified under F-002/F-004. Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the floor's verb list gained sh -c/gh api/git-plumbing coverage and the plain omissions, and the docs now say the floor is defence in depth, not the boundary; the boundary moved to the sandbox (F-002, F-004); merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-004",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "major",
    "file": "src/harness/process/sandbox/unattended.ts",
    "quote": "launcher",
    "problem": "When no sandbox launcher (bwrap) was present, or an operator setting disabled the sandbox, `trust` ran the agent's commands uncontained instead of refusing — the exact opposite of fail-closed.",
    "impact": "A host missing bwrap, or an operator who had set `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` for an unrelated reason, would get a fully uncontained unattended run under `trust` with no warning at dispatch time.",
    "suggested_fix": "Probe the launcher (not just its presence on PATH, since a binary can exist while namespaces are disabled) before the first model call, and refuse `trust` with a recorded reason on any gap: no launcher, a failed probe, a non-Linux host, or an explicit disable setting.",
    "evidence": "The pre-fix dispatch path skipped sandbox wrapping silently when the planner reported no launcher, rather than refusing the dispatch.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/harness/process/sandbox/unattended.ts launcher probe", "src/commands/trigger-dispatch.ts trust-mode sandbox gate"],
      "enumeration_method": "Every opt-out path to an uncontained trust run was enumerated: PATH lacks the launcher, the launcher exists but cannot create a namespace, the host is not Linux, and the operator's disable setting."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/harness/process/sandbox/unattended.test.ts describe(AC13: an unattended run never runs uncontained — every opt-out and every gap refuses) — 'KERYX_DANGEROUSLY_DISABLE_SANDBOX=1 refuses', 'a non-Linux host refuses', 'no launcher on PATH refuses', 'a launcher that cannot create a namespace refuses' all pass; src/commands/trigger-dispatch.test.ts 'trust with no sandbox refuses before any model call, reservation, worktree or attempt — reason recorded' pass. Re-run today: bun test src/harness/process/sandbox/unattended.test.ts — 23 pass / 0 fail (real launcher present and functional on this machine, so the positive-control path also ran, not just the refusal path). Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "trust now live-probes the launcher and refuses (sandbox-unavailable, exit 0, reason recorded) on every gap; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-005",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "major",
    "file": "src/trigger/run.ts",
    "quote": "spend",
    "problem": "Spend could go unrecorded in four ways: a run killed mid-flight left nothing charged against either ceiling, a provider whose adapter never reported usage in its stream recorded zero cost for real model calls, concurrent dispatches against one trigger could each observe the full remaining allowance before either recorded anything, and a zero-rate entry could dispatch with cost computed as $0.",
    "impact": "Spend accounting could be defeated or raced, letting unattended dispatches run past the operator's declared ceiling without it ever showing in the ledger — the opposite of AC6-AC8's contract that an unpriced or unbounded dispatch cannot run.",
    "suggested_fix": "Reserve the remaining allowance in the ledger, under a project-wide spend lock, before the first model call; keep the reservation counted against both ceilings until an operator resolves a killed run; refuse providers that do not report usage; reject zero rates at config load.",
    "evidence": "The pre-fix run path wrote a cost record only on a normal close, took no lock before evaluating the remaining allowance, and did not check whether the provider's adapter reported usage.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/trigger/run.ts reserveTriggerSpend", "src/trigger/config.ts rates validation", "src/trigger/record.ts closing-fact write path"],
      "enumeration_method": "Every exit path out of a dispatched run (normal close, provider throw, timeout, process kill) was traced to whether it left a cost record, and every ceiling check was traced to whether it held a lock while reading the ledger."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/commands/trigger-dispatch.test.ts describe(AC14) — 'two concurrent reservations for one trigger: exactly one gets the allowance (real overlap under the spend lock)', 'a killed run's reservation keeps counting until an operator resolves it with the real spend', 'a response with no usage stops the run, fails the attempt, and charges the whole reservation', 'a throw while writing the closing attempt still records the cost and closes the reservation', 'only providers known to report usage are accepted' all pass; src/trigger/config.test.ts 'malformed rates, a zero ceiling and a missing model are each named' pass. Re-run today: 181 pass / 0 fail across the 10 flow-290 test files, including these. Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "reserveTriggerSpend under the project-wide spend lock, keryx trigger resolve for killed runs, usage-reporting-provider allowlist, and zero-rate rejection at load; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-006",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "minor",
    "file": "src/trigger/run.ts",
    "quote": "worktree",
    "problem": "A run killed mid-flight left its worktree registered to the trigger branch; every later fire of that trigger's task failed at `git worktree add` with exit 1 forever, wedging the task.",
    "impact": "One killed dispatch permanently blocked all future dispatches for that task until an operator manually cleaned up the worktree registration.",
    "suggested_fix": "On the next dispatch, prune dead worktree registrations and remove a live one only if it sits under the dispatcher's own worktree parent; refuse rather than touch a branch checked out somewhere the dispatcher did not create.",
    "evidence": "The pre-fix dispatcher called `git worktree add` unconditionally with no recovery for a stale registration from a prior killed run.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/commands/trigger-dispatch.test.ts describe(AC15) — 'a live stale worktree left on trigger/<flow>-<task> under the dispatcher's parent is recovered', 'a registration whose directory is already gone is pruned', 'the branch checked out somewhere the dispatcher did not create is never touched — refused as a conflict' all pass. Re-run today: 181 pass / 0 fail. Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "recoverStaleWorktree prunes dead registrations and conflict-refuses a live one outside the dispatcher's parent; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-007",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "minor",
    "file": "src/lib/maintenance-lock.ts",
    "quote": ".locks",
    "problem": "The maintenance and dispatch locks lived under `.metaproject/data/`, which a post-commit hook's `git add -A` could commit while a build held the lock — confirmed happening to flow 286's own `.run.lock` — and inside the sandbox the git directory the locks used to live under could be read-only.",
    "impact": "A committed lock file corrupts the repository's tracked state with process-specific artefacts, and a lock path unwritable inside the sandbox would make the dispatcher's own `shell_exec` calls unable to take the maintenance lock at all.",
    "suggested_fix": "Move the locks to `.metaproject/data/.locks/`, self-ignoring via its own `*` `.gitignore`, kept writable inside the sandbox.",
    "evidence": "flow 286's `.metaproject/data/trigger/.run.lock` had already been committed by exactly this mechanism.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/lib/maintenance-lock.test.ts 'the held lock is never committed: `git add -A` while it is held stages nothing under .locks' passes; src/commands/trigger-dispatch.test.ts describe(T13) 'shell_exec under the real sandbox takes the worktree's maintenance lock; the lock dir is never committed' passes. Re-run today: 181 pass / 0 fail. Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "locks moved to .metaproject/data/.locks/ with a self-ignoring gitignore, writable inside the sandbox; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-008",
    "reviewer": "security-reviewer (trigger), review 1",
    "severity": "minor",
    "file": "src/trigger/config.ts",
    "quote": "baseUrl",
    "problem": "A dispatch entry's `baseUrl` was accepted unrestricted, so a merged `triggers.json` could redirect a provider call to an attacker-controlled endpoint and exfiltrate whatever credential the saved provider config sends it.",
    "impact": "Redirecting the provider baseUrl is a way to exfiltrate a saved API key regardless of which key is configured, since the redirection holds however the credential got there.",
    "suggested_fix": "Require `dispatch.baseUrl` to be loopback (localhost, 127/8, ::1) and reject anything else at config load.",
    "evidence": "The pre-fix config loader accepted any string as baseUrl with no host validation.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/trigger/config.test.ts flow 290 T13 describe block validates dispatch hardening at load. Re-run today: bun test src/trigger/config.test.ts — part of the 181-test / 0-fail run. Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "baseUrl loopback-only validation at config load; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-009",
    "reviewer": "security-reviewer (trigger), review 1 (found while fixing F-001-F-008)",
    "severity": "major",
    "file": "src/commands/trigger-dispatch.ts",
    "quote": "core.hooksPath",
    "problem": "The dispatcher's own `git add`/`commit` of the agent's work ran outside the sandbox, over agent-written content, with no hook isolation — a repository with in-tree hooks (`core.hooksPath=.githooks`, husky) would run agent-edited hooks with the operator's full rights at the moment the dispatcher committed.",
    "impact": "An agent could edit a tracked hook file and have it executed with the operator's rights the instant the dispatcher committed the branch, which is a full escape from the unattended posture the rest of the fix built.",
    "suggested_fix": "Run the dispatcher's own commit with hooks disabled (`-c core.hooksPath=/dev/null --no-verify`).",
    "evidence": "Found by the reviewer while verifying the T13 fix: the dispatcher's commit call had no `--no-verify` or hooksPath override.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/trigger-dispatch.ts dispatcher commit call"],
      "enumeration_method": "Every git operation the dispatcher itself runs (not the agent's shell_exec) was listed; the commit was the only one capable of executing tracked repository hooks."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/commands/trigger-dispatch.test.ts describe(T13: the dispatcher's own commit never runs repository hooks the agent could have written) test 'a tracked hooks dir (core.hooksPath) with a pre-commit hook does not run when the dispatcher commits' passes. Re-run today: 181 pass / 0 fail. Fixed in T13, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T13 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "the dispatcher's commit now runs with -c core.hooksPath=/dev/null --no-verify; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-010",
    "reviewer": "security-reviewer (trigger), review 2",
    "severity": "blocker",
    "file": "src/harness/process/sandbox/unattended.ts",
    "quote": "/run",
    "problem": "`--unshare-net` isolates IP networking but not AF_UNIX path sockets. The T13 profile bound the host's `/run` read-only into the sandbox, so a live probe with the network off still resolved names through systemd-resolved (a DNS exfiltration channel), listed the operator's tailnet through tailscaled (off-box egress), and connected to D-Bus and libvirt daemon sockets.",
    "impact": "A sandbox that believed itself network-isolated (network: false, the default) still gave an unattended agent name resolution and reachability into host daemons over unix sockets — a real exfiltration and lateral-movement channel the profile's own claim said was closed.",
    "suggested_fix": "Hide /run wholesale behind an empty tmpfs (like the home directory) rather than trying to mask individual sockets by name; bind back only the resolver file (not its directory) when network: true is set.",
    "evidence": "A live probe from inside the T13 sandbox with network off reached resolvectl, tailscale status and virsh qemu:///system successfully through sockets under the bound-in /run.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/harness/process/sandbox/unattended.ts filesystem plan (/run handling)"],
      "enumeration_method": "find / -type s (pruning /proc and /sys) was run from inside the sandbox in both network modes, and every socket found was checked for reachability; abstract-namespace sockets were checked separately since they are not filesystem paths."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/harness/process/sandbox/unattended.test.ts describe(AC13) T14-tagged tests — '/run is hidden wholesale (not socket-by-socket), and resolv.conf is bound back only for network: true', 'no unix socket anywhere is visible inside the sandbox (find / -type s is empty); /run is empty', 'a unix socket the test itself listens on under the host /run is unreachable from inside', 'abstract-namespace sockets are per network namespace — invisible with network off, visible with network on' all pass. Re-run today with the real launcher on this machine: bun test src/harness/process/sandbox/unattended.test.ts — 23 pass / 0 fail, confirming resolvectl/busctl/tailscale/virsh probes now fail from inside with network off. Fixed in T14, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T14 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "/run hidden wholesale behind an empty tmpfs, resolv.conf bound back only for network: true, the by-name Docker-socket mask removed as redundant; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-011",
    "reviewer": "security-reviewer (trigger), review 2",
    "severity": "minor",
    "file": "docs/docs/cli-reference.md",
    "quote": "network: true",
    "problem": "`dispatch.network: true` grants the agent's shell commands the host's full network — the internet and every host loopback service, plus the abstract-namespace unix sockets that ride the shared host netns — but this was not surfaced anywhere an operator setting the flag would see it.",
    "impact": "An operator opting a trigger entry into network: true for a narrow reason (e.g. one local service) would not know they had also granted general internet egress and every host loopback service, since the model call itself never needs network: true (it is made outside the sandbox).",
    "suggested_fix": "Print a NETWORK_ON_WARNING in `trigger list`, the run record's sandbox note, and `--help`, and state in the docs that the model call never needs it.",
    "evidence": "The pre-fix `trigger list`/`status`/`--help` output made no mention of what network: true actually grants.",
    "confidence": "high",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "src/commands/trigger.ts printHelp() states 'network: true gives the agent's shell commands the host's FULL network — the internet and every host loopback service. The model call is made outside the sandbox and never needs it.' src/commands/trigger-dispatch.test.ts describe(T14: dispatch.network: true is named for what it is) test '`trigger list` prints the full-network warning for an entry that sets network: true' passes. Read directly today: `bun run src/cli.ts trigger --help` prints this text verbatim. Re-run today: 181 pass / 0 fail. Fixed in T14, merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T14 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "NETWORK_ON_WARNING surfaced in trigger list, the run record and --help, plus the docs stating the model call never needs it; merged to main in 4752910c via PR #650."
    }
  },
  {
    "id": "F-012",
    "reviewer": "security-reviewer (trigger), review 2",
    "severity": "minor",
    "file": "docs/docs/cli-reference.md",
    "quote": "package.json",
    "problem": "The dispatcher installs/builds the trigger branch's own dependencies inside the sandbox to run the worktree's tests, which means `package.json` scripts (postinstall, pretest, etc.) on that branch run under the same sandbox as the agent's own commands — a known limit rather than a defect, but undocumented.",
    "impact": "An operator could assume the sandbox boundary also protects against a malicious dependency script on the trigger branch, when in fact such a script runs with the same rights any other command in the sandbox has (worktree-writable, network per the entry's setting).",
    "suggested_fix": "Document the limit explicitly: review the trigger branch before installing or building it.",
    "evidence": "No install-time isolation beyond the sandbox itself existed or was claimed; the gap was in the documentation, not the code.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "site-check",
      "evidence": "Journal T14 note (2026-09-22T23:45:36Z) records: 'Honest-limits sentence: review the trigger branch before installing or building it.' recorded as a documented limitation rather than a code fix. Verified present in the flow's own record; this finding closes as a documentation disposition, not a behaviour change. Merged to main in 4752910c via PR #650.",
      "verifier": "security-reviewer (trigger) T14 fix verification"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "documented as an honest limit ('review the trigger branch before installing or building it') rather than a claimed guarantee; merged to main in 4752910c via PR #650."
    }
  }
]
```

## Coverage

Reviewed: `src/commands/trigger-dispatch.ts`, `src/trigger/{config,run,record,unattended}.ts`,
`src/harness/process/sandbox/unattended.ts`, `src/lib/maintenance-lock.ts`,
`src/commands/trigger.ts` and its `--help` text, `docs/docs/cli-reference.md`, `README.md`, and
the full flow-290 test suite (`src/commands/trigger-dispatch.test.ts`,
`src/commands/trigger-unattended.test.ts`, `src/trigger/config.test.ts`,
`src/lib/maintenance-lock.test.ts`, `src/commands/maintenance-lock.e2e.test.ts`,
`src/harness/process/sandbox/unattended.test.ts`, `src/trigger/run.test.ts`,
`src/commands/trigger-run.e2e.test.ts`, `src/commands/trigger-run-open-flow.e2e.test.ts`,
`src/lib/gdgraph-post-commit.test.ts`). Not reviewed: the rest of the repository, unchanged by
this flow.

| reviewer | status | reason |
|---|---|---|
| security-reviewer (trigger), review 1 | run | initial T5-T11 implementation: health gate, sandbox containment, spend accounting |
| security-reviewer (trigger), review 2 | run | T13 fix, live probes from inside the sandbox: /run AF_UNIX sockets, network: true scope |
| security-reviewer (trigger), review 3 | run | T14 fix, re-ran the same live probes; boundary holds, no findings |

## Outcome

Twelve findings across two rounds: two blocker, six major, four minor — all acted on and
re-verified against the merged code (`4752910c`, PR #650), none dismissed. A third review pass,
re-running the same live sandbox probes (credential file, exported token, network reachability,
unix sockets in both filesystem and abstract namespace) against the T14 fix, found no new gap:
the boundary holds. Two limits are recorded rather than fixed, both documented in
`docs/docs/cli-reference.md`: `dispatch.network: true` is the host's full network including
abstract-namespace sockets riding the shared netns (F-011), and dependency-install scripts on
the trigger branch run inside the same sandbox as the agent's own commands, so the branch should
be reviewed before installing or building it (F-012).
