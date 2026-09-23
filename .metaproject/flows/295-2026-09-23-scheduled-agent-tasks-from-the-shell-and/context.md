# Context

Collected deterministically by `keryx flow init` at 2026-09-23T05:23:44.153Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [2.073] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
2. [1.894] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.864] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
4. [1.791] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
5. [1.721] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Phase 1 research, 2026-09-23, worktree `/home/altsay/keryx-sched` (branch `feat/scheduler`,
from main 0.2.155). Research and a draft only: no source code changed.

### 0. The operator's request, and the decision it reverses

Voice, 2026-09-23: "in the TUI, in a dialogue with the agent, I say 'schedule me a task every
4 hours to check GitHub', and it does this in the background automatically."

Flows 286 and 290 decided the opposite in two places. This flow reverses both, and only with
the operator's confirmation:

- `src/trigger/config.ts:28-43`: `triggers.json` is hand-edited and keryx never writes it.
- `src/trigger/schedule.ts:1-3, 199-202`: `keryx trigger schedule` prints a cron line or a
  systemd unit, and keryx "does not run a daemon of its own". `src/commands/trigger.ts:845`
  prints "keryx runs no daemon for this — install ONE of the two below".
  `docs/docs/cli-reference.md:1262` and `README.md:454-455` document that behaviour.

Keryx still does not run a daemon. It asks the OS scheduler (systemd `--user`, launchd or
cron) to call `keryx trigger run <name>`. This flow changes three things: keryx writes the
entry, keryx installs the timer, and the run can be a free-form agent task.

### 1. Trigger machinery we build on

**Config: `src/trigger/config.ts`**
- Vocabulary. `TRIGGER_EVENT_NAMES` is at :62. `TRIGGER_ACTION_KINDS = ["reconcile",
  "rebuild", "open-flow", "flow-next"]` is at :66. `TriggerFire` has two shapes, event or
  `{kind:"schedule", cron}` (:94-96). The cron check is shape-only (:72-88).
- `TriggerDispatch` (:114-130) holds provider, model, `permissionMode` (`ask`|`trust`, and
  `auto` is refused at :240-244), rates (required and positive, :252-270), `ceilingUsd`
  (required, :271-277), `maxSeconds` (default 1800), `maxAttempts` (default 3), `baseUrl`
  (loopback only, :284-298, because a committed file must not redirect the saved key) and
  `network: boolean` (default false, :299-301, :330).
- Loader `loadTriggersConfig` (:458-536). It never throws, keeps the reason for each rejected
  entry, and the first duplicate name wins. The path is `.metaproject/triggers.json` (:441-443).
- This loader is where a new `agent-task` action kind is added. Today's `dispatchProblems`
  validation is reusable almost as it is.

**Run path: `src/commands/trigger.ts`, `src/trigger/run.ts`**
- `triggerCommand` switch (:94-123): run, install, uninstall, list, status, schedule, resolve.
- `runTrigger` (:153-200) resolves the name with `resolveTriggerForRun` (`run.ts:59-80`).
  An absent config or a disabled entry exits 0. A broken config, an unknown name or a
  rejected entry exits 1.
- `runReadyTrigger` (:202-271) branches on `action.kind` for `open-flow` and `flow-next`
  (:211-218). A new kind needs its own branch here.
- The run uses `process.cwd()` as the project root (:140). A timer must therefore set its
  working directory.
- `withTriggerRunLock` (`run.ts:137-174`) is the project maintenance lock, taken with
  `waitMs: 0`. `flow-next` dispatch uses a per-flow lock instead
  (`trigger-dispatch.ts:144-146, 405-434`). An agent task needs a per-schedule lock of the
  same kind, so one schedule never runs twice at once.

**Dispatch: `src/commands/trigger-dispatch.ts`**
- The 10 steps are listed at :11-42. We reuse five of them unchanged:
  - containment decision (:502-534)
  - the provider must report usage (`providerReportsUsage` :195-198, `defaultMakeProvider`
    :201-225)
  - `guardUsage` (:232-252)
  - spend reservation (:549-567)
  - the priced cost and spend stop (:571-582, :684-691)
- The agent turn is `runAgentTurn` with `unattended: true` and `hardDeny: unattendedRefusal`
  (:665-678). Its `permissionMode` comes only from the entry (:695). Every approval request is
  denied and recorded (:697-712).
- The roster is `buildUnattendedRoster` (:128-141): read tools, `shell_exec` (sandboxed
  runner, :350-361) and `apply_patch`. It throws if an excluded tool slips in.
- The model call runs in the dispatcher, outside the sandbox (:111-119, `NETWORK_ON_WARNING`).
  Sandbox network therefore only matters for the agent's shell commands.
- The task prompt is `buildTaskPrompt` (:329-340) and is specific to flow tasks. An agent task
  needs its own prompt builder. Its preamble should say "unattended, nobody present" and "the
  last message you write is the report".
- The flow-specific parts do not apply to an agent task: flow checks (:464-500), the
  `trigger/<flow>-<task>` worktree (:596-627), task attempt and done, commit, and the health
  gate. An agent task needs a scratch working directory plus the project root read-only, not
  a git worktree on a branch.

**Unattended sandbox: `src/harness/process/sandbox/unattended.ts`**
- It uses allow lists (:13-30):
  - `/` is read-only.
  - `$HOME`, `/run`, `/var/run` and `XDG_RUNTIME_DIR` are hidden behind tmpfs (:181-204).
  - `/tmp` is a private tmpfs (:179).
  - Toolchain roots from PATH are bound back read-only (:94-110, :218).
  - The worktree and scratch home are read-write (:221).
  - The secret deny list is applied inside anything bound back (:225-230).
- `--unshare-net` is added unless `network` is set (:232). With `network: true`, only the
  resolv.conf file is re-bound (:206-213). There is no restricted mode today.
- The environment is an allow list: `UNATTENDED_ENV_ALLOWLIST` (:44-55) plus HOME and XDG set
  to the scratch dir (:235-248). No token and no `SSH_AUTH_SOCK` passes.
- Linux (bwrap) only. On any other platform it refuses (:161-166). The operator's opt-outs
  refuse too (:154-160).

**Floor: `src/trigger/unattended.ts`**
- `UNATTENDED_EXCLUDED_TOOLS` (:43-50): web_fetch, web_search, search_tool, use_tool,
  spawn_subagent, ask_user.
- Forbidden flow verbs, including nested `trigger run` (:53-64).
- Forbidden git verbs: push, merge, tag, update-ref, and branch moves (:67-70, :118-126).
- Mutating `gh api` (:127-133). Publish commands (:77-81, :140-142).
- Protected paths: `flow.json`, `acceptance-criteria.md`, `triggers.json`, `data/trigger/`
  (:84-100, :145-148). Patch targets (:153-172).
- `unattendedRefusal` (:180-191) is consulted before the permission mode.
- The file says this is defence in depth, not the boundary (:12-20). The boundary is the
  sandbox, which has no network and no credentials.
- New work must extend the floor: add the schedule store and report paths to
  `isUnattendedProtectedPath`, and add a nested `schedule` create or install to
  `FORBIDDEN_FLOW_VERBS`.

**Spend: `src/trigger/run.ts:292-333` (`reserveTriggerSpend`) and `:362-417`
(`evaluateTriggerBudget`)**
- Reservation happens under the project-wide `spend.lock` (:276-278). It reserves the smaller
  of the project remaining and the trigger remaining.
- The project ceiling is `evaluateSpendCap`'s default of $3 (`review/caps.ts`, cited at
  :189-194).
- An unreadable ledger refuses (:369-385). Open reservations count at full value (:269-271).
- It is hard-wired to `evaluateTriggerBudget(projectRoot, "flow-next", …)` (:308). The action
  label must become a parameter.

**Ledger: `src/trigger/record.ts`**
- Append-only `.metaproject/data/trigger/runs.jsonl` (:53-59, :219-239).
- Outcome kinds are at :87-96. `TriggerDispatchRecord` (:144-154) is flow-shaped (`flow` is
  required). An agent task needs an additive optional block (for example
  `agentTask: {runId, reportPath, grantsHash, grantedToolCalls[]}`) or a `flow`-less variant.
- `openReservations` (:193-209) closes a reservation by `dispatch.runId` or `resolves`. A new
  record must carry the runId in a field that this function reads.
- `latestRunByTrigger` (:300-304) is what `/schedules` would use for "last outcome".
- `git check-ignore` says `runs.jsonl` is NOT ignored, so the ledger is committable. Reports
  hold private GitHub content, so they must go in an ignored directory.

**Governance: `src/governance/spend.ts:99-125` (`readProjectTriggerSpend`)**
- It sums `cost.usd` over every record in `runs.jsonl`, project-wide and never attributed to a
  flow (`report.ts:139, :200-202`).
- Scheduled agent-task runs recorded in the same ledger appear there with no governance code
  change.
- The acceptance test extends `governance/report.test.ts`'s AC2 cases (:139-192) with an
  `agent-task` record.

**Schedule renderer: `src/trigger/schedule.ts`**
- It bakes in absolute `process.execPath` and `argv[1]` (:55-69, rationale :8-26).
- It sets an explicit `PATH=<interpreterDir>:/usr/local/bin:/usr/bin:/bin` (:211-215), `cd` or
  `WorkingDirectory=` to the project root, and a `mkdir -p` log dir (:216-229).
- Escaping is correct and documented. systemd quoting applies only to `Exec*=` and
  `Environment=`, and `%` is doubled everywhere (:92-183). Cron `%` is escaped in the line
  only (:139-151, :235).
- `schedule.test.ts:197-240` runs the real `systemd-analyze verify` on a path with a space.
  It is skipped when that tool is absent. The e2e test runs `cronCommand` through `/bin/sh -c`
  (`src/commands/trigger-schedule.e2e.test.ts`).
- Gaps found:
  1. **The timer has no `OnCalendar=`.** It is a commented placeholder asking the operator to
     translate the cron by hand (:264-267). A timer installed as it is would never fire.
     Installation therefore needs cron→OnCalendar translation, or a native interval stored in
     both forms.
  2. Unit names are `keryx-trigger-<name>` (:237-238). Two projects that both use
     `check-github` would collide in `~/.config/systemd/user/`. Names need a project
     discriminator (a short hash of the real project root).
  3. The service comment says "install under /etc/systemd/system/" (:244). A user install must
     only ever target `--user`.
  4. The baked PATH does not contain `~/.local/bin`. That matters for a granted `gh` here:
     `gh` is the `~/.local/bin/gh` wrapper that chooses the account by cwd, and the real binary
     is `~/.local/lib/gh/gh-bin`. A granted command must store an absolute binary path (and
     `GH_CONFIG_DIR`) resolved at confirmation time.

### 2. A new action kind: `agent-task`

Proposed as a separate kind, not an extension of `flow-next`. It has no flow, no task, no
worktree branch, no commit and no health gate.

```jsonc
{ "name": "check-github", "on": { "kind": "schedule", "cron": "0 */4 * * *" },
  "action": { "kind": "agent-task",
    "prompt": "Check open PRs and issues on MrCipherSmith/keryx and summarise what needs my attention.",
    "dispatch": { "provider": "anthropic", "model": "…", "permissionMode": "ask",
                  "rates": {…}, "ceilingUsd": 0.5, "maxSeconds": 600 },
    "grants": { "network": "off", "tools": ["gh.pr.list", "gh.pr.view", "gh.issue.list"],
                "repos": ["MrCipherSmith/keryx"] },
    "report": { "keep": 20 } },
  "enabled": true }
```

What the dispatched turn needs:

- **Prompt.** It is free text from the operator. The dispatcher wraps it in a fixed preamble:
  "unattended; nobody can answer; your final message is the report; do not change the
  repository".
- **Mode.** `ask` is the default and is recommended. Under `ask`, every non-read call is denied
  (`trigger-dispatch.ts:23-26`), and granted tools are read-risk, so they still run. `trust`
  stays allowed, but only with the sandbox (`:522-531`). `auto` is refused, as it is today.
- **Budget.** Everything in `TriggerDispatch` is reused: rates, `ceilingUsd`, `maxSeconds`.
  `maxAttempts` means nothing without a task, so drop it or ignore it.
- **Report.** The agent's final assistant text is written by the DISPATCHER, not the agent, to
  `.metaproject/data/trigger/reports/<name>/<runId>.md`, together with a header (time, outcome,
  cost, granted calls made, denials). Reasons for this location:
  - it is under `data/trigger/`, which the floor already protects (`unattended.ts:98`), so the
    agent cannot forge or overwrite a report;
  - `reports/` must be gitignored;
  - the ledger record carries `reportPath`.
  - Keep the last N reports.
- **Grants.** See section 3.
- **Working directory.** The agent gets a scratch directory, not a git worktree. The project
  root is bound read-only if the prompt needs the code. The roster is the read tools plus the
  granted tools, and `shell_exec` only if the grants ask for it. `apply_patch` is never offered
  to an agent task in v1.

### 3. Grants: the crux

"Check GitHub" needs two things the unattended sandbox deliberately hides: the network and the
operator's gh credentials (`unattended.ts:24-27`).

**3a. Network mode. Probed on this host (Ubuntu 24.04.4, bwrap 0.9.0).**
- `slirp4netns` 1.2.1 is installed. `pasta` and `passt` are not installed. `socat` is not
  installed.
- `kernel.apparmor_restrict_unprivileged_userns=1`. `bwrap` and `slirp4netns` both have their
  own AppArmor `userns` profiles (`/etc/apparmor.d/{bwrap,slirp4netns}`). A plain
  `unshare --user --net` is DENIED (audit: `profile="unprivileged_userns"
  capability=21 sys_admin`).
- Live probe (scratchpad `probe.sh`):
  - I started `bwrap --unshare-net --info-fd 3` and attached
    `slirp4netns --configure --disable-host-loopback <child-pid> tap0` to the child, both
    with and without `--userns-path=/proc/<pid>/ns/user`.
  - Both failed with **`setns(CLONE_NEWNET): Operation not permitted`**. The sandbox only had
    `lo`, and DNS and the external call failed.
  - So "internet only, no host loopback" through slirp4netns attached to bwrap's netns is
    **not proven feasible on this host**. The composition that should work is the
    rootlesskit/podman one: create the userns and netns first, attach slirp4netns, then run
    bwrap inside with `--userns`. It needs a namespace holder process that AppArmor allows,
    and more research. pasta is absent.
- **A better fit that the codebase already half-has:** the domain-allowlist proxy from flow
  098.
  - `src/harness/process/sandbox/proxy.ts` is a loopback CONNECT proxy with
    `matchesAllowlist` and `*.domain` wildcards (:1-45).
  - `src/harness/process/sandbox/network-run.ts` handles the run lifecycle and optional
    credential masking (:1-60).
  - `profile.ts:21-26` defines `SandboxNetwork = "off" | "on" | "restricted"`.
  - But `capability-matrix.ts:37-42` marks **Domain allowlist and Credential masking as
    `not-implemented` on Linux (fails closed)**. They are supported on macOS seatbelt only.
  - The Linux implementation is known:
    - keep `--unshare-net`;
    - have the proxy listen on a unix socket in the scratch dir and bind it in (AF_UNIX path
      sockets cross network namespaces, see `unattended.ts:28-29`);
    - run a tiny relay inside the sandbox from `127.0.0.1:<port>` to the socket. It would be
      keryx's own bun script, since socat is absent;
    - set `HTTPS_PROXY`.
  - `gh` is Go and honours `HTTPS_PROXY`, and a CONNECT tunnel needs no TLS interception.
  - This gives "only api.github.com / github.com, nothing on the host loopback, no other
    internet". That is strictly tighter than "internet-only".
- Proposed network grant: `off` (default) | `allowlist` (domains, Linux via the unix-socket
  relay) | `full` (today's `network: true`, shown with `NETWORK_ON_WARNING`).
  `internet-only` via slirp4netns/pasta stays a researched option, offered only if a
  capability probe passes.
- For the "check GitHub" case, the recommended design (3b) needs **no sandbox network at
  all**.

**3b. Read-only granted commands, and where the credential lives. Two options:**

(A) Put `GH_TOKEN` or `~/.config/gh` into the sandbox and allow `gh` in `shell_exec`.
- Rejected.
- The token becomes readable by the model. Anything the agent runs can `echo $GH_TOKEN` or
  `cat hosts.yml`, and with network the token can leave the box.
- The floor is string matching and was bypassed (`unattended.ts:12-20`, the lesson
  "allowlist is not a boundary" in memory).
- A PR body is untrusted text the model reads, so prompt injection could steer that shell.

(B) A **granted tool** (recommended).
- The dispatcher registers each granted command as a named tool, for example
  `gh_pr_list(repo, state?)`, with a fixed argv template.
- Keryx runs it itself with `execFile`, OUTSIDE the sandbox, with the operator's credentials.
  The model only ever gets the (scrubbed) stdout.
- Rules:
  - there is no shell;
  - parameters are checked against strict patterns, so there are no leading `-` flags and no
    free text into argv;
  - the binary path and `GH_CONFIG_DIR` or account are resolved and shown at confirmation;
  - there is a per-call timeout and an output cap;
  - output passes through `redactSensitiveText` (`src/security/redact.ts:128`) before it
    reaches the model;
  - every call is recorded in the ledger record.
- Tool risk is `read`, so granted tools run under `ask`. The result is marked as untrusted
  origin: under `ask`, every later non-read call is denied anyway, and under `trust` the
  untrusted-origin gate (`agent.ts:113-126`) denies it unattended.
- Why (B) is safer:
  - the secret never enters the model's process tree or context;
  - the model cannot widen the grant beyond the argv templates;
  - the sandbox keeps network `off`, so even an injection-driven shell command has nowhere to
    send anything;
  - the grant is a finite, displayable list the operator confirms.
- Ship a built-in catalogue in v1 rather than free-form argv: `gh pr list|view|checks`,
  `gh issue list|view`, `gh run list`, and `git fetch` (it writes `.git` refs, so label it
  "read-mostly"). Never `gh api`. A custom argv grant can come later.

**The floor stays non-liftable.**
- Grants add tools and network. They never remove any rule in `unattended.ts`, which is still
  consulted before any grant.
- No grant can name push, merge, tag, publish, flow-state verbs or protected paths.
- Catalogue entries are validated against `unattendedShellRefusal` at load. For example, a
  grant whose argv is `gh pr merge` fails to load.
- **Grants live where only the operator writes them.**
  - The baseUrl precedent (`config.ts:284-298`) says a committed `triggers.json` must not be
    able to move credentials.
  - A timer re-reads the config on every fire (`schedule.ts:228`). A teammate's merged edit to
    a committed file could therefore silently change the prompt or grants behind an installed
    timer.
  - Recommendation: operator-created schedules go in a per-machine, uncommitted store (see
    contentious choice C1).
  - At confirmation, keryx records a `confirmedHash` of prompt+grants+dispatch.
  - `trigger run` refuses (`grants-changed`) if the entry no longer matches its hash.

### 4. Installing schedules

- **systemd `--user` (Linux, primary).**
  - Write `~/.config/systemd/user/keryx-<projhash>-<name>.{service,timer}`, then
    `systemctl --user daemon-reload` and `systemctl --user enable --now <timer>`.
  - Uninstall with `disable --now`, remove the files and `daemon-reload`.
  - List with `systemctl --user list-timers --all --output=json` (systemd ≥ 252) or
    `show -p NextElapseUSecRealtime,LastTriggerUSec <timer>`.
  - Idempotent: rewrite the files only when the content differs, and put a
    `# keryx-managed <projhash> <name> <confirmedHash>` header line in each file, so list and
    uninstall only ever touch keryx-owned units.
  - `Persistent=true` is already rendered (:268). A run missed while powered off fires once at
    the next boot or wake.
  - Here, `systemctl --user is-system-running` = running and two user timers exist.
- **Linger.**
  - User timers only run while the user has a session unless linger is on. Here
    `loginctl show-user altsay -p Linger` = `yes`.
  - Keryx must detect linger and SAY so in the confirmation ("runs only while you are logged
    in" or "runs when logged out (linger on)").
  - It must never run `loginctl enable-linger` silently. It may print the command.
- **launchd (macOS).**
  - `~/Library/LaunchAgents/ai.keryx.<projhash>.<name>.plist` with `StartCalendarInterval` (a
    list of dicts, no cron ranges, so translation is needed) or `StartInterval` seconds, and
    `WorkingDirectory`, `EnvironmentVariables.PATH` and `StandardOutPath`.
  - `launchctl bootstrap gui/$UID <plist>` / `bootout`.
  - LaunchAgents run only while the user is logged in. A calendar interval missed during sleep
    runs once on wake.
  - Caveat: the unattended sandbox is Linux-only (`unattended.ts:161-166`). On macOS an
    agent task can run only in `ask` with no `shell_exec`. Granted tools still work because
    they run outside the sandbox. `trust` refuses, as today.
- **cron (fallback).**
  - `crontab -l`, then replace a `# >>> keryx <projhash> <name> >>>` … `# <<<` block, then
    `crontab -`. This follows the managed-hook block pattern.
  - There is no catch-up for missed runs.
  - Uses the existing `cronLine` (:235).
- **Correct project root and PATH.**
  - Yes. The renderer already bakes in the absolute interpreter and script, an explicit PATH
    and `WorkingDirectory=`/`cd` (:204-259).
  - The `trigger run` path uses `process.cwd()` (`trigger.ts:140`), so `WorkingDirectory=` is
    enough.
  - Provider keys come from keryx's saved keys (`envWithSavedApiKeys`,
    `trigger-dispatch.ts:211`). HOME is set for user services, so that works.
  - Run `bun run src/cli.ts` from a checkout pins the dev tree. The confirmation must show the
    exact `ExecStart` it will install.
- **Must never happen silently:**
  - writing any unit, plist or crontab;
  - enabling or starting a timer;
  - enabling linger;
  - changing grants on an installed schedule;
  - installing at a cadence other than the one shown.
- Each of these requires an explicit operator confirmation that shows: the cadence (cron plus
  the next 3 run times), the prompt, provider and model, ceiling and maxSeconds, network mode,
  each granted tool with its account, the unit paths and `ExecStart`, and linger status.
- An agent (interactive or unattended) can never self-confirm:
  - The TUI tool path goes through `requestApproval` with an always-ask meta, like
    `credentials` (`agent.ts:85-90`): never auto-approved, never remembered, never "always
    allow", in any permission mode including `auto`.
  - The unattended floor forbids schedule create and install verbs.

### 5. Shell/TUI surface

- **Slash registry.** `AGENT_SLASH_COMMANDS` (`src/commands/agent-commands.ts:61`, shape at
  :35-48, modes :50-52). Handlers are `if (command.name === "/goal")`-style blocks in
  `src/tui/tui-shell.ts` (e.g. :6383, :6557 `/bus`, :6698 `/queue`, dispatch at :6305/:6730).
  Registry tests pin the list (`agent-commands.test.ts:22-23`, `shell-slash-registry.test.ts:86`).
- **Proposed commands:**
  - `/schedule` (guided create: prompt, cadence, grants, then a confirmation card);
  - `/schedules` (list: name, cadence, enabled, installed?, next run, last outcome and cost,
    report pointer);
  - `/schedule pause|resume|delete|run-now|show <name>`.
- **Agent tool `schedule_create`** (and `schedule_list`, which is read-only).
  - Input: `{name, prompt, cadence (e.g. "every 4h" or cron), grants{network, tools, repos},
    budget}`.
  - Risk: `write` plus the always-ask meta.
  - The tool validates, renders the SAME confirmation card as `/schedule`, and only after a
    yes writes the entry and installs the timer. A no or a timeout writes nothing.
  - The model proposes grants. It cannot confirm them.
  - Approval is rendered by the TUI's `io.requestApproval` (`tui-shell.ts:3922`).
  - Natural-language cadence ("every 4 hours") is turned into cron and OnCalendar by
    deterministic code, and the card shows the next run times so the operator can catch a
    wrong translation.
- **Results.** Reports are `data/trigger/reports/<name>/<runId>.md`. `/schedules` shows the
  last outcome and `open <report>`. On TUI start there is a one-line notice, "2 new scheduled
  reports (check-github ✓, nightly-deps ✗)", using a per-user `seen` marker. A
  `/schedule show <name>` renders the latest report in the transcript.
- **CLI parity.** `keryx schedule add|list|pause|resume|remove|install|uninstall|show`, or
  extending `keryx trigger` with the same verbs. Needed for tests and for non-TUI users.
- **ACP/Zed.** Out of scope for this flow. `src/harness/external/acp-permission.ts:154` maps
  `network` to deny today. Scheduling from Zed can come later with the same confirmation
  contract.

### 5b. Sidebar section and detail modal (operator requirement added 2026-09-23)

The operator's words: scheduled tasks appear in the sidebar in compact form (name, next run,
last outcome). Clicking one opens a modal with the schedule, grants, last runs and last
report, with pause, resume, delete and run-now.

The seams already exist:

- **Sidebar structure.**
  - `shell-chrome.ts:380-392, 644-671` creates `sidebarTop`, a ScrollBox content column the
    caller fills with panels.
  - `tui-shell.ts:3500-3564` adds sections in order: Context, Tools (a clickable row, :3504-3512),
    Status, `sb-subagents`, `sb-plan`, `sb-jobs`.
  - Each dynamic section is a hug-content `BoxRenderable` (`flexShrink: 0`). The file explains
    why at :3522-3524: a growing ScrollBox covers the labels on a real pty. A new `sb-schedules`
    box goes in the same list.
- **Panel pattern to copy.**
  - `src/tui/execution-plan-panel.ts:80-146`, `mountExecutionPlanPanel(otui, renderer, parent,
    {width, maxRows, onOpen})`. It:
    - returns `{refresh, dispose}`;
    - repaints only when its revision changes (:106);
    - guards stale async refreshes with a generation counter (:124-130);
    - makes the header and every row clickable through `onMouseDown: onOpen` (:114-121).
  - It is mounted at `tui-shell.ts:3538-3554` and disposed through `disposeExecutionPlanPanel`.
  - `paintSubagentSidebar` (`subagent-inspector.ts:208-247`) is the per-row variant: each row
    has its own `onMouseDown(() => onOpen(id))`. Schedules need that variant, one row per
    schedule that opens that schedule's modal.
  - Row text should reuse the width-bounded formatting idiom (`SIDEBAR_TEXT_WIDTH`,
    `sidebar-metrics.ts`).
- **Modal host.**
  - `src/tui/modal-host.ts` provides `openModal(otui, chrome, {title, tabs, initialTab,
    footer, renderTab, onArrowKeys, onClose, contentRows})` and returns
    `{close, setTab, activeTab}` (:37-60).
  - It is one overlay: opening a modal replaces the current one instead of stacking
    (header :1-8).
  - Tab-based examples:
    - `subagent-inspector.ts:104-180`: Work and Meta tabs, live refresh through a store
      subscription, unsubscribing in `onClose`.
    - `workspace-inspector.ts:169-248`.
    - `mcp-inspector.ts`.
  - Proposed tabs: **Overview** (cadence, next or last run, enabled, installed unit and linger),
    **Grants** (network mode, granted tools with account), **Runs** (last N ledger records with
    outcome and cost) and **Report** (the latest report, scrollable).
- **Actions in a modal.**
  - `mcp-inspector.ts:577-609` has per-modal key handling through `options.onKeypress`. A
    destructive action is two steps, **arm then confirm**: `c`/`d` arms, only `y` confirms,
    and any other key cancels. It mirrors review-inspector's `[a]`-then-`[y]` gate.
  - The footer lists only keys that work on every tab. Tab-specific keys go on the tab's first
    body line (`MCP_INSPECTOR_FOOTER` and `MCP_TAB_KEYS`, :33-46).
  - Proposed keys: `p` pause or resume (single step, reversible), `r` run-now (arm then `y`,
    because it spends money), `x` delete (arm then `y`, uninstalls the timer).
  - All of these call the same functions as the CLI, `keryx schedule
    pause|resume|run|remove`.
- **Keyboard access.**
  - The sidebar has no focus target: `shell-chrome.ts:1067-1086` says it is display-only and
    explains why making it focusable would create a keyboard dead zone.
  - So keyboard access has to go through the existing route: a slash command. `/schedules`
    opens a list modal (↑/↓ select, Enter opens that schedule's detail modal, Esc closes),
    just as `/integrations` (`MCP_TOOLS_COMMAND`, `mcp-inspector.ts:48`) and `/workspace`
    reach their modals.
  - Mouse and keyboard reach the same modal.
- **Updates from a background run.**
  - The scheduled run is a DIFFERENT process (systemd), so no in-process subscription such as
    `subscribeExecutionPlans` (`execution-plan-panel.ts:131`) fires.
  - The codebase's cross-process idiom is polling with injectable timers: the bus client
    polls every `BUS_POLL_MS_DEFAULT = 1500` ms (`src/bus/enabled.ts:38-47`) through a
    `timers.setInterval` seam that tests fire deterministically (`src/bus/client.ts:126-131,
    657`).
  - Recommendation: the schedules panel stats `runs.jsonl` (size and mtime) and the reports
    dir on an injectable interval (for example 5 s). It re-reads and repaints only when they
    change, and repaints the next-run countdown each minute.
  - `fs.watch` is an optional accelerator, not the mechanism: it is unreliable across
    platforms and editors.
  - Test: append a record to a fixture ledger, fire the injected timer, and assert the row
    text changed without remounting.
- **Theme.** Sidebar rows must be painted from theme slots, so the theme-switch recolor walk
  (memory lesson `theme-switch-repaint`, `shell-chrome.ts:270 recolorThemeTree` over
  `sidebarTop`, :1446) covers them.

### 6. Governance

- Scheduled runs append to the same `runs.jsonl`. `readProjectTriggerSpend`
  (`governance/spend.ts:99-125`) picks up their cost unchanged.
- The run's `reserved` record and the closing record both carry the runId, so
  `openReservations` closes it and a killed scheduled run stays counted until
  `keryx trigger resolve`.
- `keryx trigger status` and `/schedules` read the same record.

### Honest limits

- The machine must be on. A suspended laptop misses runs. With systemd `Persistent=true`, one
  catch-up run fires on the next boot or wake (not one per missed slot). launchd also coalesces
  missed runs into one. cron does not catch up.
- Without linger, systemd user timers do not run while the user is logged out.
- The hardened sandbox is Linux-only. macOS agent tasks are `ask` with granted tools only.
- The domain-allowlist network is not implemented on Linux yet, so it is new work. The
  slirp4netns attach was not feasible on this host as tried.
- The floor is text analysis (defence in depth). The boundary is still the sandbox plus
  granted tools running outside it.
- Granted tools' output (PR and issue bodies) is attacker-controllable text. Under `ask` it
  cannot trigger any write, but it can mislead the report.
- Cost is bounded per run by the reservation and per schedule by `ceilingUsd`. Once the
  ceiling is reached the schedule keeps firing but records `budget-refused`, which
  `/schedules` shows.

### Contentious design choices (recommendation first)

- **C1. Where operator-created schedules live.**
  - Recommended: a per-machine, gitignored store, `.metaproject/data/trigger/schedules.json`.
    Keryx writes it. It sits under the floor-protected `data/trigger/`, and the loader merges
    it with `triggers.json`. Each entry carries a `confirmedHash`.
  - Alternative: keryx writes `triggers.json`. Rejected. That file is committed, so a merged
    edit could change the prompt or grants behind an installed timer (the `baseUrl`
    precedent, `config.ts:284-298`). Keryx would also become a writer of a file whose design
    says "keryx never writes it".
- **C2. How credentials reach "check GitHub".**
  - Recommended: granted tools that keryx executes outside the sandbox (3b).
  - Alternative: `GH_TOKEN` in the sandbox env. Rejected: the model and any command could
    read it.
- **C3. The network mode.**
  - Recommended: `off` | `allowlist` (the Linux unix-socket bridge to the existing flow-098
    proxy) | `full`.
  - `internet-only` through slirp4netns failed on this host (setns EPERM), and pasta is
    absent. Defer it behind a capability probe.
  - For the GitHub use case, granted tools make sandbox network unnecessary. `allowlist`
    could be moved to a follow-up flow if scope must shrink, but that would leave AC4 as
    "fails closed".
- **C4. A new action kind vs extending `flow-next`.**
  - Recommended: a new `agent-task` kind. Every flow-next step except the model, sandbox and
    spend parts is flow-specific. Extract the shared pieces (containment, provider guard,
    reservation, spend stop) into a helper both kinds call.
- **C5. The default permission mode for agent tasks.**
  - Recommended: `ask`. It is read-only in effect, and granted tools still run because they
    are read-risk.
  - `trust` stays available, but it is shown in the card as "the agent can run shell
    commands in the sandbox".
- **C6. Command namespace.**
  - Recommended: a new `keryx schedule …` family for operator verbs, which is friendlier.
    Underneath, it stays `trigger run <name>` plus one ledger, so governance and status do not
    fork.
- **C7. Keyboard access to the sidebar.**
  - Recommended: a `/schedules` list modal. Making the sidebar focusable is explicitly
    rejected by `shell-chrome.ts:1067-1086`.

### Routing audit

- graph_used: no. Target files were named in the brief and confirmed by listing, so a
  blast-radius query was not needed for phase 1.
- wiki_used: no (not-relevant; trigger design lives in the flow 286/290 code comments cited
  above).
- ctx_used: yes (`keryx ctx read`, `keryx ctx rg`).
- memory_used: yes (`keryx memory search`, no trigger entries).
- raw_rg_used: no. Raw shell was used only for host probes (bwrap, slirp4netns, systemd,
  AppArmor), marked `keryx:raw`.
