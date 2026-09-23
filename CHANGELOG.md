# Changelog

All notable changes to `keryx` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.2.159] — 2026-09-23

A new user can now find their way in. `keryx help` and a tabbed `/help`
group every command by the steps a user takes to start, the README and the
onboarding page walk the first session in that order, and every page on the
docs site was checked against the code. A schedule can no longer be created
for a provider that cannot be priced.

### Added
- **`keryx help` — every command, grouped by the steps to get started.** One
  table places each CLI verb and each shell slash command in one of nine
  groups: start here, connect a model provider, look and feel, working in
  keryx shell, project knowledge, managed work, automation, external agents
  (ACP and MCP), and maintenance. `keryx help` prints them all within 80
  columns, `keryx help <group>` prints one, `keryx help <command>` or
  `keryx help /<slash>` prints that command's usage, and a typo gets the
  closest matches. A test fails when a command is in no group or in two;
  internal helpers and aliases are hidden with a reason. `keryx --help`,
  `-h` and a bare `keryx` still print the flat usage block, now with one line
  naming `keryx help`. (flow 303)
- **`/help` in the shell opens a modal with a tab per group** and a detail
  view per command; left and right switch tabs, up and down move, Enter shows
  usage, Esc closes. It opens during a turn too. The readline shell and ACP
  editors get the same grouping as text. The first shell run with no model
  provider connected opens it on the provider tab, once; the check runs in
  the background and never delays the composer. (flow 303)
- **Commands by task** on the docs site is generated from the same table, so
  it cannot drift from the code. (flow 303)
- **The start screen names `/help`**, and the shell no longer goes dark
  between the splash and a ready composer: a spinner names the startup step
  until the composer paints. (flow 303)

### Changed
- **Documentation revision.** The README has one quick start, right after the
  introduction — install, `keryx init`, connecting a provider, the first
  session and where to go next — ahead of the deep dives, with a test pinning
  that order. The onboarding page gains the first `keryx shell` session:
  providers, theme, permission modes, slash-command basics and sessions. The
  two long setup references state their audience and link to onboarding
  instead of restating it. Checking every page against the code found
  triggers, schedules and governance missing from the module maps in
  `architecture.md` and `modules.md`, `SECURITY.md` naming 0.1.x as
  supported, and `bun run check` described as typecheck plus tests; all are
  fixed, and a test keeps the docs index and the site navigation in
  agreement. (flow 302)

### Fixed
- **A schedule is refused at the card when its provider cannot be priced or
  has no usable credential** — the "Known" gap in 0.2.158. `keryx schedule
  add`, `/schedule` and the `schedule_create` tool now make the same two
  checks the dispatcher makes at run time, before anything is written or a
  timer installed, so a card can no longer leave a schedule whose every fire
  refuses.
- **A theme switch recolours a modal's body**, not only its frame, in every
  modal the shell opens.
- **`/help` during a turn** opens the help modal instead of a busy notice.

## [0.2.158] — 2026-09-23

DeepSeek can be priced, so an unattended run may use it. The dispatcher accepts
only providers known to report token usage on every response, and the registry
named `grok` alone — not because the others had been measured and failed, but
because they had never been measured. DeepSeek has now been measured, live.

### Fixed
- **A `deepseek` schedule no longer refuses every fire with
  `dispatch-refused (provider-usage-unknown)`.** The built-in `deepseek`
  registry entry now sets `streamUsage`, which is what
  `providerReportsUsage` reads to decide whether an unattended run may start,
  so a scheduled `agent-task` and a `flow-next` dispatch can both run on it.
  Measured against `api.deepseek.com`, not assumed: a streaming request
  carrying `stream_options.include_usage` answers HTTP 200 and reports usage,
  and one **without** the field reports usage anyway (`input=11, output=1` on
  a one-word reply) — unlike x.ai, which returns zero usage chunks without
  it. So the flag is set here because it is the registry's only evidence that
  a gateway can be priced, not because this gateway has to be asked. End to
  end: a real `branch-state` run wrote its report and reserved $0.0057 of its
  $0.05 ceiling (19,360 in / 759 out tokens).

### Known
- **A confirmation card still does not check that the provider it names can be
  priced.** `schedule_create` and `/schedule` take the session's provider as
  a default — here, `deepseek` before this release — and store the entry and
  install its timer before any run has refused. Nothing on the draft path asks
  whether `providerReportsUsage` will accept the provider, so a card can leave
  a schedule installed whose every fire refuses. The refusal is fail-closed and
  costs nothing (no model call, `cost: not recorded`), and it is visible in
  `keryx schedule show` and in `runs.jsonl`. The same gap means the CLI
  reference's promise that "a provider with no usable credential is refused
  before anything is written" is not implemented at draft time. A follow-up,
  not a change in this release.

## [0.2.157] — 2026-09-23

A patch for the test suite, found by the 0.2.156 smoke run: a scheduler test
could install a real, enabled `systemd --user` timer on the machine running
the tests.

### Fixed
- **Tests can no longer touch the real scheduler.** Under `bun test` the
  schedule installer now refuses to run `systemctl`, `launchctl`, `crontab` or
  `loginctl`, or to read or write `~/.config/systemd/user` or
  `~/Library/LaunchAgents`, unless the test injected its own host and
  directories; the refusal fails the test loudly. A regression test snapshots
  the real unit directories and crontab before and after. The one half-faked
  test host that resolved real unit paths now uses a temporary directory.
  Anyone who ran keryx's own test suite on 2026-09-23 should check
  `~/.config/systemd/user` for `keryx-*-x.{service,timer}` units pointing at
  a `*.test.ts` file and remove them (`systemctl --user disable --now` the
  timer, then delete both files).
- **`keryx schedule add` documentation.** The CLI reference said a missing
  terminal was refused only without `--yes`; `--yes` is refused too.

## [0.2.156] — 2026-09-23

Eight flows, the day after 0.2.155: keryx can now schedule its own unattended
turns instead of only reacting to triggers, and the record around unattended
work gets three separate hardenings. `keryx schedule` turns "check this every
4 hours" into an operator-confirmed OS timer — no daemon, a signed
per-machine store, and a scheduled agent's own shell can now be limited to an
`allowlist` of domains instead of only `off`/`full`. A flow can require a
terminal confirmation token before it completes, and a flow stuck in
`completing` is no longer stranded. `keryx governance report` now shows what
an unattended run was denied and attributes trigger spend per flow. The TUI
gains Governance, Triggers and Schedules sections with their own modals, and
`keryx shell` stops handing an MCP server the provider keys it never asked
for.

### Added
- **`keryx schedule add|list|show|pause|resume|run|remove` — recurring or
  one-off unattended agent tasks, confirmed by the operator, not the
  agent.** `add` prints a confirmation card (cadence and next runs, prompt,
  runner and budget, network mode, every granted tool with the binary and
  account it acts as) and writes nothing until you type `y` or pass `--yes`
  at a real terminal — `--yes` from inside an agent's own shell
  (`KERYX_TOOL_CALL=1`) is refused, the same as `pause`/`resume`/`remove`.
  Cadence takes a 5-field cron expression or a phrase (`every N hours`,
  `daily at HH:MM`, `weekdays at HH:MM`, …); keryx installs the OS scheduler
  it finds — systemd `--user`, launchd, or cron — and runs no daemon of its
  own. `/schedule` (shell) and the `schedule_create` tool propose the same
  card for an agent to relay; only the operator can confirm it. Each
  confirmed schedule is signed with an HMAC keyed by a per-machine secret
  outside the project (`schedule-hmac.key`, 0600); `resume` checks the
  signature and every granted binary's pin before re-enabling a timer, and a
  schedule drafted from inside a keryx session is refused. Cron-to-systemd
  translation now emits a real `OnCalendar=` line instead of a commented
  placeholder. **Honest limits**, in the [scheduled-tasks
  skill](src/gdskills/bundled/skills/platform/scheduled-tasks/SKILL.md) and
  `docs/docs/limitations.md`: the hardened unattended sandbox is Linux-only,
  so a macOS schedule runs in `ask` mode with granted tools only and no OS
  sandbox at all; the scheduler-control floor is text analysis over shell
  commands, so a same-user shell already in `trust` mode can in principle
  spell around it (the terminal requirement, the `KERYX_TOOL_CALL` refusal,
  and the per-machine signature are the actual gates, not the text check);
  and a machine that is off or asleep misses runs — systemd/launchd catch up
  once, cron does not. (#664, flow 295)
- **`network: "allowlist"` for a schedule's own shell — Linux only.** Off by
  default (`off`, or `full` for the host's whole network), `allowlist`
  restricts only the scheduled agent's `shell_exec` commands to the
  `--domain` names you grant, at host **and** port (443/80 by default),
  through a loopback proxy keryx runs outside the sandbox and reaches over a
  unix socket from an in-sandbox forwarder — the model call and every
  granted tool already run outside the sandbox, unaffected by this grant. A
  non-Linux schedule refuses `allowlist` with the reason rather than
  silently falling back to `off` or `full`. Named honestly: DNS resolves
  once outside the sandbox and the proxy connects to the address it checked
  (closes rebinding, but a domain that legitimately changes IP is resolved
  fresh each run); HTTPS is a blind `CONNECT` relay with no TLS termination,
  so only the CONNECT authority is checked, not the SNI or an in-tunnel
  `Host`; a tool that ignores `HTTP_PROXY`/`HTTPS_PROXY` gets no network at
  all rather than falling back to the host's. `allowlist` for a `flow-next`
  trigger dispatch (as opposed to a schedule) is not implemented in this
  release — a follow-up. (#665, flow 301)
- **A flow can require a terminal confirmation token before it
  completes.** `flow init --require-confirmation` (or
  `completion.require_confirmation: true`) adds a gate: `keryx flow complete`
  now also needs `--confirm-token <token>` from `keryx flow confirm <id>`, a
  short-lived, single-use token minted only by a typed challenge in an
  actual terminal. **Named honestly** (see
  `docs/decisions/keryx-harness/TM-03-terminal-confirmation-token.md`): the
  token proves an interactive step ran outside the agent's tool roster,
  within its TTL, for this criteria checksum — it is friction against an
  agent completing its own flow unnoticed, not cryptographic proof a human
  typed it, and it carries the same limits as every other identity this
  release records as a claim. `keryx flow recover <id> --reason "<why>"`
  moves a flow left stranded in `completing` — by a crash or an interrupted
  attempt, never a normal gate failure — back to `in-progress`, closing the
  one status this release found with no way out. (#661, flow 299)
- **`keryx governance report` shows unattended-run denials and attributes
  dispatch spend per flow.** Each trigger run's record now carries what an
  unattended call was denied and why, surfaced next to that run's line in
  the report; the project-level trigger-spend total gains a per-flow
  breakdown that is explicitly **not additive** — it is shown for context
  under each flow, and the project-wide figure is not the sum of the flow
  figures next to it, so the report says so rather than inviting the wrong
  arithmetic. (#659, flow 297)
- **The external-agent stderr budget is now bounded on the ACP path, and
  raised on the line-stream path.** `keryx acp`'s driven agent and `keryx
  agents external run` cap stderr at 16 MiB by default (a per-agent
  `maxStderrBytes` overrides it); the `claude-cli`/`codex-cli` line-stream
  supervisor's own stderr-read budget is raised to 256 MiB, keeping its
  first-16-KiB/last-48-KiB-of-recorded-output shape. Past the cap the run
  fails with a named reason, not a silent truncation. The flow-orchestrator
  and flow skills gain unattended-dispatch guidance (what a trigger's
  `dispatch` block and `agents external run` actually control, and what
  they do not), and `docs/docs/architecture.md` gains the sandbox/allowlist
  gate diagram. (#660, flow 298)
- **The TUI gains Governance, Triggers and Schedules sections, each with its
  own modal.** Governance: five states (no report yet, unreadable, running,
  last report, failed); clicking the row or `/governance` runs the report in
  the background and opens the modal on the result. Triggers: `/triggers`
  (or a click) opens Overview, Grants and Runs, and a run-now action starts
  the trigger as a detached child with its own per-run log rather than
  blocking the TUI. Schedules: `/schedules` (or a click) opens Overview,
  Grants, Runs and Report for a confirmed schedule. Every reservation the
  three sections show for an open run is now named consistently instead of
  drifting between panels. (#662, #663, flow 300)
- **Command registry descriptors corrected and added, and `--help` is rich
  for `flow`, `trigger`, `serve-mcp` and `governance`.** The 0.2.155 flows
  shipped real behavior their own descriptors described only loosely, or not
  at all: `trigger run` no longer claims an `open-flow`/`flow-next` refusal
  it does not perform, and its side effects no longer name the retired
  single `.run.lock` path (now per-action lock paths). New commands from
  those flows (`trigger resolve`, `flow owner set`, `agents external
  list/probe`, and this release's `schedule`/`flow confirm`/`flow recover`)
  each carry a descriptor or a documented, reasoned exclusion; a coverage
  test pins the registry against the live `--help` output so the two cannot
  drift unnoticed again. (#658, flow 294)

### Fixed
- **`keryx shell` no longer passes saved or declared provider keys to its
  own MCP servers.** A locally spawned MCP server inherited the shell's full
  environment, including every provider API key the shell itself holds,
  whether or not that server had any legitimate use for one; the server's
  environment is now built explicitly from its own declared `env`, never
  inherited wholesale. (#657, flow 296)
- **`acp:`-tagged sessions and `-c` stop colliding.** A session opened by
  `keryx acp` is now tagged `acp:` in the session store, and `keryx shell
  -c` no longer picks one up and continues it as if it were an interactive
  session — the two entry points now stay on their own session lines.
  (flow 300)
- **An unattended run's own time limit now stops the command still
  running**, rather than only marking the attempt failed while the process
  kept going past its bound. (flow 301)
- **A crashed allowlist proxy no longer takes the port down with it.** The
  loopback proxy's port is now released and rebindable after a crash instead
  of staying claimed by a dead process. (flow 301)

### Security
- **A scheduled agent's grants stay pinned to what the operator
  confirmed.** Every granted tool binary (and any `#!` wrapper) is pinned at
  confirmation time and re-checked at `resume`; a pin that no longer matches
  refuses the run rather than executing whatever now sits at that path.
  (flow 295)

## [0.2.155] — 2026-09-23

Seven flows landed the day after 0.2.154 first reached a real editor and a
real trigger: the operator's own Zed session and the first `flow-next`
dispatch each found what a scripted test suite could not. `keryx acp` now
runs the model it is actually configured for, accepts the MCP servers the
editor already knows about, gives that session keryx's own project tools and
slash commands, and switches models on request. keryx can now also drive an
*external* ACP agent as its client, inside a disposable worktree, under its
own approval gate. A `flow-next` trigger can now dispatch an agent to work
the next task completely unattended, inside a hardened sandbox with a spend
ceiling it cannot raise. A flow can name the human accountable for it, and
every confirmation and completion carries a signature. `keryx governance
report` brings spend, confirmations, signatures and gate outcomes together in
one place, and `flow ac update` can finally amend a criterion's own wording
instead of silently doing nothing.

### Added
- **`keryx acp` runs the provider and model `keryx shell` would run, not a
  fake one.** Flags, else the saved selection with saved keys and OAuth
  grants, resolve the same way for both; the scripted `FakeProvider` is
  reachable only through the test-only `--fixture` flag, and with nothing
  configured every session request is refused with `-32600` naming the
  remedy instead of answering from a stand-in. (#648, flow 287)
- **`keryx acp` accepts the client's own MCP servers.** Stdio entries an
  editor sends on `session/new`/`session/load` start through keryx's shared
  MCP manager and are offered through the same `search_tool`/`use_tool` pair
  the shell uses, gated by `session/request_permission` like any other
  destructive call, and stopped when the connection or a reload replaces the
  set; `http`/`sse` entries are refused by name with the reason. (#648, flow 287)
- **An ACP session now gets keryx's own project tools, not just five generic
  ones.** Graph, wiki, memory, flow, skills and `search_code` are offered
  under the same `offersIndexTools` gate `keryx shell` uses, built from the
  same shared assembly so the two rosters cannot drift. `/help`, `/model`,
  `/reasoning` and `/status` are advertised as ACP commands and handled as
  prompt text before they reach the model; TUI-only commands stay out. Model
  switching is a `configOptions` entry of category `model`, changed through
  `session/set_config_option` or `/model`, and takes effect from the next
  turn. (#651, flow 288)
- **A flow can name an owner, and `ac confirm`/`complete` sign what they
  do.** `flow init --owner "<name>"` and `flow owner set <id> --owner
  "<name>" --reason "<why>"` record who is accountable — never inferred from
  git or the environment, and every change is kept as history rather than
  overwritten. `ac confirm` and `complete` now append a signature (who, when,
  what was signed), and every recorded identity carries a basis — `stated`,
  `derived`, or `unknown` — so a name read from local git configuration is
  never presented as proof a human acted. New flows carry an opt-in owner
  gate that fails `complete` while no owner is set; the ~290 flows that
  predate it are unaffected. (#649, flow 289)
- **A `flow-next` trigger can dispatch an agent to do the work, not just
  report it.** A `dispatch` block starts a keryx agent on the next task in a
  dedicated worktree, unattended, inside a hardened Linux/bwrap sandbox:
  read-only filesystem, home and runtime directories hidden, only the
  worktree and a scratch home writable, no network unless the entry opts in,
  no tokens or SSH agent. A floor checked before the permission mode denies
  pushing, merging, tagging, publishing and any write to flow state or the
  spend ledger even under `trust`; nobody is there to approve, so an
  unresolvable request fails closed. Every dispatch reserves its spend
  against a per-trigger ceiling — stacked on top of the project-wide one —
  before the first model call, and a dispatch with no rates or no ceiling is
  refused at load. Interactive `sync --apply` and `gdgraph build` now take
  the same maintenance lock the triggered actions take. (#650, flow 290)
- **`keryx governance report`.** One read-only report over what is already
  recorded — review spend, confirmations and their signers' identity basis,
  completion signatures, and gate outcomes, per flow — plus a project-level
  trigger-spend line, filterable by flow/owner/date and extendable to every
  registered project with `--all-projects`. It never re-runs a gate or calls
  a model; a figure nobody recorded reads as "not recorded", never as zero.
  `flow complete` now persists every attempt's gate outcomes (name, status,
  detail, the criteria checksum) rather than reducing them to one prose
  history line. (#652, flow 291)
- **`flow ac update --criterion ACn --text "<criterion>" --reason "<why>"`
  amends one criterion's own wording**, rewriting the single line or
  appending it when `ACn` is the next unused number, then re-freezing and
  recording the before/after text in history. Every `flow ac` subcommand now
  refuses an argument it does not use, rather than accepting and silently
  dropping it. (#653, flow 293)
- **`keryx agents external run <id> --task "<text>" [--unattended] [--write]`
  — keryx as an ACP client, driving a foreign agent under its own policy.**
  A registry agent whose transport is `acp` (today `gemini-acp`, `gemini
  --experimental-acp`) runs as a subprocess in a disposable git worktree,
  with keryx answering every `session/request_permission` through the same
  approval gate its own tools use — the mode is always lowered to `ask`
  (`trust`/`auto` mean nothing for a foreign agent's own description of a
  call), only an explicit allow selects `allow_once`, `allow_always` is
  never chosen, and `--unattended` (or no TTY, or no approver) fails closed.
  keryx advertises and serves only `fs.readTextFile` (plus
  `fs.writeTextFile` under `--write`, landing in the worktree only and left
  as a patch that is never applied) — never `terminal` or `elicitation` —
  and confines every path to the worktree by its real, resolved path. The
  agent gets keryx's project context through a read-only `serve-mcp
  --cwd <project-root>` launched from the running build; each run is
  recorded as a keryx session with the agent's reported usage and cost (or
  `missing` — never coerced to zero). Honest limits, stated in the [ACP
  client guide](docs/docs/guides/acp-client.md): the agent's own internal
  tools (shell, edits, its own MCP calls) are invisible to keryx and reach
  outside the permission bridge; the agent process itself runs without an OS
  sandbox in this release; the disposable worktree, not process isolation,
  is what contains it. Verified against a scripted fake ACP agent fixture
  and this repo's own `keryx acp` as the driven agent, end to end — **not
  yet exercised against a real Gemini CLI**. (#654, flow 292)

### Fixed
- **The editor's model picker fills in when the model list arrives late.** A session
  that waited out the 8 s bound for the model list was offered only the launch model,
  and nothing told it when the list arrived; it now receives one `config_option_update`
  with the complete list, keeping its current model selected (#655, flow 288).
- **`keryx acp` no longer runs on a stale OAuth token.**
  `resolveTuiStartup` copies a saved grok/copilot token into the environment
  before grants are refreshed, so the first real turn on an expired token
  failed with 401; grants now refresh before resolution, the way `keryx
  shell` already did it. (flow 287)
- **Secrets in an MCP server's own output no longer reach a transcript.** A
  credential a server echoed back in a tool result or error reached the tool
  update, the transcript and the next model request; tool output is now
  scrubbed through the same redact hook, matched both raw and JSON-escaped,
  before truncation rather than after — the 20,000-byte cap used to cut a
  token before the scrub ran. Secrets shorter than eight characters are no
  longer treated as secrets (`DEBUG=1` was mangling ordinary text). (flow 287)
- **A server that failed to start, or died later, no longer stays dead for
  every new ACP thread.** Sharing one server set per connection had removed
  the old per-thread recovery path; a thread binding to a running set now
  restarts only the servers known to be dead. (flow 287)
- **An unreachable model gateway could no longer stall every new ACP
  session.** `session/new`/`session/load` awaited an unbounded Ollama
  model-list probe aimed at the launch provider's base URL; it now waits at
  most 8 seconds and starts on the saved default rather than blocking, and a
  failed list is retried rather than cached. (flow 288)
- **A completion attempt is no longer lost when the criteria change
  mid-gate.** `flow complete` persisted an attempt's gate outcomes only on
  its final, unguarded transition; an edit to the criteria file while gates
  were running threw before the attempt reached disk. The attempt is now
  checked and saved on its own first; a tamper caught there is recorded as a
  failed acceptance-criteria gate. (flow 291)
- **`flow ac update <id> --text "…"` used to print "Acceptance criteria
  re-frozen" and change nothing.** The command took no criterion and no text
  and silently ignored both; two flows in this repository ended up with
  amendments recorded in history but absent from the criteria file, one
  completed against wording it had meant to replace. `--criterion`/`--text`
  now writes the change it claims to make, refuses a criterion that spans
  more than one line (a wrapped criterion, a sub-bullet, a fenced block —
  there is no way to tell which from the bytes), and preserves each line's
  own ending in a CRLF or mixed-ending file instead of rewriting it wholesale.
  (flow 293)
- **A symlinked directory inside the project could let `search_code` read
  outside it — in `keryx shell` and ACP sessions too, not only the new ACP
  client.** `confineToProject` now confines by the path's real, resolved
  location before handing it to ripgrep, ripgrep itself runs without
  `--follow`, and a not-yet-existing path (the write-time case) is checked
  through its nearest existing ancestor so a symlink further down the
  directory chain can't be used to escape confinement. (flow 292)
- **A search pattern starting with `--` (e.g. `--follow`) was parsed as a
  flag, not as the pattern.** The `keryx ctx rg` fallback in the built-in
  metaproject tools now puts `--` before the model-supplied pattern. (flow 292)
- **Output from an external agent — including `claude-cli` and
  `codex-cli`, not only the new ACP client — could grow keryx's own memory
  without bound.** A single line with no newline, or a flood of assistant
  text and events, was previously unbounded; a line now caps at 64 MiB
  (aborting the run and killing the agent past that), stderr keeps only its
  first 16 KiB and last 48 KiB (counting what it dropped), and a run's
  recorded assistant text plus events are capped at 16 MiB, with the same
  bounds applied to the line-stream supervisor the Claude and Codex agents
  use. (flow 292)

### Security
- **An unattended trigger dispatch is now sandboxed, not just
  floor-limited.** The health gate used to run the worktree's own tests and
  configs — written by the dispatched agent — with the operator's full
  rights and no sandbox. It now runs inside the same hardened, read-only,
  network-off-by-default sandbox as the rest of the dispatch, or not at all
  when the sandbox can't be engaged; the dispatcher's own commit runs with
  hooks disabled so a tracked hooks directory the agent edited can't run
  with the operator's rights. (flow 290)
- **The sandbox's network-off mode hid host sockets, not host
  networking.** `--unshare-net` isolates IP networking, not unix sockets:
  with the sandbox's network off, a probe could still resolve names through
  `systemd-resolved`, list the operator's tailnet through `tailscaled`, and
  reach D-Bus and libvirt over the host's `/run`, which had been bound in
  read-only. `/run` (and `/var/run`) is now hidden behind an empty tmpfs like
  the home directory; nothing under it is bound back unless the dispatch
  opts into the host's full network. (flow 290)

## [0.2.154] — 2026-09-22
Two ways to start work without a person typing the first line: an editor can
now drive the keryx harness over the Agent Client Protocol, and a repository
event or a schedule can run a keryx action on its own.
### Added
- **`keryx acp` — the harness as an ACP agent over stdio.** A client launches it
  as a subprocess and speaks newline-delimited JSON-RPC; stdout carries frames
  and nothing else. `initialize`, `session/new`, `session/prompt`,
  `session/cancel`, `session/list` and `session/load` are implemented, and the
  other seven v1 agent methods are refused with `-32601` and a reason. A turn
  streams as `session/update` while it runs; a gated call is announced, then
  asked through `session/request_permission`, and only an explicit allow runs
  it. `list` and `load` speak for the project's own durable sessions, so a
  session started in `keryx shell` opens in the editor with its history
  replayed. Reads route through `fs/read_text_file` when the client advertises
  it. Writes and shell execution stay local, for reasons recorded in the code:
  `apply_patch` applies a multi-file diff atomically, which
  `fs/write_text_file`'s one-file-whole-content shape cannot express, and
  `shell_exec`'s streaming and approval gate have no `terminal/*` equivalent.
- **`keryx trigger` — start work from a repository event or a schedule.** A
  project declares triggers in a validated config; a malformed entry is refused
  on load with its reason while the others still work. `keryx trigger run` does
  exactly one pass under the same project lock the interactive commands take,
  records what fired it, when, what it did and what it cost, and
  `keryx trigger status` reads that record rather than re-deriving it. A trigger
  whose action opens a flow can refuse to open a second one while an equivalent
  flow is already open. For a schedule, keryx prints the cron line or the
  systemd timer unit to install and runs no daemon of its own.
### Fixed
- **A triggered run that cannot read its own spend ledger refuses instead of
  proceeding.** The recorded spend is now a tagged known/unknown value, so the
  one condition under which a ceiling matters most no longer reads as zero.

## [0.2.153] — 2026-09-22
External children of `claude-cli` run again on 2.1.278. Every external run died
on the command line before the agent was asked anything, and was reported as a
dead transcript.

### Fixed

- **`--json-schema` carries an inline, bundled document.** The flag's value is
  parsed as JSON, so the staged file path exited 1 with zero bytes on stdout; and
  once inline, the root `$schema` dialect and a sibling `$ref` were both refused.
  `ExternalRunInput.resultSchema` now carries the bundled, dialect-free document
  for `claude -p`, while `resultSchemaPath` stays for codex's `--output-schema`.
- **A rejected argument VALUE is named as an argv mismatch.** `Error: --flag is
  not valid JSON` no longer reads as "transcript ended without a terminal event".

## [0.2.152] — 2026-09-22
A bare `.metaproject/` no longer passes for an initialized metaproject:
the tools that can only read it are no longer offered where there is
nothing to read, and the turn-start orientation block no longer tells
the model to build an index that does not exist.

### Fixed
- **The agent roster stops offering eighteen unusable tools.** The index
  tools were gated on `existsSync(".metaproject")`, and a project holding
  only `.metaproject/workspaces/` — the state `keryx status` had always
  called `incomplete` — was handed `graph_*`, `wiki_*`, `memory_search`,
  `health_status`, `flow_status` and the rest, every call answering
  `index-incomplete`. The gate is now one manifest-based detection,
  shared with `keryx status` (`src/lib/metaproject-state.ts`), so the
  report and the roster cannot disagree again. A project that built its
  graph or wiki but lost its manifest keeps its tools: `keryx update`
  restores the manifest, and the artifacts on disk are readable until it
  runs.
- **The orientation block is dropped where there was nothing to read
  from.** `buildOrientation` always emitted something: with no graph it
  degraded to `_not built — run keryx gdgraph build_`, so a session whose
  roster deliberately carried no tool to run it with was told to run it.
  It is now empty, and the instruction says plainly that an
  `index-incomplete` or empty answer is not a finding about the project.
- **An incomplete metaproject says so once, to the operator.** The
  readline agent session prints why the index tools are missing and which
  command creates the workspace they read.

## [0.2.151] — 2026-09-22
The interactive shell paints from the active theme's own roles, so a light
palette is readable — including the `❯` command echo in the feed that used to be
a fixed bright cyan.

### Changed

- **The shell names a semantic role instead of an OpenTUI colour helper.** `otui.cyan`, `otui.yellow`, `otui.green`, `otui.red` and `otui.magenta` are fixed, terminal-independent hexes out of OpenTUI's CSS-name table (`cyan` = #00FFFF, `yellow` = #FFFF00): 1.15:1 and 1.02:1 against a light palette's own background. `/theme` could not repair them either, because `recolorThemeTree` remaps only values matching an OLD palette slot — and 0.2.143's themed transcript could not reach them, since the lines that carried them (the command echo, the tool-call marker, the approval docks, the side-worker header, the plan inspector) are painted by the shell rather than through the transcript palette. `theme.ts` resolves a `TextRole` — `accent` (`tool`), `attention` (`focus`), `ok`, `error`, `side`, `text`, `muted` — through the active palette, and the new `theme-text.ts` turns one into a styled chunk; ~130 sites are converted.
- **Text that named no colour of its own is given one.** ~90 bare `otui.dim`/`otui.bold` sites were drawn in the TERMINAL's default foreground — light on a dark terminal — over the light background keryx paints itself. They now carry an explicit theme colour: a dark palette keeps the DIM attribute (the rendering the shell always had), a light palette uses `muted`, because DIM lowers luminance and would make secondary text louder than the prose it sits among.
- **`keryx`'s `side` slot is readable on its own canvas.** The side-worker header was `otui.magenta`; held to the palette audit's floor as the `side` role it measured 2.1:1, so that purple is now #b39ddb.

### Added

- **Two guards, so this cannot come back.** A palette audit holds `side` to the same floor as every other accent, on both surfaces it is painted on, and `src/capability/tui-theme.test.ts` refuses any fixed OpenTUI colour helper anywhere in the TUI's runtime sources. An otuiTest on the real chrome asserts exact span colours and their contrast against the colour actually painted behind them.

### Known

- A `/theme` switch remaps these colours in the model, but the already-painted cells keep the previous palette until that row repaints for another reason; newly painted rows are correct. Pinned in the test rather than worked around.

## [0.2.150] — 2026-09-22
The sidebar is four columns wider, so the working directory and the workspace
titles stop being cut mid-segment.

### Changed
- **The sidebar column is 34 columns, not 30.** Every panel fits its label to
  `SIDEBAR_TEXT_WIDTH`, and at 30 columns that budget was 26 — narrow enough that
  `shortenCwd` dropped a whole leading segment of an ordinary working directory in
  a column that already carries the branch, the PR url and the slate titles. The
  panels now get 30 columns of text.
- **The width lives in `sidebar-metrics.ts`.** `shell-chrome.ts` imports
  `destroyModalHost` from `modal-host.ts`, so a value import back the other way
  would be a cycle — and `modal-host.ts` kept its own copy of the number for its
  pre-layout fallback, the duplicate PR #591's F-013 named. `shell-chrome.ts`
  re-exports the constant, so every existing importer is unchanged and the modal
  host's fallback reads the same one number.

### Fixed
- **Three width-sensitive tests follow the new geometry instead of pinning the
  old one.** The sidebar's G-2 boundary path now sits where 30 columns is an
  exact fill and 33 is the next segment out, so a budget that forgot the border
  and padding still fails; the modal host's main-pane expectation is derived from
  the constant; and the version-advisory assertion checks the two halves the
  advisory deliberately splits the install command into.

## [0.2.149] — 2026-09-22
A patch release carrying the same feature set as 0.2.148 — a call that follows
untrusted content is put to the operator instead of being refused for the rest of
the turn — with the two fixes its own verification caught.

### Fixed
- **The usage-banner coverage test reads the banner, not a slice of the source.**
  `022a11f3` hoisted `USAGE_BODY` above `printHelp` — "hoisted rather than
  duplicated", so the two surfaces cannot drift — while the test took its banner
  from `source.slice(source.indexOf("function printHelp"))`. That slice begins
  after the constant and contains no verb line at all, so the test reported 39
  verbs "missing" from a banner that names every one of them, `check:core` went
  red on `main`, and 0.2.148's release verification stopped before publishing.
  The test now asserts on the exported constant — the text `printHelp` actually
  prints — and the `orient` property it was written for is unchanged.
- **The untrusted-content gate carries no dead initializer.** `taintApproved` was
  initialised to `false` and never read before its assignment, because every
  refusing path leaves through `continue`; `eslint`'s `no-useless-assignment`
  said so, and `check:core` was red on that commit.

## [0.2.148] — 2026-09-22
A call that follows untrusted content is put to the operator instead of being
refused for the rest of the turn — that content still cannot authorize it, but a
human now can.

### Changed
- **The untrusted-content gate asks instead of ending the turn.** Any untrusted
  result — a `web_fetch`, a `use_tool` answer, and `search_tool`'s own tool
  descriptions, which are third-party prose — latched the per-turn gate, and from
  that moment every non-read call in the turn was refused with no prompt and no
  way to continue: `shell_exec`, `apply_patch`, `use_tool` and
  `slate_write_seed` alike, so a live session read as "the turn is dead". The gate
  now puts the call to the approver with `ApprovalMeta.untrustedOrigin`,
  disclosed in the readline prompt, the TUI dock and the shared MCP prompt. It
  deliberately does not consult `resolveApprovalDecision`: a permission mode is
  standing consent for the operator's own commands and cannot answer "external
  content asked for this — do you authorize it?", so neither `trust` nor `auto`
  stands in for that answer, and no remembered grant does either. Where nobody can
  answer — an `unattended` run, or any caller with no approver wired — the old
  refusal is unchanged; a throwing approver degrades to a per-call error rather
  than a crashed turn, and read-risk tools are untouched.

## [0.2.147] — 2026-09-22
A patch release carrying the same feature set as 0.2.146 — the orchestrator plan
bridge — with the one fix that 0.2.146's own verification caught.

### Fixed
- **The plan bridge fits the skills' length ceilings again.** Every one of the nine
  skills carries a recorded line ceiling equal to what it ships, and the bridge
  blocks added 10-16 lines each, so `keryx skills verify --bundled` reported nine
  `anatomy:length` findings and `check:core` failed — which is where 0.2.146's
  release verification stopped, before publishing. Each skill now carries the
  instruction inside an EXISTING line: a pointer, its own ids (`analyze` …
  `deploy`, `T1` … `Tn`, `step-0` … `step-14`, `phase-0` … `phase-5`),
  `plan_set`/`plan_update`, and `proposed` where the run stops to ask. Line counts
  are unchanged and every ceiling is still exact. The prose that needs room lives
  in the `session-plan-bridge` rule, which has no ceiling.

## [0.2.146] — 2026-09-22
The orchestrators' own plans are visible while they run. Every one of them already
owned a plan — fifteen job steps, a Flow's tasks, a review's numbered checklist —
and none of it reached the surface built for exactly that purpose, so an operator
saw phases announced in prose and had to ask what was happening.

### Added
- **`session-plan-bridge`, and nine skills that use it.** The new rule defines the
  projection from an orchestrator's own plan into the session plan: publish once
  as soon as the plan exists, use the orchestrator's OWN ids (`analyze` …
  `deploy`, `T1` … `Tn`, `step-0` … `step-14`, `phase-0` … `phase-5`), translate
  the vocabularies explicitly (job steps are hyphenated `in-progress`; our
  vocabulary has no `failed`, so a failed step is `blocked`), and mirror every
  status change in the same breath as the CLI call that made it. It is explicitly
  not a journal, and not authoritative: if it disagrees with `keryx job status` or
  `keryx flow status`, the CLI wins and the projection is corrected.
- **The runs that stop to ask publish `proposed` at exactly that gate.**
  `job-orchestrator`'s "Proceed? (yes / adjust …)", `flow-orchestrator`'s Phase 4
  completion choice, `feature-dev`'s spec and plan confirmations, and
  `docpack-orchestrator`'s target-location question. The sidebar then says
  `◇ awaiting approval` at the moment the run is waiting for a human — and, being
  non-actionable, that status does not make the agent continue on its own.
- **Six more main-session pipelines joined the bridge:** `issue-analyzer`,
  `feature-analyzer`, `autodoc-orchestrator`, `docpack-orchestrator`,
  `feature-dev` and `review-pr-feedback`. Skills that run as dispatched
  SUBAGENTS are deliberately excluded, and the rule says why: `plan_set` is
  registered for the main session only, so a child cannot call it at all.

### Fixed
- **The plan modal is `Session plan`, not `/plan`.** 0.2.145 shipped it titled
  after the read-only MODE command, so two unrelated things shared one name — and
  a reader who opened the modal looking for the mode toggle had nothing to tell
  them apart. The Meta tab now names the difference explicitly. `/plan` itself is
  untouched: same registry entry, same two shells, same orthogonal hard floor,
  still in-memory only.

## [0.2.145] — 2026-09-22
A plan can now be published FOR APPROVAL. The plan vocabulary had no way to say
"here is the plan, your call": a published plan necessarily contained `pending`
items, and the shell's own continuation nudge fires on exactly that, so
publishing a plan and then stopping was impossible by construction — the only
sign a plan existed was prose in the reply.

### Added
- **`proposed` — a plan can be published for approval.** The sixth plan status is
  deliberately NOT work: an item awaiting a human is not something the agent may
  simply continue, so `proposed` never triggers the continuation nudge, and
  `plan_set` followed by a reply is a real stopping point. When nothing is in
  progress and something awaits approval, the turn says so — `[plan] Published
  for your approval — nothing is in progress, so this turn ends here` — and ends
  rather than continuing. The instruction teaches the vocabulary: mark items
  `proposed`, state the plan, end the turn; use `pending` only when the plan will
  be executed in the same turn.
- **The sidebar and the `/plan` modal render that state as what it is.** The
  sidebar gives it a `◇` glyph, and when nothing is in progress it anchors its
  window on the first thing still to do rather than the head of the list — a long
  plan used to show items 1–7 while everything moved at the far end. The modal
  spells the status out as "awaiting approval" in yellow, counts it in the
  summary, adds an `Approval` line to Meta, and aligns its status column, so a
  mixed plan reads as a table.

### Fixed
- **The plan modal's tab is `Plan`, not `Steps`.** The README and the 0.2.144
  changelog named a tab that never existed.
- **Three release-gate tests now carry budgets derived from what they cost.**
  `bun run check` was red on `main` for reasons that were budgets, not behaviour.
  The serve-turn-store bound test wrote ~3 000 events of 400 bytes to build a log
  1.5 × past the config bound, and every append is a synchronous write PLUS an
  unconditional chmod: 9.1 s alone, 10.3 s inside the suite, against bun's 5 s
  default. The retired-spellings scan walks ~1000 markdown files (17.4 s inside
  the suite). The global-install fixture clones this repository itself and
  installs into a temp prefix (131 s), which exceeded its 120 s hook cap — that
  failure reads `(fail) (unnamed) 120006ms`, naming no test and looking like
  infrastructure. The first test now proves the same premise with 300 large events
  instead of 3 000 small ones (1.6 s) and asserts the log stays under
  `MAX_TURN_FILE_BYTES`; the other two carry 60 s and 600 s budgets, an order of
  magnitude over their contended measurements. No product behaviour changed.

## [0.2.144] — 2026-09-22
Work state in the shell no longer depends on a lifecycle it does not belong to:
the execution plan survives a Slate close, a security-flagged proposal can be
accepted from the TUI itself, and the selected theme — canvas background
included — is applied from the very first frame.

### Added
- **A security-flagged proposal can be accepted from the TUI review modal.** A
  proposal whose evidence tripped the scanner carries `security.gate:
  needs-approval`, and accepting it requires a token minted with
  `--acknowledge-security` — which the modal's `[a]` accept never passed, so
  acceptance from the modal always failed, and the refusal told the reviewer to
  mint a token without the flag it needed. The modal now offers a third,
  explicit action: `[s]` (the `[Accept + ack]` button) mints with the
  acknowledgement, showing what pressing `[y]` claims to have read. It is never
  an automatic fallback, and the refusals now name the flag and print the
  ready-to-copy command.

- **The whole plan is one click away from the sidebar.** The sidebar's Plan rows
  are a glance — seven centred rows, 26 columns, no item names — so a plan that
  outgrew the glance had no surface left. Clicking the section (its header or any
  row) now opens `/plan` in the shared modal host: a Steps tab lists every item
  grouped and coloured by state, and a Meta tab carries the revision, per-status
  counts, the active item, the blocked ids and the plan's own
  `<session>/plan.json`. It repaints live from the same subscription the sidebar
  panel uses and unsubscribes on close, so a closed modal cannot be repainted by
  a later `plan_set`.

### Fixed
- **The execution plan no longer disappears when a Flow closes its Slate.** The
  plan lived in `slate.json`'s `executionPlan`, so the archive-on-close step took
  it away as soon as the Flow reported done: the plan and the sidebar panel
  rendering it vanished mid-session, and `plan_set` failed from then on. It now
  lives in `<session>/plan.json` under its own lock, needs no Slate to exist, and
  degrades to "no plan" when the file is corrupt instead of wedging every call
  that touches it. A plan stored the old way is still read and migrates on the
  first write, carrying its revision so `expectedRevision` keeps working.
- **The first frame uses the selected theme, not the terminal's background.**
  `createCliRenderer({ backgroundColor })` is not applied by `@opentui/core`
  0.4.5 — the renderer keeps a transparent default and clears every frame with
  it — so the transcript canvas inherited the terminal's own background until
  something called `setBackgroundColor`, which only happened on a `/theme`
  switch. The renderer's clear colour is now painted at creation, covering the
  first frame, the boot animation and the startup picker; that picker, the other
  pickers and the composer's own text also take their colours from the active
  palette instead of OpenTUI's fixed dark defaults and a hardcoded highlight, so
  a light theme is legible from the first screen.
- **A batch containing a web call no longer blocks unrelated tools.** The
  per-call untrusted-content gate refused every non-read tool in a batch that
  merely contained a `web_fetch`/`web_search` call, and a zero-hit search latched
  it too — so an unrelated `shell_exec` or `slate_write_seed` was blocked for
  sharing a batch with a search that returned nothing, the batch read as "no
  progress", and the turn ended in a toolless wrap-up. The gate now keys on
  whether untrusted content was actually seen: a web call earlier in the batch
  still latches it, a call before it cannot be affected by it, and a
  fully-refused batch is no longer mistaken for a stalled one.
- **Two gateway refusals say what is wrong instead of blaming the key.** OpenCode
  Zen's `403 … free tier can only be used from within OpenCode` — returned for the
  free model ids its `/models` list offers first — and a `402 … Insufficient
  account funds` both read as "your configuration is wrong" and sent the operator
  to re-check a key that was never wrong. They now name the remedy: pick a paid
  model id, or add credit. The hint is narrow by construction — it fires on the
  provider's own machine-readable error type or an exact phrase, never on the
  status alone.

## [0.2.143] — 2026-09-22
Long-running shell work now keeps its execution plan visible and persistent,
while assistant output follows the selected theme across prose, Markdown,
code, diffs, and tables.
### Added
- **Persistent execution plans.** Agent-mode sessions can store a structured
  plan with pending, active, completed, blocked, and skipped steps. The TUI
  shows the current steps in a compact sidebar panel, resumes them with the
  session, and gives the agent one follow-through turn when actionable work
  remains instead of accepting an early final reply.
- **Native Markdown tables in the transcript.** GFM pipe tables render as
  responsive bordered tables with balanced columns, word wrapping, escaped
  pipes, and inline-code pipes handled correctly.
### Changed
- **Transcript colors now come from the active theme.** Prose, headings,
  emphasis, inline code, code syntax, table chrome, and diff additions and
  deletions use softer semantic colors derived from every dark and light
  palette instead of fixed white, cyan, green, yellow, and red ANSI colors.
- **Fenced content has purpose-specific rendering.** Language-tagged code gets
  themed syntax roles, `diff` fences keep visible `+`/`-` prefixes with subtle
  semantic backgrounds, and `text`/`txt` fences stay literal for diagrams,
  command output, and other preformatted content.
### Fixed
- **Changing themes repaints existing rich content.** Styled transcript spans,
  code backgrounds, diff rows, and table cells are recolored immediately along
  with the surrounding panels.
## [0.2.140] — 2026-09-21

The shell theme picker now offers a broader set of accessible dark and light
palettes.

### Added

- **Eight new TUI themes.** `midnight`, `nord`, `ember`, and `violet` add dark
  choices; `paper`, `frost`, `sand`, and `mint` add light choices marked with
  `☀` in the picker.
- **Palette contrast checks.** Theme tests enforce readable text, muted text,
  status, focus, and tool colors across every palette.

### Fixed

- **Light themes keep modal chrome readable.** Modal titles, tabs, close hints,
  and footers now use explicit semantic colors instead of inheriting the
  terminal's usually-white foreground.

## [0.2.139] — 2026-09-21

This release republishes the sticky-prompt interface after updating the
release audit for the refactored user-message call site.

### Fixed

- **Release verification now accepts the full-width user prompt layout.** The
  held-turn source audit follows the multiline prompt construction introduced
  with sticky prompts, allowing the complete TUI suite to pass in CI.

## [0.2.138] — 2026-09-21
Long agent answers keep the operator's active request visible while the
transcript moves beneath it.

### Added
- **The active user prompt sticks above the transcript while scrolling.** Once
  its original row leaves the viewport, a compact one-line context strip pins
  the request at the top; reaching the next user message replaces it, and
  scrolling back to the original row removes the duplicate.

### Changed
- **Main-turn user messages use the full transcript width.** A tinted surface
  and left accent replace the content-width rounded bubble in both agent and
  chat shells, making turn boundaries easier to scan without adding height.

## [0.2.137] — 2026-09-21
The shell workspace now has visible breathing room and clearer surface edges,
especially in the Tokyo Night palette.

### Fixed
- **The transcript and composer no longer sit against the terminal edge.** A
  workspace gutter, transcript inset and top spacing give messages and the
  input surface a consistent visual margin at every supported terminal size.
- **Borders remain visible on tinted panel backgrounds.** The sidebar divider
  and composer now use the theme's dedicated border color instead of the much
  subtler highlight color; the header and footer return to the canvas color so
  the panel surfaces no longer merge into one blue sheet.

## [0.2.136] — 2026-09-21
The interactive shell has a clearer Keryx identity and keeps its command
surfaces compact across both full-screen and short terminal layouts.

### Changed

- **The shared shell chrome now reads as one Keryx workspace.** The header uses
  the `◆ keryx` identity, while the header, telemetry rail, composer and footer
  share the active theme's panel surface and accent treatment. Live theme
  switching repaints all of the new surfaces in place.
- **`/help` opens in a scrollable modal.** Command help starts at its heading
  and remains navigable in short terminal panes instead of being appended to a
  sticky-bottom transcript with its first rows clipped.
- **`/status` and `/theme` size themselves to their content.** Both dialogs
  keep their controls visible without occupying nearly the entire terminal
  when the information fits in a smaller panel.
- **The Session Switcher puts the task title before the session id.** Its detail
  row now shows updated/created times and message count without repeating the
  project path on every project-scoped result.

## [0.2.135] — 2026-09-21
The agent view of the flow registry marks a duplicated flow id, the way `keryx
flow list` has since flow 120.

### Fixed

- **`flow_status` (the agent tool) marks a duplicated flow id and names the
  repair directories.** Two flows sharing one number arrived as two
  ordinary-looking rows: nothing said the id was unusable, while every bare-id
  command refuses it as ambiguous and `keryx flow list` has printed
  `✗ duplicate id` since flow 120. The flag is now computed where the registry
  is owned — `flow.list()` through `duplicateFlowIds`, both members of a
  collision — carried through `MetaprojectPort.flowStatus` as an optional
  field, and rendered as the marker plus a note naming the DIRECTORIES: `keryx
  flow renumber` takes a directory and refuses a bare ambiguous id, so a note
  that only said `<dir>` would leave the caller holding a reference the repair
  command will not accept. The flag is deliberately not computed in the
  renderer: that would import `src/flow/store` from `src/harness`, one more
  facade bypass against `import-policy.live.test.ts`.

### Changed

- **Two colliding flow packages were renumbered** (`265` → `282`, `266` →
  `283`) and the references to them across `docs/` were re-pointed, so
  `keryx flow check` reports no duplicate ids. The moved packages' review
  artifacts still name the pre-move directories on purpose: that is what those
  rounds actually scanned, and rewriting it would make the record claim a path
  that did not exist then.

## [0.2.134] — 2026-09-21
The startup screen stops squeezing its last line: the wordmark, the hint and the
bus notice are broken to the pane width and centred row by row.

### Fixed

- **A line wider than the transcript pane wrapped flush left instead of staying
  centred.** `alignItems: "center"` centres a *child*, not its text, so a line
  wider than the pane had no centring to receive — the renderer wrapped it and
  every row after the first landed against the left edge. OpenTUI offers no
  alternative: `TextBufferOptions` has only `wrapMode`/`truncate`, there is no
  `textAlign`, and `Box`'s `titleAlignment` styles a border title. The splash now
  breaks every line to the pane width itself, mounts one row per renderable, and
  repaints on resize and once after the first frame.
- **The `bus: joined as …` notice is painted inside the splash** while the
  transcript is empty, and falls back to an ordinary transcript line once the
  splash is gone; `bus: off (…)` follows the same rule.

## [0.2.133] — 2026-09-21
`keryx gdgraph build` records the freshness of what it just built, in a
scaffolded project too.

### Fixed

- **A delegated `gdgraph build` records provenance.** In any project carrying
  `.metaproject/core/gdgraph/cli.ts` — every project `keryx init` or `keryx
  update` has touched — the command hands `build` to that copied runner, which
  never wrote `.metaproject/data/gdgraph/.provenance.json`. The build rebuilt
  the artifacts and left the freshness record untouched; only `keryx sync
  --apply`, which records provenance itself, kept it moving. The command now
  records it after a delegated build that exited cleanly: a failed build records
  nothing, and the delegated and in-process paths stay mutually exclusive, so
  nothing is written twice. The copied runner is deliberately left as it is —
  it has no access to the HEAD-resolution logic, and a template change would
  only reach a project on its next `keryx update`, while this fix reaches every
  project on its next keryx upgrade.

## [0.2.132] — 2026-09-21
A commit that changes no code no longer freezes the freshness record, so the
wiki baseline stops being unreachable in a project whose recent commits were
bookkeeping.

### Fixed

- **`keryx sync --apply` advances provenance when a commit changed no code.**
  A commit touching only `.metaproject/` — or anything else outside the code
  file set — left the derived artifacts valid and their provenance pinned to the
  older commit forever: the diff stage found nothing to rebuild, the graph
  staleness check read that same record and reported "HEAD moved since the graph
  was built", and the gdwiki baseline was refused on that verdict. Nothing moved
  the record that would settle the disagreement. The diff stage now records the
  new commit without a rebuild, because it is the one place that already knows
  the tracked code file set is identical; a plain `keryx sync` prints an advisory
  and writes nothing. The wiki keeps its own freshness gate on that path: a
  committed-history diff cannot see an untracked file, so `gdwiki` asks
  `resolveWikiSourceGate` exactly as the apply step does and refuses to advance
  when the gate is not fresh. gdgraph and memory advance unconditionally —
  gdgraph carries its own untracked-file signal, memory publishes no
  code-freshness claim.
- **`.mts` and `.cts` count as code when deciding whether a commit changed any.**
  They were missing from the code-file set, which on the new path would have read
  a real code change as "nothing changed".

## [0.2.131] — 2026-09-20
Two SAC friction points fixed: a workspace reference no longer needs a "./"
prefix to be accepted, and an "unknown" review item says why it is unknown.

### Fixed

- **A workspace reference is normalized instead of refused with schema codes.**
  `workspace_create`, `sac.workspaceCreate` and `keryx workspace
  create/add-resource` passed a caller's raw string straight into the contract,
  so the natural spelling `src/harness/search` was rejected with
  `schema_pattern` + `unsafe_workspace_reference` — two codes that name
  nothing a caller can act on — while only `./src/harness/search` worked. All
  four surfaces now normalize through one shared helper
  (`src/sac/workspace-reference.ts`), and refuse what must never reach disk
  (an absolute path, a URL, a Windows path, a `..` segment) in a sentence.
- **A LEADING `..` segment is refused by the contract itself.** Found while
  writing the normalizer's round-trip test: the shared pattern's `..` lookahead
  anchored on `^`, which cannot match after the `./` it had already consumed,
  so `./../escape` was `ACCEPTED` — exactly the traversal the lookahead exists
  to forbid. A `..` further along (`./src/../x`) *was* caught, which is why it
  went unnoticed. The pattern now anchors on segments, and the two remaining
  private copies (`fwk-service.ts`, `policy-experiment.ts`) import it instead
  of repeating it.

### Added

- **An `unknown` review item says WHY it is unknown.** `keryx workspace
  catch-up`, the TUI review inspector and its detail pane rendered one sentence
  for every case — false for a wrap-up that ran and failed, and misleading for
  the worst one: a session whose `slate.json` exists but cannot be parsed is a
  BROKEN record, not an unrecorded session. Items now carry
  `reason: "wrap-up-failed" | "slate-unreadable" | "no-resolution-recorded"`,
  shown on both surfaces.

## [0.2.130] — 2026-09-20
DuckDuckGo's rate limiting is reported as a rate limit, waited out, and told
apart from a broken network.

### Fixed

- **`web_search` says why DuckDuckGo failed.** The Lite endpoint's bot-check
  page (HTTP 202, or a 200 carrying the anomaly markers) was reported as
  `transport-failed`, which both operator surfaces printed as "connection
  validation failed" — indistinguishable from a dead network, and it sent the
  operator to retry the one failure that retrying cannot clear. It now carries
  its own `rate-limited` reason, and the provider's own refusal reaches
  `web_search`'s output instead of being collapsed into "search failed".
- **Searches survive a shallow rate limit instead of failing instantly.** The
  gap between searches goes from 500–2000 ms to 4000–8000 ms, and an anomaly is
  retried once after 5 s and once after 20 s before the search gives up.
  Measured on a rate-limited address: a lone request after a quiet period
  returns results, so one bounded retry is the difference between "no results"
  and ten results. When the ladder runs out, the message says what to do —
  "Do not retry or rephrase; wait a few minutes or fetch a known URL directly".

### Added

- **Search requests look like a browser.** DuckDuckGo answers a browser and
  bot-checks everything else, and keryx sent no User-Agent at all.
  `public-search` requests now carry a rotating real User-Agent,
  `Accept-Language`, the `Sec-Fetch-*` set and `accept-encoding: identity`
  (the worker reads bodies as text and decodes nothing). `web_fetch` is
  unchanged: a page the operator named by URL is not requested as if a browser
  were loading it.

## [0.2.128] — 2026-09-20
A leftover local SearXNG no longer blocks the DuckDuckGo default after upgrade
(PR #629).

### Fixed

- **`web_search` no longer stays stuck on a leftover local SearXNG.** A
  pre-DuckDuckGo `search-providers.json` that still had `activeProviderId:
  "searxng"` kept sending queries to a stale localhost instance. Upgrade now
  drops that selection (Brave/Tavily/Exa stay) so DuckDuckGo is the default;
  `/search-connect searxng` still re-selects it. Result headers name the
  `Provider:`. The agent is told it cannot switch engines itself.

## [0.2.127] — 2026-09-20
`web_search` works on a fresh install: DuckDuckGo Lite is the default, with no
API key and no local search engine (PR #626).

### Added

- **`web_search` uses DuckDuckGo by default.** No API key and no local SearXNG
  instance are required. `/search-provider` still configures Brave, Tavily, Exa,
  or a loopback SearXNG instance; a selected provider that fails is not silently
  replaced by DuckDuckGo.

## [0.2.126] — 2026-09-19

### Fixed

- **Approval dialogs no longer leak, and a runtime warning can no longer garble
  the screen.** Every choice dialog removed its scroll boxes and rows from the
  dock without destroying them. An OpenTUI ScrollBox keeps a `selection`
  listener on the renderer until it is destroyed, and every renderable stays in
  OpenTUI's global registry until then, so each approval leaked one or two
  scroll boxes with their rows. After a few approvals the runtime printed
  `MaxListenersExceededWarning: 11 selection listeners added to [CliRenderer]`
  straight onto the full-screen UI, which corrupted the sidebar and footer of a
  live session. Closed dialogs now destroy what they mounted (a regression test
  opens fifteen dialogs and checks the listener count stays flat). While the TUI
  owns the terminal, `process.emitWarning` output goes to the `--debug` log
  instead of the screen, and is summarised on stderr after exit.

## [0.2.125] — 2026-09-19

### Changed

- **Minimum Bun is now 1.3.14** (`engines.bun`, README, onboarding,
  CONTRIBUTING). Bun 1.2.22 through 1.3.13 can close a terminal's
  `process.stdin` while another native stream is read in the same process
  (oven-sh/bun#29787, #30565), which froze `keryx shell` when subagents started.
  keryx 0.2.123+ recovers from it; `bun upgrade` removes it. The new "Bun
  version" section in onboarding explains the symptom and how `--debug` records
  it.

## [0.2.124] — 2026-09-19

### Fixed

- **The input freeze is a Bun runtime fault, and the record now says so.**
  Traced with `strace` under `keryx shell --debug`: the last terminal read
  returned two bytes, the next one `EAGAIN`, and Bun's `process.stdin` emitted
  `end` anyway. No read returned 0 and nothing changed termios. The runtime
  intermittently ends a tty stdin on a would-block read while the event loop is
  busy, which is why it hit as subagents started. The 0.2.123 entry blamed
  `VMIN=0`; that was wrong. The reopen from 0.2.123 is the right recovery and
  stays: in the traced run input came back 7 ms after the EOF, with nothing
  lost and no repeat. The reopened descriptor is blocking, which Bun reads on a
  thread rather than on the nonblocking path that misfires.
  Upstream this is the Bun family of oven-sh/bun#29787 and #30565: a
  concurrent native `ReadableStream` (a `Bun.file(...).stream()` read that is
  cancelled part-way) ends a TTY `process.stdin`. A standalone repro closes
  stdin on the first keypress under Bun 1.3.11 and does not reproduce under Bun
  1.4.2. If `bun --version` is older than 1.3.14, `bun upgrade` removes the
  cause; the reopen stays as the guard for older runtimes.
- **`--debug` watcher: no more false stalls after a reopen.** The reopened
  stream is not read through epoll, so the watcher reported "reader not
  polled" every 15 s and sent SIGUSR2 for nothing. That condition now counts as
  a stall only while input is actually waiting in the terminal queue.

## [0.2.123] — 2026-09-19

### Fixed

- **The shell no longer freezes when its terminal input hits end-of-file.**
  Reproduced with `keryx shell --debug` (0.2.122): while subagents ran, the
  first key typed was followed by an `end` on `stdin` — the tty's termios had
  been switched to `VMIN=0`, where a raw-mode read with no data returns 0 bytes
  and the runtime reads that as EOF. The stream destroyed itself, and the
  0.2.122 SIGUSR2 recovery (pause/resume) could not revive a destroyed stream.
  Every TUI session now watches `stdin` for `end`/`close` and reopens the
  terminal as a new raw-mode stream (re-applying raw mode, which restores
  `VMIN=1`), hands it to the renderer, and keeps going; at most five reopens a
  minute. `kill -USR2` reopens a dead stream the same way. Setting
  `stty min 0` on the pane from outside reproduces the freeze and is recovered
  from immediately.

### Added

- **`--debug` records who changes the terminal.** The watcher samples termios
  every 50 ms and logs every change (VMIN, VTIME, canonical/echo); a suspicious
  one (VMIN 0 or canonical mode) also lists every process holding the terminal
  open. The shell logs kernel-side facts (termios, foreground group) when input
  ends.

## [0.2.122] — 2026-09-19

### Fixed

- **A shell whose terminal input stopped can be brought back.** In session
  603f3171 (0.2.121, under herdr) the shell kept drawing its spinner while no
  key, Esc or Ctrl+C reached it: the terminal's input queue was full and the
  tty reader was no longer polled. The approval picker on screen looked hung;
  input as a whole had stopped. The 0.2.121 dock fix did not address this.
  Every TUI session now re-arms terminal input on `SIGUSR2`, so
  `kill -USR2 <keryx pid>` from another terminal recovers it without losing the
  session.
- **An approval that pops up while you type is no longer answered by your
  Enter.** The picker ignores Enter for 400 ms after it opens and while
  printable keys are still arriving; Esc and clicks are never delayed.

### Added

- **`keryx shell --debug`.** Records the session to
  `~/.local/share/keryx/debug/<run>/shell.ndjson` (path also in
  `debug/latest.txt` and shown on exit): terminal-input state every second,
  every call that pauses, detaches or reconfigures stdin with the calling
  stack, key names (never typed text), dialogs, overlays, tool calls, agent
  state and herdr reports. It also starts a detached watcher
  (`watcher.ndjson`) that checks from outside whether the shell is still
  reading its terminal — epoll registration of the tty reader and unread bytes
  in the tty queue (Linux) — and on a stall writes a full process snapshot and
  sends `SIGUSR2` to recover.

## [0.2.121] — 2026-09-19

### Fixed

- **TUI choice dock no longer hangs the agent turn.** Parallel `spawn_subagent`
  approvals (and `ask_user`) shared one composer dock and raced two key
  listeners into the same menu, so Enter/click could leave a picker on screen
  with the busy timer still running. Concurrent choices now serialize on the
  dock; `/mode` and the busy-recipient selector cancel instead of stacking;
  composer Enter is ignored while the dock is open; `/interrupt` aborts the
  picker; interrupting after a concurrent spawn batch still writes tool
  results so the next provider round is not stuck on orphaned `tool_calls`.

## [0.2.120] — 2026-09-19
Two fixes found while checking 0.2.119 in a terminal (PR #601).

### Fixed

- **The Tools tab keeps its tool list after you visit MCP Clients.** In
  `/integrations`, going to MCP Clients and back to Tools, then pressing ↓,
  used to replace the tool list with the MCP client rows, while the tab strip
  still read Tools. This had been the case since before 0.2.118.
- **The Brave search-provider key prompt says "API" once.** It read "Paste
  your Brave Search API API key".

## [0.2.119] — 2026-09-19
The Tools tab of `/integrations` no longer leaves blank rows under its list
(PR #599).

### Fixed

- **The Tools tab fills the dialog.** A tool with a long description that did
  not fit in the rows left under the list used to leave those rows empty,
  sometimes eight or more. The start of that tool now fills them, and ↓ shows
  it in full.

## [0.2.118] — 2026-09-19
Every step of the provider and search-provider wizards now opens as a dialog
inside the shell. `/integrations` and `/mcp` are readable at any width. The
sidebar shows the permission mode and read-only state, and a new session opens
on the wordmark instead of a blank pane (PR #596, flow 270).

### Changed

- **`/provider`, `/connect` and `/search-provider` open as dialogs** in the
  shell, like `/model`. This covers every step: provider, sign-in method,
  endpoint URL, API key, device login, custom-provider fields, search
  credential, the active-provider question and the connection test. The
  sidebar stays visible. Esc goes back one step, or cancels on the first. The
  startup picker and the chat shell keep the full-screen view.
- **`/integrations` (Tools & MCP) and `/mcp` are readable.** Long descriptions
  wrap under their own column. The first column is now "approval", with `none`
  for tools that never ask, so `shell_task_kill` no longer reads as a
  read-only tool. Paths show your home directory as `~`. The footer lists only
  keys that work on the current tab, and ↑/↓ now reach the last tool.
- **The sidebar shows the mode**: `mode ask`, or `mode ask · read-only`
  highlighted while `/plan on` is active. It updates as soon as `/mode` or
  `/plan` changes it.
- **A new session opens on the KERYX wordmark**, centred in the empty
  transcript until you send the first line. The startup animation no longer
  shows loading steps that did no work.

### Fixed

- **A Grok `config.toml` with an array of tables** such as
  `[[marketplace.sources]]` is no longer reported as a config problem in
  `/mcp`. An `[[mcp_servers…]]` header, in either quote style, is still
  refused.
- **Text fields in dialogs keep ←/→** for moving the cursor instead of
  switching tabs.
- **A dialog that opens right after another closes is now drawn.** Esc on the
  URL step used to return to a provider list that was open but invisible.
- **Dialog text no longer loses its last column** to the scrollbar.
- **Nothing typed between wizard steps is sent as a message** while the wizard
  is still loading.
- **Esc during a search-provider connection test** no longer lets the test set
  that provider active afterwards.

## [0.2.117] — 2026-09-19
A shell task no longer reports that it finished before its last output is
readable (PR #594).

### Fixed

- **A finished task's output is complete when it is reported finished.** The
  task supervisor settled a task as soon as its process exited, which could be
  before the final bytes it wrote had been read from the pipe, so a read right
  after the wait (`shell_task_output`, a completion notification) could miss
  them. The exit is now reported once stdout and stderr have been drained,
  waiting at most 2 seconds for a pipe a backgrounded child keeps open. Output
  that arrived before the supervisor subscribed is no longer dropped.

## [0.2.116] — 2026-09-19
Dialogs in the OpenTUI shell stay inside the chat column and size to what they
show, and the transcript follows what you send (PR #591, flow 269).

### Changed

- **`/model` and `/sessions` open as dialogs in the shell** instead of a
  full-screen overlay: the header, sidebar and status bar stay visible, typing
  still filters the list, and the footer is the only place the keys are listed.
  In the `/provider` and `/connect` wizard, Esc on the model step is labelled
  "back", because it returns to the provider list.
- **Dialogs size to their content.** The model and session pickers and the
  empty `/review` take the rows they need, up to 85% of the terminal height.
  An empty `/review` is a compact box whose footer offers no item actions.
- **Dialogs no longer bleed or overlap.** The backdrop is opaque, and a dialog
  stays within the chat column, so its border no longer runs into the sidebar.
- **`/help` wraps** long command descriptions to the transcript width, with
  continuation lines aligned under the description column.

### Fixed

- **Sending a message scrolls to the end** and resumes following new output,
  even if you had scrolled up. A bare Enter on an empty composer sends nothing
  and leaves the transcript where it is.
- **Leaving block navigation** (Ctrl+O, then Esc) keeps the scroll position
  instead of jumping back to where navigation began. New output is followed
  again only when you are at the bottom or within three rows of it.

## [0.2.115] — 2026-09-17
The shell no longer looks hung on a slow or reasoning-heavy model: responses
stream, stalled connections end with an error, and model reasoning is requested,
shown live, kept and sent back the way each provider requires.

This code (PR #587) was already merged when 0.2.114 was cut, and 0.2.114's entry
does not describe it. One statement there is no longer true: the main agent turn
does not default to 1024 output tokens — see Fixed below.

### Fixed

- **Provider responses stream.** The OpenAI-compatible, OpenAI, Anthropic and
  Gemini adapters used to read the whole response before showing anything, so a
  long turn was a spinner and a server that kept the connection open after its
  last event held the turn forever. Text now appears as it arrives, the turn ends
  on the provider's terminal event, and 120 s without a first byte or without a
  new chunk ends the turn with a retryable `unavailable` error. A provider's
  `timeoutMs`, when set, still bounds the whole call.
- **The main turn gets room to answer.** Every round of the main agent turn was
  capped at 1024 output tokens — enough to truncate a long edit, and not enough
  for a reasoning model to answer at all. It now defaults to 8192:
  `KERYX_MAX_OUTPUT_TOKENS`, then the provider's `maxOutputTokens`, then the shell
  config. One-shot commands keep their own smaller limits.
- **Inline `<think>` reasoning no longer leaks** into answers, history, the
  next-step hint or wiki pages. MiniMax and DeepSeek hosts get the right
  reasoning handling without configuration.
- **The next-step hint** has a timeout, is cancelled when a turn starts or you
  type, uses the current model, drops malformed replies, and is accepted only with
  Tab or Right — Enter on an empty composer no longer sends it.
- **Session messages record when they were appended**, not when the session was
  last saved.
- **`wiki enrich` never writes reasoning tags** outside code into a page;
  `wiki status` lists pages that already carry them.

### Added

- **Model reasoning, end to end.**
  - Anthropic: adaptive thinking with summarized display on current models,
    `budget_tokens` on 4.5 and older; thinking blocks are sent back unchanged in
    the tool loop.
  - OpenAI: reasoning effort with a summary; encrypted reasoning items are
    replayed. `temperature` is not sent with a reasoning request, which rejects it.
  - Gemini: thoughts on request; every `thoughtSignature` is sent back on the
    part it came on, which Gemini 3 requires for function calling.
  - OpenAI-compatible providers: `reasoning.format` (`field`, `inline-tags`,
    `split`), `requestParams` and `replay` (`deepseek`, `minimax`) in
    `llm-providers.json`.
- **`/reasoning [off|minimal|low|medium|high|xhigh|max]`**, also
  `KERYX_REASONING_EFFORT` and the shell config; off by default.
- **Live reasoning in the shell.** The thinking phase starts on the first
  reasoning fragment with a preview; finished reasoning collapses to
  `◆ thought for 12s · 1.8k tokens`, or says it was hidden by the provider.
  `/think auto|expand|hide` chooses how it is shown and is remembered.

See [the CLI reference](docs/docs/cli-reference.md#reasoning-effort-and-output-budget).

## [0.2.114] — 2026-09-17
An auto-compaction guard that keeps a long tool loop from overflowing the
provider's context window, and per-provider `temperature`/`maxOutputTokens`/
`timeoutMs` configuration for OpenAI-compatible gateways.

### Added

- **Auto-compaction before a request overflows the context window.** Nothing
  in the round loop ever shrank `history` before sending a request — the only
  shrink mechanism, `/compact`, ran solely on manual invocation. A single
  user turn's tool loop could grow past a self-hosted gateway's real context
  window and 400 with an input-token overflow the operator had no warning
  of. `estimateRequestTokens` now sizes the next request (message content,
  tool-call arguments, the system instruction, and the serialized
  tool-definition schemas — not just message content, which undercounted a
  request carrying a large tool-call payload) before every round-trip; once
  the estimate crosses 85% of the provider's known context window (never a
  guessed one — an unreported window disables the guard entirely, matching
  `/status`'s own "never invent 128k" rule), the driver compacts `history` in
  place with the same defaults the manual `/compact` command already uses.
  An OpenAI-compatible gateway's `context_length_exceeded` now also
  classifies as the existing `context_overflow` error kind — previously only
  the native OpenAI adapter recognized it — and either provider path now
  suggests `/compact` instead of a raw, unclassified error.
- **`temperature`, `maxOutputTokens`, and `timeoutMs` are configurable per
  OpenAI-compatible provider.** A custom gateway (`llm-providers.json`) can
  set its own defaults for all three; a built-in provider can be overridden
  the same way `baseUrl` already is. Resolved fresh on every `/model`,
  `/provider`, `/connect`, or `/models` switch. This also closes the wire gap
  underneath: both the OpenAI-compatible and native OpenAI adapters silently
  dropped `maxOutputTokens`/`temperature` regardless of configuration —
  only Anthropic and Gemini ever actually sent them — so a configured value
  now reaches the request either way. A configured `timeoutMs` bounds the
  chat call itself, not only the `/models` discovery probe. Nothing
  configured reproduces today's behavior exactly: `maxOutputTokens` still
  defaults to `1024`, no `temperature` is sent, no extra timeout applies.

## [0.2.113] — 2026-09-17
A read-only posture for the interactive agent session, and three small fixes
to the OpenTUI shell.

### Added

- **`/plan` — a read-only toggle for `keryx shell`.** Orthogonal to the
  existing `/mode ask|trust|auto`: where `/mode` decides how much
  confirmation a mutating call needs, `/plan` decides whether mutating tools
  are reachable at all. `/plan on` denies every non-`read` tool call
  unconditionally — a hard floor no mode lifts, not even `auto`. In-memory
  only, always starts off; there is no persisted default. See
  [Read-only mode: `/plan`](docs/docs/guides/permission-modes.md) in the
  permission-modes guide. `shell_exec` is denied entirely under `/plan` in
  this release — there is no read-only git surface (`git diff`/`log`/`status`)
  yet.
- **A one-time boot animation on `keryx shell --tui` launch.** Shown once
  before the provider/model picker; any keypress skips it. Set
  `KERYX_SKIP_BOOT=1` to disable it entirely (already applied automatically
  for automated/CI launches).

### Fixed

- **The sidebar silently clipped content instead of scrolling.** Anything
  mounted past what fit the terminal height — Workspace, Review, Tools,
  Status, Subagents, Background Jobs — was simply unreachable on a short
  terminal. The sidebar's content area is now a real scrollbox, the same
  primitive the main transcript already uses.
- **The sidebar's title didn't show which version was running.** The
  "keryx" title now carries the running version next to it, dim.

## [0.2.112] — 2026-09-16
Output from a background task reached the model provider unredacted. Releases
0.2.109, 0.2.110 and 0.2.111 carry the defect; this release is the fix and
contains nothing else.

### Fixed

- **A task-completion notification is redacted before it reaches the provider.**
  `redactSensitiveText` ran on the ordinary tool-result path and nowhere else. A
  completion notification carries the same kind of bytes into the same
  provider-bound history and never passed through it, so output was scrubbed when
  a command returned inline and leaked verbatim when the identical command
  outlived its yield and finished as a background task. The scrubber's own reason
  to exist names this case — a contained command that reads a credential must not
  leak the raw value onward to the provider — and delivery is that path too.
  Redaction now happens in the single notification builder every delivery path
  funnels through, after the tail slice rather than before it, because redaction
  is not length-preserving and scrubbing first would silently change what the
  4 000-byte bound means.

  **Who is affected.** Only sessions that ran a command whose *output* contained
  a secret through a background task — `env`, reading a credentials file, a build
  that echoes a token into its log. A command that merely *uses* a secret without
  printing it was never exposed by this. The leak went to the configured model
  provider as part of the conversation, not to disk or to any third party.

  **What you cannot check, and what to do instead.** Notifications are not
  written to disk and the context sent to a provider is not readable after the
  fact, so there is no local artifact to audit — "check whether you were
  affected" is advice that cannot be followed. If you recognise the case above in
  how you used background tasks on 0.2.109–0.2.111, treat the printed credential
  as exposed and rotate it.

  Found while drafting the requirements for on-disk transcripts: stating what a
  transcript must redact required stating what the code redacts today, and this
  path did not survive the check.

## [0.2.111] — 2026-09-16
Review stops acting on the wrong thing. An imported reviewer can now verify and
brings the rules it cites; a model block no longer pins whatever `keryx shell`
was last pointed at; and a reply pass can no longer post to a pull request that
has merged, at a commit it has left, from a review that was only ever a report.

### Fixed

- **`comments reply` refuses a merged or closed pull request, a stale `--sha`,
  and an unmanaged review.** A lightweight "review this PR" ended by replying to
  a pull request that had merged, citing a pre-merge SHA, and every check passed:
  the comments path never read `pulls/{n}`, `--final` was the only precondition,
  and `--sha` was written into the record but never compared. `collect` now reads
  the pull request and prints its state and head, warning when it is not open or
  `--sha` is not its head. `reply` refuses a closed or merged PR (`--allow-closed-pr`
  overrides), one whose state could not be read, and a `--sha` that is not the
  head — dry runs included — and validates `--sha` as a SHA. Posting requires
  `--review <managed package for this PR>` or `--result`; `--dry-run` does not.

- **`review tier` and `providers cross-family` read the caller's session.**
  Without flags both fell back to the provider/model `keryx shell` persisted in
  `auth.json`, so an orchestrator in Claude Code got a block pinning `keryx
  shell`'s last model — one its dispatch tool cannot run — and cross-family would
  class a Claude-authored change as another vendor's. The session now comes from
  `--session-provider`/`--session-model`, then `KERYX_SESSION_PROVIDER`/
  `KERYX_SESSION_MODEL` (which `keryx shell` exports to every `shell_exec`
  command, and external agents never inherit); `auth.json` only with
  `--from-shell-config`. A block names a model only when discovery assigned one
  other than the session's; otherwise it is adaptive — the tier plus
  `inherit: true` — and the host picks its own model for that tier.

- **Imported project-skills verify.** Import kept only the Origin lines of the
  keryx header, so `keryx skills verify` found no Version or Target (always
  `stale`) and no `Last Verified:` line to update (always `never`). The header is
  kept, with the author's `metadata.version` registered; skills imported earlier
  verify too. Origin is recorded as `~/…` or project-relative rather than an
  absolute home path that reads as `missing` on every other machine.

### Added

- **Import brings the rules a skill cites.** Missing `core/*.mdc` rules are
  copied from the overlay's `rules/`; a present rule is never overwritten, and a
  rule name keryx itself ships is never copied. Re-running `keryx review import`
  over an existing import fetches only the rules.

- **Project reviewers carry their triggers.** `keryx review reviewers --json`
  reports `paths` (from `metadata.paths` or the description's globs), `flags`,
  `stackRequires` and `unresolvedRules`, and review-orchestrator path-gates and
  selects project reviewers with them instead of running all of them every round.

## [0.2.110] — 2026-09-16
A running command is now something you can watch, wait for, interrupt and set
aside. 0.2.108 stopped a long command from freezing the session and 0.2.109 made
a finished one report itself; this release fills in everything in between.

### Added

- **Three task tools.** `shell_task_output(task_id, since?)` reads from a cursor
  YOU hold and tells you where to continue — unlike `shell_job_output`, whose
  cursor is implicit shared state, so two readers of one task quietly consumed
  each other's output. `shell_task_wait({task_ids, mode, timeout_ms?})` waits for
  `any` or `all` of a set instead of polling in a loop, bounded by a timeout
  clamped to at most five minutes. `shell_task_kill(task_id)` stops a task's
  whole process group and is idempotent: asking again after it ended reports its
  status rather than signalling anything, and a task that exited cleanly is not
  relabelled as killed.

- **A wait you can interrupt.** Tools now receive the turn's abort signal. The
  agent loop used to check for an interrupt only BETWEEN tool calls, so a call
  that was waiting could not be reached at all — the operator's stop did nothing
  until the wait's own bound fired. Interrupting now ends the WAIT and never the
  command: the task moves to the background, keeps running with its output
  intact, and still reports itself when it finishes. Both the `shell_exec` yield
  and `shell_task_wait` honour it.

- **`/demote <task_id>`**, in the TUI and in `--no-tui`, moves a running command
  to the background without stopping it and without ending the turn. It works
  while the agent is busy, which is the case it exists for: a turn blocked on its
  own long command is exactly when you want the command set aside rather than
  killed.

### Changed

- **Side workers can no longer disturb the main session's tasks.** They are
  denied kill, wait and the implicit-cursor read, and keep only the explicit
  read. Their copy of it never marks a task as reported, so a side worker looking
  at a finished task can no longer make the main session's completion notice
  disappear — the failure that exactly-once delivery could not defend against on
  its own.

- **The old names are deprecated.** `shell_job_output` and `shell_job_kill` keep
  working for one more release and now say so, each naming its replacement. An id
  written as `job-…` still resolves for READS; the acting tools take the id
  exactly as given, because a task id from an earlier session is a dead reference
  and resolving one onto a live task would kill the wrong work.

## [0.2.109] — 2026-09-16
A command that outlives the wait now reports itself. 0.2.108 stopped a long
command from freezing the session; this release closes the other half — the
result comes back on its own, exactly once, without the agent remembering to ask.

### Added

- **A finished task announces itself.** Until now a command that outlived the
  bounded wait kept running and its outcome reached nobody unless the model
  remembered to poll `shell_job_output` — so a build that failed while the model
  was writing a sentence about it simply vanished from the conversation. Each
  finished task is now delivered once, as a `<task-notification>` block carrying
  `task_id`, `status`, `exit_code`, `kill_reason` and `duration_ms`, with the last
  4 000 bytes of output and a banner stating the text is command output rather
  than an instruction. It is pushed at a round boundary, so it can never split a
  batch of tool results.

- **An unattended session waits for its own command instead of abandoning it.**
  `keryx shell --print` used to end its turn as soon as the model stopped
  talking, and the session sweep then killed whatever was still running: the
  command was started, the process died, and the output belonged to nobody. Such
  a session now holds the turn open until the task ends, reports it, and
  continues. The outer bound is `KERYX_SHELL_HOLD_MS` (default 30 min); a task
  still running past it is killed with the reason `hold-timeout` and reported as
  such, so the turn always ends on a stated outcome.

- **An idle interactive session wakes when a task finishes.** Both the TUI and
  the `--no-tui` REPL start a turn from the completion — the readline loop races
  your next line against the next completion, so a line you are typing always
  wins and nothing typed is dropped, and the TUI wakes only when nothing is
  running and no message of yours is queued. Consecutive automatic wakes are
  capped by `KERYX_SHELL_MAX_AUTO_WAKE` (default 5) and the cap resets the moment
  you type; past it the pending result is surfaced and delivered with your next
  message. Both knobs follow the project's fail-safe pattern: unset, empty,
  malformed and negative fall back to the default, and an explicit `0` switches
  the mechanism off.

### Changed

- **Reading a result counts as being told.** A task whose terminal status you or
  the model already saw — through `shell_job_output`, or by killing it — is never
  announced a second time. The rails are deliberately the other way round: a task
  killed for going idle or for flooding its output buffer still reports, because
  nobody asked for that kill. There is no recurring reminder: a running task
  produces no message at all, and a finished one produces exactly one.

## [0.2.108] — 2026-09-16
A long command no longer freezes the session. Every shell command the agent runs
is now a supervised task that hands back control within a bounded wait, and what
kills a stuck command is silence rather than the clock.

### Changed

- **`shell_exec` returns within a bounded wait, always.** It used to model a
  process as a request and a response, which is only true while commands are
  short. Anything longer blocked the whole turn until a 120-second wall-clock
  deadline killed it — unless the model remembered an optional `background: true`
  flag, which is exactly the thing it forgets when a command turns out to be slow.
  Reported from a live session: `sleep 120 && gh run list …` froze the turn for
  the full two minutes, the command was killed, and the follow-up
  `shell_job_kill` answered `not running`, because a blocking call was never
  registered as a job at all.

  Now every call starts a supervised task. A command that finishes inside the
  wait (`KERYX_SHELL_YIELD_MS`, 10 s) returns its output exactly as before — the
  common case is unchanged. One that does not keeps running in the background and
  the call returns `{task_id, pid, status, output}`, which
  `shell_job_output(task_id)` reads and `shell_job_kill(task_id)` stops. The same
  incident command now comes back in about three seconds with a task you can read
  and kill. `background: true` still works and now means only "do not wait".

- **A command is killed for going silent, not for taking long.** The wall-clock
  deadline is replaced by an idle timeout (`KERYX_SHELL_IDLE_MS`, 120 s), reset by
  every line of output: a build that keeps printing for ten minutes survives,
  while one that has produced nothing for two minutes does not. The kill says
  which rail fired and how to raise it. `KERYX_SHELL_TIMEOUT_MS` is still read as
  a deprecated fallback, so an operator who tuned the old knob keeps their value.

- **A killed task says who killed it.** The single terminal status `exited` split
  into `completed` (exit 0) and `failed` (non-zero), and `killed` now carries a
  reason: `model`, `operator`, `idle`, `output-cap` or `session-exit`. A kill
  requested twice still produces exactly one terminal event, and the first reason
  wins.

- **The concurrency cap counts background tasks only.** Three running dev servers
  used to be able to refuse a `git status`. A foreground command is bounded by the
  caller waiting on it, so it no longer consumes the cap, and a task that outlives
  its wait while the cap is full is never killed for it — the result names the
  running commands instead.

- **The TUI lists a task once it is actually in the background.** A short command
  no longer flickers through the Background Jobs panel on its way to finishing,
  and the inspector shows the kill reason next to the status.

### Added

- **`description` and `idle_timeout_ms` on `shell_exec`.** The first is a short
  label for the task list. The second is the escape for a command that is
  deliberately silent for a long time — a sleep, a slow poll — clamped to between
  1 second and 30 minutes, so the model can raise the rail for its own command but
  cannot switch it off; only the operator can, with `KERYX_SHELL_IDLE_MS=0`.

Approval, the OS sandbox, process-group kills and the session-scoped lifetime are
unchanged: a task still dies with its session, and `/clear` and `/new` still do
not sweep. This is phase P0 of
`docs/requirements/keryx-background-task-execution/`; completion notifications
that wake the agent, the `shell_task_*` tools and the documentation sweep are the
phases after it. (#563)

## [0.2.107] — 2026-09-16
A review finding now points at the code it quotes, a round no longer dies on a
field the report's own ordering already contained, and every round states what
it cost.

### Added

- **A finding carries the code it is about, and its line is derived from it.**
  Reviewers reported a line number and nothing compared it to anything, so a
  number that had drifted rode into `findings.json`, into the report, and into
  the disposition recorded against it. On a fix round the file has moved under
  the finding by construction, which is when the reported number is least
  trustworthy and most acted upon. A finding now carries `quote`, and
  `keryx review ingest` locates that quote at the commit the round records —
  exactly first, then with whitespace collapsed, then not at all. The line is
  what falls out of the match.

  An audit of every review package in this repository is what made the size of
  this visible: **108 of 582 anchored findings name a file that is absent at
  their own package's recorded head.** The anchor and the commit were a pair and
  nothing checked them together.

  Three outcomes, none of them a guess. `derived` keeps `reported_line` beside
  the derived one, so drift stays measurable rather than merely corrected.
  `unlocatable` writes `line: null` and a reason that distinguishes *the file is
  not there*, *the quote does not appear*, and *it appears more than once* — a
  quote matching twice is never anchored to the first hit, because choosing
  between them would be a guess wearing a line number. A finding that quotes
  nothing, because it is about the round rather than a site, carries no locator
  at all and says so.

- **Every round states its price.** `keryx review scope --reviewers a,b` prints
  an estimate before anything is dispatched, multiplied by the fan-out because
  every reviewer receives the scoped diff. `keryx review ingest --tokens-in
  <n> --tokens-out <n>` records what was actually used, and `keryx review
  complete` divides it by the findings that survived. A round nobody reported a
  cost for reads `not recorded`, and the command says out loud that this is not
  zero; a round that retained nothing prints the bill rather than an infinity
  dressed as a metric; and a per-finding figure that rounds down to nothing
  prints `< 1 token`, because in these records a zero means somebody measured
  one.

### Changed

- **`review ingest` fills in what is typing and still refuses what is
  judgement.** A round was lost to five findings that arrived without an `id` —
  every one recoverable from the report's own ordering — and then to a `problem`
  the reviewer had already written as a title. Both are supplied now, and what
  was supplied is recorded in `manifest.repairs` with the field, the finding and
  where the value came from, so a later reader can tell a statement the reviewer
  made from one carried across. `class_scope`, evidence and dispositions stay
  refused: an enumeration somebody has to perform, a check somebody has to have
  run, an outcome somebody has to have observed. The repair is accepted only if
  it introduces no property the contract does not define, removes none, and
  preserves the number of findings.

### Security

- **`review ingest` reads only inside the tree the round names.** Locating a
  quote means reading the file it names, which is new surface: a review report
  is data, and it can arrive from a reviewer agent, a file on disk or a pull
  request. Containment is enforced against the file system rather than the path
  string — `realpath` on both sides — so a symlink whose name sits inside the
  tree and whose target does not is refused. Without that, the `derived` /
  `unlocatable` outcome is a line-by-line oracle for any file the process can
  open.

- **Locating is bounded in both dimensions.** The matcher is O(file × quote) and
  ran once per finding with no cap, so a report could hold an ingest for
  minutes: a 50,000-line file against a 10,000-line quote measured 49 seconds
  for a single finding. Quote length and file size are bounded, and the scan
  stops once a second match proves ambiguity — the same three cases now measure
  11.1 ms, 2.3 ms and 1.3 ms.

## [0.2.106] — 2026-09-15
Review records follow a flow when it is renumbered, and records an older
renumber left behind can be repaired with one command.

### Fixed

- **`flow renumber` left review packages naming the old flow id.** It renamed
  the flow directory and recorded the move in `id-map.json`, but every managed
  review package inside kept `manifest.flow.id`/`path`, the six
  `manifest.artifacts` paths, the `flow:` line of `scope.md` and finding paths
  pointing at the old number and a directory that no longer existed. Nothing
  failed, because the review gate finds rounds by listing the directory. A
  renumber now rewrites those records before the rename and restores them if the
  rename fails. Review notes' `Link:`/`Location:` lines follow too. Paths quoted
  in reviewer prose are left as written. (#535)

### Added

- **`keryx flow repair-reviews`.** Re-points the review records of flows
  renumbered before that fix, by replaying `id-map.json` against where each flow
  lives now. Moves are followed by directory, so a flow moved twice and a number
  that left twice for two different flows both resolve correctly. It changes
  nothing on a second run. Run it once in a project that has renumbered flows,
  then commit what it lists. (#556)

## [0.2.105] — 2026-09-15
MCP servers and other read tools keep working after a session has read
untrusted web content, and `git push` no longer rewrites your commit identity.

`v0.2.103` and `v0.2.104` were tagged but never published: their release runs
stopped at lint. Everything they contained ships here.

### Fixed

- **Read tools refused for the rest of the session after untrusted content.**
  Once any untrusted web content entered history, every later tool call was
  blocked, including MCP servers such as context7 and plain code, graph and
  wiki lookups. Only tools that can act on an injected instruction are blocked
  now: write, shell, network, credential, delegate and destructive tools, plus
  the three read-risk tools that persist state (`workspace_create`,
  `workspace_propose`, `slate_write_seed`).
- **`git push` rewrote the repository's git identity.** The pre-push testing
  hook ran the suite with the `GIT_DIR` git exports to hooks, so test fixtures
  that set `user.name`/`user.email` in a temp repo wrote them into the checkout
  being pushed. Later commits were authored `Test <test@example.com>`, which
  GitHub links to no account. The hook and `keryx test run` now clear git's
  repository-discovery variables before running tests. Run `keryx update` to
  reinstall the hook, then check `git config --local --get-regexp '^user\.'`
  and remove any identity a past push left there.

## [0.2.102] — 2026-09-14
GitHub Copilot can list models after login. The picker was calling
`/v1/models` on `api.githubcopilot.com`, which is a 404 HTML page, and then
asking you to edit the host.

### Fixed

- **Copilot `/models` 404.** Copilot's OpenAI-shaped API is not versioned under
  `/v1`: models are `GET /models` and chat is `POST /chat/completions`. The
  registry now uses those paths. Token exchange also stores `endpoints.api`
  (individual / business / enterprise) so the picker does not stay on the
  generic host that 404s for some plans. Re-login once so the discovered host
  is saved.

## [0.2.101] — 2026-09-14
GitHub Copilot device login completes again: the token exchange no longer 403s
because keryx used OpenCode's OAuth App instead of the Copilot GitHub App.

### Fixed

- **GitHub Copilot login: `token exchange failed (HTTP 403)`.** Device-code
  succeeded, then `GET /copilot_internal/v2/token` was refused. The catalog used
  OpenCode's OAuth App (`Ov23li…`, `gho_` tokens) and `User-Agent: keryx`.
  GitHub's Copilot API accepts the Copilot GitHub App (`Iv1.b507a08c87ecfe98`)
  plus Copilot Chat identity headers. Login, refresh, `/models`, and inference
  now send those headers. A 403 surfaces GitHub's message instead of a bare
  status. Re-login is required; an old `Ov23li` grant will still fail.

## [0.2.100] — 2026-09-13
`/mcp` is a modal, not a dump of lines into the transcript: name, status, and
connect/disconnect on the same surface the other agent CLIs already have.

### Changed

- **`/mcp` opens a modal with connect/disconnect per server.** It used to print
  one dim line per configured server into the transcript, with no way to act on
  it. The row now shows the name, source, transport and a status glyph
  (`● connected` / `○ disabled` / `✗ failed` / `… connecting`); `c`/`d` then
  `y` — or a second click on the same row — dials or closes that server. A
  project server still held for `keryx mcp trust` names the command instead of
  offering connect. The toggle writes the personal overlay, not the native
  config file, the same way `keryx mcp enable`/`disable` already do.
  `/integrations` remains the installer of keryx itself.

## [0.2.99] — 2026-09-12
The PII detector stops mangling identifiers, without starting to miss phone
numbers. Both halves were needed: the first attempt fixed the mangling by
suppressing any match with a letter nearby, which quietly stopped redacting real
numbers that merely sat next to a word — caught by this repository's own review
round before it reached a release.

### Fixed

- **A UUID is no longer read as a telephone number.** The PII detector redacted
  the middle of hyphenated identifiers — `730344f3-3668-4760-9056-bf7292686b67`
  came back as `730344f3-[REDACTED:phone]-bf7292686b67` — because a hyphen
  satisfied both of the phone pattern's boundary checks while also being a legal
  separator inside it. Any identifier crossing a redacting surface, MCP tool
  output included, was silently corrupted at that rate: 46 of 5 000 random v4
  UUIDs, about one in a hundred. A candidate is now dropped only where the
  surroundings are demonstrably a hex identifier — the whole token is a UUID, or
  a hex run of 8+ characters carrying an `a`-`f` sits beside it. Where the shape
  is genuinely ambiguous (`word-1234-5678-9012-word`) the number is redacted:
  corrupting an identifier is a smaller harm than handing out a phone number,
  and no local signal separates the two.

## [0.2.98] — 2026-09-12
Credentials, and what keryx says about them. `shell_exec` stops handing saved
provider keys to the commands it runs; `/provider` stops going mute when one is
refused, and lets you replace it; a scripted shell refreshes an expired grant
instead of sending it; and the test suite stops opening browser tabs on the
machine running it.

### Changed

- **`shell_exec` no longer hands your saved provider keys to the commands it
  runs.** keryx loads the keys saved in `auth.json` into its own environment so
  its providers can find them, and every `shell_exec` command inherited the lot:
  an agent that ran `env` printed the operator's DeepSeek, OpenRouter and xAI keys,
  none of which the session was using. A command now gets your own environment
  minus every credential keryx set from its saved config; a key you exported
  yourself still reaches it. `KERYX_SHELL_PASS_SAVED_KEYS=1` restores the old
  behaviour. The restricted-network sandbox still injects the real values at its
  proxy.

### Fixed

- **`/provider` says why the model list is empty, and lets you replace a refused
  credential.** Picking a provider whose stored credential had expired asked for
  nothing and opened an empty model picker: the live `GET /models` answered
  `403 The OAuth2 access token could not be validated`, and every failure —
  refused credential, wrong endpoint, offline, genuinely no models — collapsed
  into the same mute "(no models found)" (regression from `d0d86c76`). The
  picker now names the cause in the provider's own words, and a 401/403 re-opens
  the credential step — which previously could never run, because the dead value
  in the environment was itself the reason it was skipped. `/model` and chat's
  provider picker show the same line.

- **Running the test suite no longer opens browser tabs on the developer's
  machine.** `openAuthorisationUrl` took a platform and an environment for the
  decision and then opened the URL through the real `process.platform`,
  `process.env` and `spawn`. A test that named `darwin` or a Wayland session to
  exercise the "a browser will open" branch therefore spawned a real browser —
  `open https://auth.test/…` twice per run of the `keryx mcp auth` decision
  tests, against a `.test` host RFC 6761 guarantees will never resolve, so the
  tabs opened and hung. The opener is now a parameter and receives the same
  platform and environment the decision used.

- **A scripted `keryx shell` no longer sends an expired grok login.** The refresh
  of a stored grant ran only in the TUI's start-up, so `--no-tui` and `--print`
  sent an access token hours past its expiry and got `HTTP 403: The OAuth2 access
  token could not be validated` — which reads as a revoked login, not an expired
  one. Every surface now refreshes first — only the provider the flags name, when
  they name one, and for at most five seconds, so an offline start is not held
  up. A refresh that fails, or an expired login with no refresh token, says so on
  stderr and names `keryx auth login <provider>` instead of being swallowed.

- **A `memory_search` that finds nothing says so in one line.** In a project that
  has never deleted anything, every miss also carried the deletion journal's
  absolute path and a ~700-character caveat about it. It now reads "no removal has
  ever been recorded in this project", with the same bound and no path; other
  trail verdicts keep their prose, with paths relative to the project.

## [0.2.97] — 2026-09-11
`keryx mcp auth` — OAuth for remote MCP servers, so a server that needs a
login can be used without pasting a bearer token into a config file.

### Added
- **`keryx mcp auth <name>`** — runs the authorisation flow in a browser and
  stores the result owner-only (0600) in `mcp-credentials.json`. Tokens are
  keyed by server name *and* URL: repointing a server at a different host
  does not send it a credential issued to the first one.
- **Sessions never start a flow.** Only `keryx mcp auth` can open a browser.
  A session opening one you did not ask for, or blocking a headless shell
  waiting for a consent screen nobody will click, are both worse than a
  clear refusal naming the command to run.
- **`needs_auth` in `keryx mcp doctor`**, for a server whose credential is
  absent, expired beyond refresh, or revoked — naming the command that fixes
  it, rather than reporting the 401 as the server being broken.
- **Dynamic client registration**, only when `oauth.clientId` is absent. An
  operator who registered the client themselves does not get a second one.

### Security
- The loopback callback binds `127.0.0.1` on an ephemeral port, validates
  `state`, serves exactly one request, and times out. A callback on every
  interface is an authorisation code offered to whoever shares the network.
- No surface prints token material. Asserted over every `keryx mcp`
  subcommand, both streams, and the `--json` forms — enumerated from the
  subcommand list, so a new one is covered the day it is added.
- Authenticating writes one file. Every other file in the config directory
  is byte-identical afterwards, including the comments and ordering in a
  hand-edited `mcp-servers.json`.

## [0.2.96] — 2026-09-11

### Fixed

- **A `keryx shell` start that fails no longer hangs when MCP servers are
  configured.** The readline path (`--no-tui`, `--print`) starts the session's MCP
  runtime before it builds the tool list, and a refusal thrown while building it —
  an unknown name in `--deny-tools` is the reproduced case — left before the
  runtime was closed. One live child per configured server then held the process
  open: the error printed and the shell never exited (measured: killed at 90 s,
  against 1.3 s with no servers). Every exit from the agent branch now closes the
  runtime — aborting a dial still in flight, and closing any server that had
  already connected.

- **Closing the MCP runtime no longer holds the process for its full grace
  period.** `close()` bounded its waits with timers it never cleared, and the CLI
  exits by letting the event loop drain, so every close kept the process alive for
  about 4.5 s after it had finished — after every refused start and after every
  `keryx shell -p` run. The timers are now cleared as soon as the wait resolves,
  and a second `close()` returns the first one's result instead of waiting again.

## [0.2.95] — 2026-09-11

Five defects in keryx's own agent tools and error handling, read off a transcript
of the shell on a research task. Each is a place where the shell worked against the
model it was driving; each is fixed whatever any comparison says.

### Added

- **`read_file` reads past the first 20 KB** — optional `start_line` (1-based).
  The tool returned the first 20,000 bytes of a file and nothing else; content past
  them was unreachable however the model asked. A truncated read now ends with the
  lines it showed and the `start_line` to continue from, and a line reported by
  `search_code` or `graph_symbol` can be read directly. Streamed, so memory stays
  bounded; a `start_line` past the end is an error that states the file's length.

### Changed

- **A project without `.metaproject/` is no longer offered the tools that need
  one.** The graph, wiki, memory, flow, health, testing and skill tools read
  artifacts under `.metaproject/`, and in a plain repository they could only fail —
  the measured session called `graph_find` and got `index-incomplete … never built
  here`. Each was also a description the model re-read every round. `search_code`
  stays, and a project with `.metaproject/` gets exactly the roster it had.
  `--deny-tools` still accepts those names in a plain repository, so one command
  line does not pass in one directory and fail as "unknown tool" in the next.

- **The agent's instruction describes the tools it was actually given.** It named
  every metaproject tool and told the model to call `graph_symbol` first whatever
  the roster held, and it said `read_file` "cannot page forward". It is now built
  from the session's roster, and says how to page.

- **`search_code` output is project-relative, long lines are capped, and a clip
  says how much it dropped.** A path argument went to ripgrep absolute, so every
  match line carried the checkout's root — about 65 bytes of noise per line. One
  matching line of an SVG or a minified bundle is the whole file (8 KB came back
  from a single SVG); lines are now capped at 400 columns. A result over the cap
  said `…(truncated)`; it now says `showing N of M lines`, cut at a line boundary.

### Fixed

- **An OpenAI-compatible provider's errors name that provider, keep the server's
  reason, and classify auth and rate limits.** Every registry provider was built
  with Ollama's identity, so a grok session reported `Ollama API returned HTTP 403`.
  The message now uses the registry label, keeps the status, and carries the
  server's reason from the JSON shapes gateways use — `error.message`, `error` as a
  string, `message`, `detail` — redacted and capped at 300 characters. A non-JSON
  body is still never surfaced. 401 and 403 are `authentication`, 429 is a
  retryable `rate_limit` honouring `Retry-After`; every 4xx was `invalid_request`
  before. The first real call through it turned a bare 403 into `xAI (Grok) API
  returned HTTP 403: The OAuth2 access token could not be validated.` — which had
  been blamed on an exhausted balance. The provider id stays `ollama` for now;
  giving each provider its own is a separate change.

- **The subprocess runner runs the keryx that is running.** It spawned whichever
  `keryx` PATH resolved, which is routinely a different build: a shell run from
  source had its tool fallbacks answered by an installed release four versions
  behind. It now re-runs keryx's own entry script with the current bun, or the
  compiled binary itself, and uses PATH only when the process is not keryx.

### Shipped in 0.2.94, recorded late (#524)

Both changes below went out in 0.2.94 and are missing from that entry; they are
recorded here rather than by rewriting a published section.

- **Security: a credentials file was masked on one line and printed in full on the
  next.** `redactSensitiveText` exists so that `cat ~/.aws/credentials` does not
  leak into the model context, and both forms of that file passed through: the key
  id was masked and `aws_secret_access_key` printed in full. The uppercase rule
  missed names ending in `ACCESS_KEY`, and the credentials file writes the name in
  lower case. A short case-insensitive list of names that mean one thing now covers
  it, tested in both directions — prose and camelCase identifiers stay untouched.
- **`keryx shell --print <prompt>`, `--events-file <path>`, `--events-max-field
  <n>`.** One agent turn through the same loop a person drives, and an NDJSON
  transcript of it — turn boundaries, tool calls and results, provider usage —
  written beside the rendered output, never instead of it. Every string passes the
  redaction floor before it is clipped.

## [0.2.94] — 2026-09-11
`keryx mcp` — keryx as a CLIENT of other people's MCP servers. This entry
covers 0.2.90 through 0.2.94: those versions were tagged in `package.json`
during development but never published, so 0.2.94 is the first release that
carries any of it.

### Added
- **`keryx mcp add|list|remove|enable|disable|trust|untrust|doctor`** — the
  servers keryx connects to, as distinct from `keryx serve-mcp`/`keryx
  integrate`, which publish keryx itself. Native config is
  `mcp-servers.json`, user-global and project-scoped, with `${VAR}` and
  `${VAR:-default}` expansion.
- **Two tools of fixed cost, not one per server tool.** `search_tool` finds a
  tool by name, description or server; `use_tool` calls it. Connecting a
  server with ninety tools does not put ninety tools in front of the model.
- **Remote servers over streamable HTTP.** `keryx mcp add <name> --transport
  http <url> --header 'Authorization: Bearer ${TOKEN}'`. `sse` is an alias:
  it is what a server chooses when it answers, and streamable HTTP negotiates
  it.
- **`/mcp` in a session** lists what is connected, what failed and why, and
  what is waiting for `keryx mcp trust`. `/integrations` remains the
  installer view.
- **Read-only compat readers** for Cursor (`.cursor/mcp.json`), Claude
  (`~/.claude.json`, including its per-project block), a bare `.mcp.json`,
  and Grok (`.grok/config.toml`). A server you already configured elsewhere
  appears in `keryx mcp list` tagged with its source. keryx never writes to
  those files: `remove` on such a name fails and names the file to edit, and
  `enable`/`disable` record your preference in keryx's own overlay.

### Security
- **A project-scoped server is not started until you approve it.** A
  committed `.keryx/mcp-servers.json`, `.mcp.json`, `.cursor/mcp.json` or
  `.grok/config.toml` is code whoever you cloned from wrote, and cloning is
  not consent to run it. Such a server is held at `needs-approval` until
  `keryx mcp trust <name>`, and the approval is keyed to the exact command,
  url, environment and credential variables — editing any of them revokes it.
  A server from your own home directory is not held: you wrote that file.
- **A credential that resolves to nothing never reaches a socket.** `Bearer
  ${TOKEN}` with `TOKEN` unset expands to a non-empty `"Bearer "`, which
  produces a 401 that reads as the server being broken. keryx refuses before
  connecting and names the variable to set.
- **Three refusals made on purpose**, each a working configuration elsewhere:
  a redirect is not followed (your credential header would follow it), a
  username or password in the url is rejected (it prints everywhere and the
  HTTP client drops it anyway), and an unset `${VAR}` in a url is rejected
  rather than silently addressing the wrong path.
- **No credential value is ever printed** — not by `list`, `doctor --json`,
  the `/mcp` view or the approval prompt. Variable NAMES are shown so you
  know what a server will be handed.
- **A third-party server cannot draw on your terminal.** Tool names,
  descriptions, results and error bodies are neutralised before display, so
  a server cannot paint a forged `✓ auto-approved` line.
- **Approving an MCP call names the server and the tool above the
  arguments**, and never offers "always allow" — the grant pattern would be a
  name the model chose, stored in your permission file.

### Fixed
- A tool whose qualified name fails the FQN pattern is renamed for the model
  and kept verbatim on the wire, instead of being dropped. Measured against
  keryx's own server: 19 tools reachable before, 40 after.
- `keryx mcp --help` describes the consumer subcommands. It described only
  the retired publisher spellings, so looking up `list` or `doctor` sent you
  to `serve-mcp`.

## [0.2.89] — 2026-09-10

### Added

- **`keryx shell --deny-tools <a,b>`** — withhold named tools from a session
  entirely. There was no way to say "this session does not need the web". Both
  other agent CLIs offer one (`claude --disallowedTools`,
  `grok --disable-web-search`), and keryx already treats egress as a product
  concern elsewhere — `keryx harness exec --allowed-domains`, `sandbox.json` — so
  a session-level roster that could not be narrowed was the inconsistent part.

  Distinct from `--permission-mode`, which governs whether a call is APPROVED. A
  denied tool is never offered to the model, so it cannot be attempted, reasoned
  about, or approved by mistake — and the roster read back afterwards is the one
  the turn actually ran with.

  An unknown name is refused rather than ignored, and the error lists what is
  deniable: `--deny-tools web_serch` must not leave the session with web search
  and a clear conscience. Repeated use accumulates rather than replacing, since
  silently dropping the first list would be the worse surprise for a flag whose
  whole job is removing a capability.

  Written for two cases: a sensitive checkout where a tool that fetches from
  outside it is a liability, and any comparison that needs the roster to match
  another tool's.

## [0.2.88] — 2026-09-10

Two defects that together made `keryx shell` unusable with a subscription-based
OpenAI-compatible provider. Both were found by a benchmark arm, which is the worst
place to find them: the arm completed, wrote a transcript, and reported nothing, so
"the model was never called" looked exactly like "the model read nothing".

### Fixed

- `keryx auth login <provider>` stored a token nothing read. `makeProvider` resolves
  an OpenAI-compatible provider's key from `env[definition.envKey]` — `XAI_API_KEY`
  for grok — and the shell's provider factory passed neither `env` nor
  `credentials`, so `process.env` was the only source. A user who authenticated by
  subscription and never exported an API key got `FakeProvider`: an offline stub
  that answers nothing while the session header still names the provider that was
  asked for. The grant now reaches the construction that needs it, passed through
  `credentials` rather than written into `process.env` so it does not leak into
  every child the session later spawns. An explicit environment key still wins.
- An OpenAI-compatible stream was never asked for usage. Without
  `stream_options: { include_usage: true }` the response carries none at all, so
  `onUsage` never fires, `NormalizedUsage` stays empty and a session cannot report
  what it spent. Enabled for grok, where it is verified — the same request returns
  zero usage chunks without the field and `prompt_tokens: 638, cached_tokens: 512`
  with it. Declared per provider and confirmed per provider: deepseek, openrouter,
  cerebras, groq, moonshot, zai and github-copilot are marked unchecked, which means
  not yet verified rather than unsupported, and the loopback Ollama path is left
  alone so a local model that works today keeps working.

## [0.2.87] — 2026-09-10

### Added

- **`keryx flow init --base <branch>`, and a completion condition that reads
  it.** The flow record held a pull-request url and no branch of any kind, so
  `flow complete` had no recorded answer to "where was this supposed to land".

  Narrower than it sounds, and worth stating precisely: the review gate's
  condition 3 already compares CONTENT, so a branch cut from `feature/x` and
  merged to `main` is refused today — the trees differ. What survives that is a
  target that has CONVERGED with the intended one, where a squash onto either
  yields the same tree. `review-pr-feedback --fix` makes exactly that shape: it
  cuts from another pull request's head and must land back inside it, or the
  reviewer's diff is unchanged while the run reports success to every reviewer.

  Three states, kept distinct: `not recorded` (no base named — not a pass),
  `unobserved` (recorded but unresolvable — fails, and names
  `git fetch origin <branch>`), and pass/violated. The base is also captured at
  `flow implemented` from the pull request's own base, but only when the record
  is still empty: overwriting it would let a retargeted PR pass itself.

### Fixed

- **A Force keypress guard that no test could fail.** The rule stopping a
  second queue-Force press from double-dispatching lived in the TUI shell,
  which has no headless seam, so it was covered by a test that reads the file
  as text. Deleting the guard left every assertion passing and the whole
  101-test file green. The rules moved into `forceForegroundQueueItem`, where
  three behavioural tests drive two overlapping presses.

### Internal

- The routing guard now pins the reachable trigger set by NAME rather than by
  count, and one-word triggers have their own inflection test — the property an
  earlier regression cost 29 of them, which a reachability count could not see.

## [0.2.86] — 2026-09-10

Two defects in the machinery that is supposed to notice defects, both found by
clearing out stale flow records rather than by looking for them.

### Fixed

- **The post-commit hook left the graph silently stale for indexed source.**
  It decided whether a commit was graph-relevant from a list of directory
  prefixes — `src/`, `lib/`, `app/`, `packages/`, `services/`, `scripts/`,
  `docs/` — while the builder indexes any `.ts/.tsx/.js/.jsx/.java/.py` file
  anywhere except the fifteen directories it never walks. Source between those
  definitions was indexed and undetected: a nested package's `src/`, a
  root-level entry file, anything under a directory not on the list.

  The silence was the defect. Every other branch of that hook prints a warning
  when the graph may be stale; this one returned 0 with no output, which is
  exactly the failure the hook was written to end.

  The prefix list is kept, so nothing that rebuilt before stops rebuilding, and
  the added extension test excludes the same directories the builder ignores —
  a rebuild triggered by a file the builder never reads cannot change the
  answer, and every dependency bump would pay for it.

- **A managed hook block containing `$'` duplicated every block below it.**
  `installManagedHook` wrote blocks with the string form of `String.replace`,
  which reads `$'`, `` $` ``, `$&` and `$$` in the replacement as substitution
  patterns rather than literal text. These blocks are shell scripts. `$'` means
  "everything after the match", so writing such a block spliced the rest of the
  hook file back in and silently duplicated every managed block after it — the
  hook still ran, it just ran those blocks twice.

  Nothing had triggered it because no rendered hook happened to contain one of
  the four sequences; the fix above added `(…|py)$'` and it fired immediately.
  It had been one character away since the function was written. Fixed in both
  copies, `update.ts` and `init.ts`, since a project would otherwise be
  corrupted on `init` and correct on `update`.

### Internal

- Six flow records deleted that were never work: prompts from ad-hoc harness
  runs that created real records as a side effect. Six more closed through the
  completion gate — four unchanged on the first attempt, two on reviews that
  were actually run because a flow with no recorded review has not been
  reviewed.

## [0.2.85] — 2026-09-09

One theme: `keryx mcp` meant "keryx is the MCP server", and the same verb is
needed for the opposite — the third-party servers keryx connects to, which is
what `mcp add|list|remove` means in every other CLI. MCP names a protocol, not a
direction, and keryx is on both sides of it. So the publisher surface is renamed
and `keryx mcp` is freed for the consumer that does not exist yet.

Nothing is removed. Every retired spelling still works and still exits with the
code it did, so a script that ran before runs now.

### Changed

- **`keryx mcp serve` → `keryx serve-mcp`; `keryx mcp install` → `keryx
  integrate <editor>`; `keryx mcp uninstall` → `keryx integrate --remove
  <editor>`; `/mcp` → `/integrations`.** The new verbs hold the implementation
  and the old spellings are thin aliases — a new verb delegating to the old one
  proves nothing and leaves two implementations to drift. Each retired spelling
  prints exactly one deprecation line, asserted as exactly one: a notice
  repeated per sub-operation is a notice people learn to ignore. On the serve
  path it goes to stderr, because stdout is the JSON-RPC channel.

- **`/mcp` is not repointed at the consumer.** It keeps opening the installer
  view and gains `/integrations` as the name that says what it does. A slash
  command aimed at nothing is worse than one aimed at the old thing.

### Fixed

- **Generated editor configs invoked the retired spelling.** `MCP_SERVER_ARGS`
  was still `["mcp","serve"]`, so every config keryx writes would have printed
  our own deprecation notice into other people's sessions, permanently.

- **`keryx mcp install --help` did not print help — it installed.** Into every
  runtime. Someone asking for help got entries written into four other tools'
  configs.

- **`keryx integrate --remove <editor> --dry-run` performed a real removal.**
  The flag was accepted, documented and ignored. Pre-existing, but the rewritten
  help dropped the old "install only" qualifier, turning a documented limitation
  into a documentation lie.

- **`scripts/` was never typechecked.** `tsconfig`'s `include` stopped at
  `src/`, which is not a skipped convenience check: a leakage check in the
  benchmark harness read a property its own result type does not have — it could
  never have detected leakage — and typechecked clean for weeks. The gates this
  repository relies on are written in that directory.

- **The NUL-byte guard failed on other programs' output.** It walked the working
  tree into gitignored benchmark transcripts, so it was red on developer
  machines and green in CI. A check that fails only where people work is one
  they learn to skip past.

- **`.benchmark-runs/` was untracked but not ignored**, so one `git add -A`
  could put another project's material into this repository's history.

### Internal

- A build gate fails when documentation, source or `.gitignore` teaches a
  retired spelling. Mapping tables recording "was → is" are exempt by shape, per
  cell rather than per row — a genuine pair must not excuse an unrelated
  instruction sharing its table row.

## [0.2.84] — 2026-09-09

One theme: a project-skill you already have as a `SKILL.md` — in a folder,
a file, or a GitHub blob — could not become a project-skill without being
re-typed through `keryx skills create`. Overlay reviewers lived in
`~/.vantage-frontend` and `review-orchestrator` never saw them.

### Added

- **`keryx skills import --from <dir|SKILL.md|https-url>`.** Copies a
  `SKILL.md` (or a directory of them) into
  `.metaproject/project-skills/<module>/<name>/`, stamps Origin, and
  hashes the source so drift is detectable. `--module review` is the only
  module `review-orchestrator` auto-dispatches (`keryx review reviewers`).
  Other modules register for `keryx skills route` and are not injected
  into flow-orchestrator's fixed pipeline — the import report says so.
  A GitHub `--from` must be an https blob/raw URL to a `SKILL.md`; tree
  URLs and other hosts are refused. A name that collides with a bundled
  keryx skill is skipped unless `--force`.

- **`keryx skills update <module>/<name> [--from <origin>]`** and
  **`keryx skills update --all`.** Re-reads Origin and overwrites
  `SKILL.md` when the source moved on. A skill with no Origin is skipped,
  not guessed.

- **`keryx review import --from <dir>`.** Alias for
  `keryx skills import --module review` with an extra filter: only
  `review-vantage-*` packages, so generic copies of bundled reviewers
  cannot shadow the engine.

### Changed

- **`createProjectSkill` accepts already-fetched origin bytes.** A GitHub
  `SKILL.md` is not a file; the import path hashes the fetched body and
  records the URL as Origin. HTTPS origins report `clean` on
  `keryx review reviewers` rather than `missing` — listing does not open
  a socket; `skills update` re-fetches.

## [0.2.83] — 2026-09-08

One commit. `/status` already showed last-turn tokens and a labelled
estimate, and refused to invent a 128k window. It still could not show
the model's actual limit, so the bar was always relative to used tokens.

### Added

- **`/status` reports provider-reported context window, rate limits, and
  balance when the provider actually sends them.** OpenAI-compatible
  `/models` (including nested OpenRouter shapes) and Ollama `/api/show`
  supply the window; rate-limit headers and DeepSeek/OpenRouter balance
  endpoints fill the rest. Anthropic, Gemini, and any fetch that does not
  answer stay `—`. The context bar fills against that window when it is
  known, otherwise it keeps the old relative bar. Wired through the TUI
  inspector and both readline surfaces. Missing is missing — never a
  guessed limit.

## [0.2.82] — 2026-09-08

One commit. SuperGrok login in the TUI spawned `xdg-open` without an
`error` listener. On a Linux box with no display that binary is often
missing; Node emits ENOENT later, that is an uncaught exception, and
the shell dies.

### Fixed

- **Device-code login no longer crashes the TUI on headless Linux.**
  Opening a browser is best-effort and only attempted when `DISPLAY` or
  `WAYLAND_DISPLAY` is set. A missing opener is ignored rather than
  becoming an uncaught exception. The overlay keeps the URL and user
  code so the operator can finish on another device, and a failed login
  stays on screen instead of vanishing.

## [0.2.81] — 2026-09-08

Six commits since 0.2.80. The agent-first core programme closed phases 0–2
on main, then an independent review found the auto-fetch floor still leaked
across line endings; that class is closed here. Separately, subscription
login landed for SuperGrok, Copilot and ChatGPT, and this repository
adopted the full gdskills install profile it had been running uncommitted.

### Added

- **`keryx auth` — device-code login for SuperGrok, ChatGPT Plus/Pro, and
  GitHub Copilot.** RFC 8628 against the vendor-published clients: xAI
  (`auth.x.ai`, Grok CLI client), OpenAI Codex headless device-auth, and
  GitHub Copilot (`login/device/code` then `copilot_internal/v2/token`).
  Grants land in user-global `auth.json` at mode 0600. SuperGrok injects
  `XAI_API_KEY`; Copilot injects `GITHUB_COPILOT_TOKEN`; a ChatGPT grant is
  stored and is not applied as `OPENAI_API_KEY`. Claude Pro/Max, Gemini
  Google-account login, and DeepSeek subscription OAuth stay refused: those
  vendors do not sanction third-party clients. Commands: `auth list`,
  `auth status`, `auth login`, `auth logout`. `/provider` offers SuperGrok
  vs API key when xAI is the family.

- **The routing gate is 277 tokens instead of ~3,226.** `.metaproject/index.md`
  keeps pointers and the two rules that change behaviour (`keryx ctx rg`,
  graph answers from the last build). Everything else moved to `routing.md`.
  Subagent prompts are no longer required to re-read the full index: the
  parent inlines the pointers that slice needs. Measured, not assumed: the
  old index was re-sent every turn, about 80,000 tokens on a 25-turn task.

- **Agent-first core phases 0–2.** One routing-entrypoint writer shared by
  init, update and rules (M01). `maxRounds` is an inclusive ceiling on every
  provider request including wrap-up; a stop with no progress no longer
  claims budget exhaustion with rounds unspent (M10). Contained reader with
  owner/target pinning, secrets in property names fail closed, loopback-only
  bind, findings separated from coverage so a missing required source is no
  longer a clean pass, scan recursion terminating on `dev:ino`, shell argv
  validated before the model starts (phase 1). Wiki and memory share one
  lifecycle rule; testing snapshots stop serving a cached answer; graph
  invalidation no longer treats an untouched `.git/HEAD` mtime as fresh;
  the transpiler loader is chosen by extension; grammar availability loads
  the grammar rather than checking an asset resolved; claim provenance
  survives onto the assembled handoff (phase 2).

- **This repository now installs the full gdskills profile.** Thirty skill
  directories that had been sitting uncommitted are versioned; `keryx skills
  install --profile full` is idempotent at 78 bundled skills.

### Fixed

- **The zero-click auto-fetch floor leaked across line endings.** A construct
  may wrap, and inside a block container the marker is repeated on the
  continuation line. Four rounds each fixed one reader and declared the
  class closed; the fifth enumeration found five of eleven regex readers
  still carrying the shape. The inline-destination reader now calls the
  existing marker-consuming helper. HTML is re-scanned over the renderer's
  own view of the document, so a future HTML reader is covered by
  construction. A source census derives "does this cross a line terminator"
  from the pattern itself, and a metamorphic test asserts the floor is at
  least as capable on a document as on the renderer's view of it — 109 leaks
  on the reverted code. Cost stays linear: 47 ms over 840 KB.

- **Reference definitions inside blockquotes and list items were an
  accepted bypass, and that judgement was wrong.** Phase 1 shipped twelve
  spellings the renderer fetched while every public boundary reported
  nothing. Extending the definition scanner's leading-whitespace skip to
  consume container markers closed all twelve without a markup parser, then
  seven more wrapped-destination shapes the enumeration found. 13.5 ms on a
  megabyte of nested markers.

- **A failure rendered as a clean success, at sixteen sites across two
  phases.** `readJsonObjectFile` separates a parsed object, a non-object
  value and an unreadable file; only readers feeding a gate, an exit code
  or a security decision were migrated. The agent-facing tool boundary
  dropped every provenance field, so a sourced entry and an unsourced one
  reached a model byte-identically. Testing incompleteness reached no
  read-only surface. The health file walk crashed on an unreadable
  directory. One health adapter accepted a corrupt report as parsed with
  zero findings.

- **The link checker matched markdown inside backticks**, so the document
  that has to write `![alt](URL)` verbatim to define the auto-fetch floor
  failed CI with three broken links to a file named `URL`. Code is blanked
  before extraction. Net: three phantom links gone, one real link the old
  regex had missed.

### Changed

- **ESLint is installed and actually runs.** The health gate's "required
  ESLint" had been silently skipping because the binary did not exist.
  Root config now ignores `vscode-extension/` (its own package, own
  tsconfig); a `**/*.test.ts` override without a TypeScript parser had
  been parsing those tests as espree and then the "fix" of dropping type
  imports broke the extension typecheck job.

- **28 dependency advisories to 0.** Every one arrived through a
  development or optional dependency; the runtime dependency block is
  empty and stays empty. Health gate PASS with zero blocking findings,
  the first time in this programme.

## [0.2.80] — 2026-09-05

Five commits, and three of them are one shape: a mechanism that could not
establish something, reporting that it had. This release began by documenting
the Living Wiki commands 0.2.77–0.2.78 shipped, and every subsequent finding
came from running the thing being documented rather than reading it.

### Fixed

- **`keryx wiki refresh --help` performed the refresh instead of printing
  usage.** It regenerated the managed Reference block of 37 pages. `wikiCommand`
  only inspected the flag in first position and the subcommand never looked at
  it, so asking what a command does performed it. `--help` anywhere in the argv
  now prints usage and returns: a help flag that writes to the working tree is
  the one flag that must never reach the body.

- **The four Living Wiki commands were undocumented.** `wiki freshness`,
  `refresh`, `verify` and `migrate-markers` appeared in neither `keryx wiki
  --help` (the router dispatches fourteen subcommands; the banner listed ten) nor
  `cli-reference.md`, a file titled "Every command, subcommand, flag, and exit
  code". `agents monitor` had the same gap under a section whose opening sentence
  counted the verb's surfaces and said "two" while the router dispatched three.

- **`keryx sync` reported "up to date" when it could not compare at all.**
  `diffSince` returns null when git cannot answer — its own comment says "not a
  repo, unknown base" — and the caller treated that identically to a diff with
  zero changes. This repository's graph provenance named a commit on a branch
  that had been squash-merged and deleted, so the sha was not an object at all;
  sync diffed against a revision that does not exist and called the result
  clean. An unresolvable baseline is now named as such and counted as stale, on
  the principle that not knowing whether a derived layer matches the code is a
  reason to rebuild and never a reason to claim it does.

- **One filler word defeated intent matching.** `matchIntent` was a contiguous
  substring test in both directions, so "rebuild the graph" matched nothing while
  `rebuild graph` sat in the registry as a declared intent. Measured over 22 real
  phrasings recorded *before* the change — five returned nothing. A phrase now
  also matches when every one of its meaningful words appears in the query, with
  the substring rule kept alongside so that "nothing that matched before stops
  matching" is structurally true rather than believed. Result: 2 gained, 0 lost,
  20 unchanged, and two more fixed as data.

  `keryx commands --intent` now lists the closest commands by shared words when
  nothing matches outright. "обнови вики" names four commands at once and still
  matches none of them — picking one would choose a winner the query does not
  name — but the caller is no longer sent away empty-handed.

### Changed

- **The CLI-reference coverage guard is no longer verb-level.** Its own comment
  had said "a new `wiki <subcommand>` is not detected", and that limit then cost
  exactly what it predicted, twice. It now derives every router's dispatch and
  requires each routed subcommand to be named in its verb's reference section —
  five gaps across the whole CLI on the first run.

- **The code graph was rebuilt.** Its module map was missing about thirty source
  files, including the entire `src/wiki/freshness/` tree — the Living Wiki
  implementation shipped in the two previous releases. Anything asking the graph
  what a change affects had been answering from a file set two days and two
  releases behind.

### Added

- **A research note on where the wiki and graph work goes next**
  (`docs/requirements/keryx-wiki-graph-next/`). Its conclusion is that keryx sits
  inside three current external themes — repository-as-graph, freshness as a
  first-class signal, self-repairing documentation behind a human gate — and is
  absent from the fourth: measurement. This project measures review precision,
  detector false-negative rates, wiki drift and routing baselines, and has never
  tested the claim the rest rests on, that project-local context makes an agent
  better at a task.

## [0.2.79] — 2026-09-04

One commit. It removes the last reason `.mcp.json` could not be committed: the
absolute path of whoever ran the installer.

### Fixed

- **`keryx mcp serve` takes the project root from the runtime when no `--cwd` is
  given.** Resolution order is now explicit `--cwd`, then `CLAUDE_PROJECT_DIR`,
  then the process cwd. Nothing that worked before behaves differently; what
  changes is that a config carrying **no `--cwd` at all** now serves the right
  project, so there is no machine-specific string left to get wrong.

  The defect this closes: `keryx mcp install` writes the installing machine's
  absolute path. Committed, that file is correct on exactly one machine — this
  repository's copy carried a macOS path from 2026-08-13 and the server silently
  failed to start on Linux until 2026-09-02. 0.2.76 untracked the file, which
  fixed the symptom by making every developer re-run the installer.

  The documented cure — `${CLAUDE_PROJECT_DIR}` inside `args` — **does not
  work**, measured against Claude Code 2.1.220 with a wrapper that logged its own
  `argv`, `pwd` and environment before `exec`ing keryx. The bare form arrives
  verbatim and unexpanded; the `${VAR:-.}` form expands to its *fallback*. The
  same probe showed the way through: the variable is present and correct in the
  spawned server's **environment**. The runtime does hand over the project root,
  just not through argv.

  A blank variable is ignored rather than honoured — `path.resolve("")` is the
  process cwd, so honouring it would look identical to the fallback while
  claiming to be the runtime's answer.

  Evidence, and the control that kept it from being read wrong: `claude mcp get`
  reports `✔ Connected` for a server pointed at a nonexistent path, so the status
  line proves nothing about which root resolved. The discriminating observable is
  the tool count — variable unset, cwd this repository: **39 tools**; variable set
  to an empty directory: **0**.

  **Not changed:** the installer still writes `--cwd <absolute>`. Dropping it is
  only safe for a runtime that supplies the root in the environment, and only
  Claude Code has been measured. Cursor, opencode and VS Code are unmeasured and
  untouched.

### Added

- **An assessment of the Claude Code plugin system** as a possible fifth
  connection interface, in `docs/requirements/keryx-claude-plugin/`. Its
  conclusion is negative on the engineering case: everything a plugin would do
  technically is reachable without one, and it still cannot install the binary or
  create a workspace. The one argument that survives is distribution through the
  plugin marketplace, which is a product decision rather than a technical one.

  The document records its own strongest argument being wrong — it claimed only a
  plugin could make the MCP config machine-independent — and keeps the failed
  claim next to its refutation. It also notes that
  `keryx skills export --runtime plugin` emits `marketplace.json` inside
  `.claude-plugin/`, which makes `claude plugin validate` check the marketplace
  manifest and never look at the plugin manifest.

## [0.2.78] — 2026-09-05

One theme, arrived at from two directions: a generated document that says
something the code does not do is worse than no document, because an agent
believes it.

The code graph had a refresh command and a freshness signal, and neither
reached an agent. `.metaproject/index.md` said only "run module CLI commands
when generated data is stale"; the `AGENTS.md` / `CLAUDE.md` block routed
navigation to gdgraph and never mentioned rebuilding; `modules/gdgraph.md`
listed commands and data with no freshness contract at all. So an agent that
renamed three files and then asked what breaks got an answer from the previous
file set, with nothing in the answer to say so. Meanwhile the gdgraph skill
claimed the post-commit hook refreshed the graph; the hook only printed a
reminder.

The second direction is the same failure one level up. The gdwiki skill's
route to `keryx wiki freshness` — the thing that teaches an agent to check
whether a page still matches the code — existed only in the generated file,
not in the generator that overwrites it. Any `keryx update` deleted it, in
this repository and in every project that had installed it.

### Added

- **A freshness contract for the code graph** in `modules/gdgraph.md`: what
  invalidates it (files added, renamed, deleted or moved, and changed imports;
  an in-file edit invalidates only the opt-in symbol layer), how staleness is
  observed (`keryx gdgraph context`), how it is repaired, and the rule that a
  rebuild belongs before relying on an answer — not once per question.
- **Graph freshness routing** in the generated `index.md` (an Agent Workflow
  item and an Intent Router row) and in the `<!-- keryx:index -->` block of
  `AGENTS.md` / `CLAUDE.md`, so the rule reaches an agent without opening the
  index. Both disappear when gdgraph is disabled.

### Changed

- **The gdgraph post-commit hook rebuilds the graph** instead of printing a
  reminder, resolving `keryx` from `PATH` then `$HOME/.local/bin`. It never
  blocks a commit — every path exits 0, including a failed build — and
  `KERYX_GDGRAPH_HOOK_REBUILD=0` restores the old reminder. It is mutating by
  design: a project that versions `data/gdgraph/artifacts/` will find
  `summary.md` and `module-map.json` modified after a graph-relevant commit,
  which the hooks README and the lifecycle docs now state outright.

### Fixed

- **The gdwiki freshness route survives `keryx update`.** It now lives in
  `renderGdwikiSkillReadme()` rather than only in the generated
  `skills/gdwiki/SKILL.md`, with one test pinning the route in the generator
  and a second asserting the committed artifact equals the render — so a hand
  edit that the next update would erase fails loudly instead of silently.
- **`skills/gdgraph/SKILL.md` no longer claims a hook behaviour that does not
  exist**; its refresh policy describes the hook that is actually rendered.
- **`gdgraph.affected` states over MCP that it reads the built graph**, the
  caveat `gdgraph.cycles` and `gdgraph.orphans` already carried. It was the one
  blast-radius tool whose description read as if it saw the working tree.

### Documentation

- The CLI reference documents graph freshness under `gdgraph`, the freshness
  line `gdgraph context` prints, and what `--no-gdgraph-hook` now skips.
- The lifecycle page's hook table describes both post-commit hooks as they
  behave today: gdgraph rebuilds, and gdwiki appends to the freshness queue
  rather than printing the reminder it stopped printing in 0.2.77.

## [0.2.77] — 2026-09-04

Two threads. The larger one in line count is the wiki, which stops going
quietly out of date. The one more likely to matter to someone installing today
is smaller and came from other work in the same window: the curl-to-bash
installer verified nothing about what it downloaded, `.mcp.json` was tracked
carrying one machine's absolute path, and the built site never showed the
install command the release pipeline actually publishes.

The wiki stops going quietly out of date. Measured on this repository before
anything was built: 28 of 42 component pages had drifted, 530 commits in
total, and all 42 had last been touched in a single month — generated once,
never maintained, and nothing anywhere reported it. The cause was structural:
the wiki and the code graph were not connected, so *which pages does this
change affect* had no answer, and every mechanism that would need one had
nothing to stand on.

Four of the five designed phases shipped. The fifth is deliberately absent,
and that is the release's other half: over a 189-file range the drift was
100% machine-repairable and 0% prose, so the only phase that would spend
model tokens had nothing to work on. It stays specified and unbuilt until a
report says otherwise.

### Added

- **`keryx wiki freshness`** — a read-only, categorised backlog of the pages a
  change puts in doubt, with a reason chain on every entry and sorted by how
  far behind each page is. Exits 0 whatever it finds: a blocking freshness
  check invites updating a page so CI passes, which manufactures filler faster
  than drift manufactures staleness.
- **`keryx wiki refresh`** — regenerates the machine-owned
  `## Reference (from code graph)` block, including on `Status: accepted`
  pages, without touching a byte of human prose and without calling a model.
  A page already current is not rewritten at all; a hand-edited block is
  refused rather than overwritten.
- **`keryx wiki verify`** — records provenance. `--page` states that a page was
  reviewed; `--baseline` sets a measurement starting line and says in its own
  output that it is not a claim the pages were read. With neither it refuses,
  because stamping a corpus in one keystroke would assert reviews that did not
  happen.
- **`keryx wiki migrate-markers`** — one-off, idempotent, authors no content.
- **A `describes` layer in the code graph**, joining wiki pages to the files
  they document, traversable in both directions. It lives in its own storage
  files: five call sites treat every non-`asset` node as a source file, so a
  page node in `nodes.jsonl` would have corrupted the module set that orphan
  detection depends on.
- **Page provenance** — `VerifiedAt` (a git revision) and `VerifiedScope` (a
  content hash) live inside the page, so versioning does not depend on whether
  a project tracks `.metaproject/` or has git at all.
- **`wiki_freshness` over MCP**, read-only, and a `gdwiki` skill route telling
  a reader to check freshness *before* treating a page as context. The output
  leads with `limitations` unconditionally: an empty finding list with a
  non-empty limitations list means the check could not run, not that the wiki
  is fresh.
- **A freshness figure in `keryx health run`**, beside lint, types and tests.
  Health reads the last report and never recomputes. With no report the metric
  is absent *with a reason* — never a number, and never a flattering default.
  It cannot move the health gate, and that is enforced by the compiler rather
  than by a runtime check that could pass vacuously.
- **A CI workflow**: `wiki validate` gates on structural defects, `wiki
  freshness` reports and never fails the build.
- **`Describes: none  # why`** — a page can declare that it is not scoped to
  code (a map rendered from the graph, an ADR). The report counts that
  separately from a gap: "nobody has done this yet" and "this page is not
  about code" are different facts, and one of them is not work.
- **`keryx flow task depends`** — `flow check` reported three unsatisfiable
  `dependsOn` shapes (a dependency on a task that does not exist, a task
  depending on itself, a cycle) and none of them could be repaired: the field
  was written once at creation and nothing rewrote it, so the only remedy was
  editing `flow.json` by hand, which this project's own rules forbid. Flow 178
  sat with a self-dependent task for two weeks. The check was right every time
  and the operator had nowhere to go.
- **`keryx flow ac reseal`** — separates the checksum observation from its
  cause, so a mismatched acceptance-criteria seal reports *why* rather than
  only *that*.

### Fixed

- **Forty-eight test failures that only happened on macOS.** `mkdtemp` returns
  `/var/folders/...` while `process.cwd()` after `chdir` returns the resolved
  `/private/var/folders/...`, so anything keyed on the absolute project path
  wrote to one directory and read from another. Linux CI never saw it. The
  suite had been red locally and green in CI — the worst shape a suite can
  have, because a real regression hides in a red run everyone has learned to
  scroll past.
- **Two more of those** bound to `0177.0.0.1`, octal notation macOS refuses
  outright. Replaced with a form that preserves the test's intent exactly —
  still classified non-loopback, still resolved to loopback by the kernel.
- **A freshness report that asserted work already done.** Propagation knew
  nothing about when a page was verified, so pages stamped at the range's own
  end came back `must-refresh` with zero commits behind. Provenance now
  outranks propagation over a page's own scope.
- **Five tool descriptions** that stated the opposite of what their code does.
- **The installer verified nothing.** `scripts/install-binary.sh` — the
  curl-to-bash path documented for machines with no toolchain — downloaded a
  binary, checked only that the file was non-empty, then chmod'd and installed
  it. It now verifies what it downloaded.
- **Commands hidden from the usage banner** are listed again.
- **`.mcp.json` is no longer tracked.** `keryx mcp install` writes it with the
  ABSOLUTE path of the project on the machine that ran it. Committed, that is
  correct on exactly one machine and silently dead everywhere else — the MCP
  server never starts and nothing reports it. The tracked copy carried one
  developer's macOS path.
- **Fifteen bundled skills served `|` as their entire description**, and the
  sweep that exists to catch exactly that reported `frontmatter:description:
  pass` throughout. Fixes the parser, the four skills left with no routing
  signal at all, and the two blind spots that let it survive: a validator with
  its own shallow parse, and per-document checks that never compared a harness
  build against its `SKILL.md`.
- **Skills argued with their own previous versions in front of the model.**
  Five sites carried a diff against a prompt revision the model never saw; the
  worst stated a rule and then quoted its negation. Also makes the health tools
  admit staleness rather than presenting an old artifact as current.

### Changed

- The `unresolved-edges-present` limitation now carries its magnitude. "Coverage
  is partial" with no scale invites ignoring it forever or treating a rounding
  error as a blocker.

### Documentation

- **[Keep the wiki current](https://mrciphersmith.github.io/keryx/guides/keep-the-wiki-current/)**
  — how the machinery works, how to read the report, and what it deliberately
  does not do.
- Three status lines corrected against the code: `RP-13` was documented as
  planned while both halves were shipped and wired, and understating a
  delivered capability is the mirror image of overstating one.
- **One honest install story.** `npm install -g @mrciphersmith/keryx` — the
  path the release pipeline actually publishes, and the one `keryx version
  check` tells users to run — appeared on the built site **zero** times as an
  install instruction. Slate and SAC are now visible there too, with four
  guards that keep all of it true.
- **The Homebrew install is no longer advertised.** The tap exists and is
  public, but its formula pins `0.2.49`, carries literal
  `PLACEHOLDER_SHA256_*` strings where the digests belong, and has no
  `on_linux` block. It has never installed keryx for anyone, on any platform.

## [0.2.76] — 2026-09-03

Six commits since 0.2.75, and four of them are about one object: the ctx routing
guard. It refused the pipelines the routing rule itself demands, it could be
wedged by a stdin that never closed, it honoured its own escape marker inside
quotes, and it never watched the search tool a runtime provides natively. That is
the class the last three releases have circled — a mechanism asserting a
compliance it never observed — arriving this time in the thing that does the
enforcing.

### Added

- **Foreground operations in the TUI can be cancelled.** A single owner holds the
  one operation that may keep the interactive shell busy, with identity-safe
  tokens so an operation that settles late cannot clear the one that replaced it.
  Forcing a queued item interrupts the running main turn instead of waiting it
  out, and the cancellation is cooperative: the forced item does not start until
  the interrupted operation's finalizer has settled its own UI state. Destroying
  the renderer cancels and disposes rather than leaving the operation running.
  Wiki enrichment moved onto the same cancellation path instead of keeping a
  second one.

### Fixed

- **The ctx guard refused pipe filters.** Every stage of a pipeline was
  classified as though it named a file, so `npm test | grep -E 'Tests'`,
  `bun test 2>&1 | tail -5` and even `keryx ctx rg 'foo' | grep -c 'bar'` were
  blocked — routing a search exactly as the rule demands and then counting the
  results was refused. That is the failure mode that gets a hook uninstalled.
  Position was the wrong discriminator; a stage is now judged by whether it names
  a file. Three siblings found by a later round are closed with it: `sed`/`awk`
  take a script as their first operand, so an allowance given only to search-like
  commands moved the false-block class one command over; `-e`/`-f`/`--regexp`/
  `--file` supply the pattern, so the allowance absorbed the file instead and
  `grep -e foo file.ts` passed where it used to block; and a short-option regex
  could not match a long option, so `grep --recursive foo` walked the tree.

- **The guard never watched a runtime's own search tool.** The matcher was `Bash`
  alone and everything else failed open, so an agent using its harness's native
  search went unguarded while the Bash guard reported a clean run. Runtimes now
  declare `nativeSearchTools` and the matcher is derived from that declaration.
  `validate` had reported five under-covering shapes as clean, and its drift
  branch could not fire in production at all, because the installer merged before
  validating.

- **The escape marker was honoured inside quotes.** `grep -rn '#keryx:raw' src/`
  and `git log --grep='# keryx:raw'` both passed, so searching the guard's own
  source for its marker disabled the guard. It is now recognised only where a
  shell would start a comment. The asymmetry is what gave it away: the same file
  already knew that a `|` inside quotes is not a pipe.

- **`ctx hook` could be wedged by a stdin that never closes.** Measured still
  running at 14s, and once past 120s, where the equivalent read in `keryx orient`
  exited in 1202ms. For a PreToolUse gate that is worse than allowing — it wedges
  the tool call instead of failing open, the opposite of what its own header
  promises. `readStdinBounded` now lives in `src/lib` and both entry points use
  it. Cancelling the reader is load-bearing and not obvious: racing a timer
  resolves the race while the abandoned read keeps its own handle on the event
  loop, so the process writes its output and still never exits.

- **Guard ownership was decided in two places, and one of them was wrong.** A
  second hand-rolled walker still matched on `command` alone — exactly what the
  comment on the shared walker had predicted: "when a fourth settings shape
  arrives, one copy gets updated and the other keeps reporting the install
  clean". The fourth shape was already in the file. Every `validate` now routes
  through one walker, and flat-versus-nested is a per-runtime fact rather than
  either counting for everyone, which had let a flat-shaped group validate clean
  for a runtime that executes only nested ones.

- **A specialist skill claimed every review request in every language.**
  `review-frontend` carries the trigger "ui review"; the router drops tokens
  under three characters, reducing it to `["review"]`, and an all-words match
  over a one-element list matches any query containing "review". The specialist
  hijacked every review request, inverting `review-orchestrator`'s own contract.
  A trigger's dropped words are now matched too, against the query's raw words,
  which is where a short word like "ui", "db" or "pr" still exists.

- **The Context Pack described rules it had no carrier for.**
  `review-orchestrator` told reviewers to read `review_context.pr.body` and to
  record producers in `review_context.cross_repo`; `pr` was a bare object with no
  properties, and `cross_repo` was not declared at all, surviving on
  `additionalProperties: true`. Neither rule could be violated, which is not the
  same as neither being broken — a body never fetched and a body that was empty
  were one value. Both are typed now, `cross_repo` can describe a producer that
  has not merged, and findings carry `repo` in both schemas, since the registered
  contract is `additionalProperties: false` and would have rejected a finding
  that only the reviewer-side schema knew could carry one.

### Changed

- **The router has a baseline that records what it gets wrong.** Three earlier
  attempts each introduced regressions the round before them had introduced,
  because the corpus asserted only cases expected to work: every round could see
  its improvements and none could see its losses. `routing-baseline.ts` is
  written first — 25 entries, 10 marked `wrong` — and was green against the
  untouched scorer before a line of the scorer changed, so a scorer change either
  leaves that file alone or produces a diff someone has to justify. The result is
  10 of 10 wrong entries moved with zero `ok` entries lost. The first
  hand-written draft disagreed with reality in 10 of its 25 rows; it is generated
  by measurement now.

  The synonym table is a closed contract in the same spirit: each row states what
  a phrase must produce *and* must not, and writing that down immediately exposed
  three missing prefixed verb forms.

- **Ceiling, stated rather than papered over.** The guard's block decision still
  requires the first token to be in a fixed name list, so `sh -c`, `$(…)`, `eval`
  and `xargs` pass unclassified. This is a better nudge, not a boundary. The next
  step is not a larger parser but teaching the routing audit to distinguish
  classified-and-allowed from could-not-classify, so `ctx_used` stops asserting a
  compliance it never observed.

## [0.2.75] — 2026-09-01

A security patch. A full review of 0.2.74 — six reviewers over the release diff,
plus a mutation pass over every gate it added — found that **0.2.74 shipped two
security controls that did not control anything**, both in the same commit, the
one titled "remediate validated full-project review findings".

**Upgrade if you are on 0.2.74**, particularly if you use the SAC workspace
proposal flow or persist agent sessions to disk.

### Fixed

- **The security acknowledgement never happened.** `consumeConfirmToken` refuses
  a `needs-approval` proposal unless the confirm token records that a human
  acknowledged the security findings — and the only production minter passed
  that literal unconditionally, on every invocation. The gate could not fire,
  while the error text behind it promised "explicit human acknowledgement of the
  proposal security findings". A proposal whose evidence tripped the scanner was
  accepted through the ordinary two-step flow with the reviewer never shown, and
  never asked about, the finding.

  Before 0.2.74 the same call passed no flag at all, so a `needs-approval`
  proposal could not be accepted by any route — a dead end, which is why the
  literal was added. 0.2.74 replaced a visible refusal with a silent bypass, the
  worse of the two. `keryx workspace confirm-review` now reads the gate, prints
  what the scan found and in which evidence, and requires an explicit
  `--acknowledge-security`; a clean proposal claims no acknowledgement, and a
  proposal that cannot be read is refused rather than assumed to have passed.

- **Session-history redaction covered message content but not tool-call
  arguments.** `redactHistory` rewrote `content` and let the object spread carry
  `toolCalls` through untouched, while the writer serialises them verbatim into
  `context.jsonl`, `archive.jsonl` and the legacy `transcript.jsonl`. A
  credential the model read from one tool result and passed into the next call's
  arguments was written to disk in the clear, in three files — through the
  function whose own comment says a command that reads a credential must not leak
  the raw value.

- **A validation keyword declared but ignored, for the third time.** A contract
  registered in 0.2.74 declares `maxItems: 0` on the list of comments excluded by
  the prompt-injection screen when that screen never ran — the machine form of
  "you may not claim it excluded anything". The validator had no `maxItems`
  branch, so a record asserting both validated clean. `minItems` and `maximum`
  were the first two instances, each repaired by hand.

  Fixed as a class instead: a guard now refuses any shipped schema that declares
  a keyword the validator ignores, deriving the implemented set from the
  validator's own source rather than a hand-maintained list. It found two more on
  its first run — `exclusiveMinimum` on a dispatch budget (zero and negative
  validated clean) and `not`, the only way a schema expresses a prohibition,
  which was decorative: the branch accepted exactly what it forbade.

- **The routable-target guard sat on one write path of two.** Added in 0.2.74
  after two prose-target skills reached `main`, and wired into the automatic
  wrap-up path only. `keryx skills create` — the path agents are instructed to
  use — never called it, so the entry point most likely to be handed a sentence
  was the unguarded one.

- **`keryx ctx diff` reported "no risky files" for a file list it never had.**
  For an output shape carrying a file count but no per-file rows (`--shortstat`),
  the risk section printed `- none`, conflating "examined, nothing risky" with
  "files changed, none examined". The same false-clean class 0.2.74 fixed one
  section higher up.

- **A regex escape that escaped nothing.** The character class closed at its
  first `]`, so the expression matched essentially nothing. Latent — all current
  labels are metacharacter-free — but the next label added is the one that breaks
  it, silently.

### Changed

- **Four gates the release added had no test that noticed their removal**, and
  deleting both ledger-truncation checks made the suite **hang** rather than
  fail — a timeout reads as infrastructure trouble, not a defect. The four are
  now pinned, and the digest read loop is bounded by a computed chunk count so
  the same double removal can only produce a wrong digest, never a hang.

  Two truncation lines remain individually removable and are recorded as such:
  they are genuinely redundant, producing the same refusal for the same input,
  so no test can discriminate them.

## [0.2.74] — 2026-09-01

Twelve commits since 0.2.73, and the theme running through most of them is the
one 0.2.73 started: a mechanism that reports success without having done
anything is the mechanism that fails. Four of these were found by measuring a
claim rather than reading it.

### Added

- **`review-pr-feedback` 2.0.0 — the skill that reads other people's PR comments
  now checks them and can act on them.** It collects through
  `keryx review comments collect` instead of three hand-rolled `gh api` calls
  (which returned the first thirty comments and wrote no durable record), gives
  every comment a verdict against the code at the head SHA with the evidence
  that settled it, and plans by class rather than by comment — six comments
  about one shape become one plan item that fixes every site holding it.

  With `--fix` it executes that plan through `flow-orchestrator`: a branch cut
  from the reviewed PR's own head branch, a draft PR based on it, a review/fix
  loop to zero findings at `minor` or above, and a merge back into that branch.
  Anywhere else and the pull request the reviewer is reading never changes.
  Every comment then gets one short answer, in English, once, after the merge.

- **`keryx review reviewers`** — the reviewer set is asked for rather than
  recited. A project can define its own reviewers and, before this, nothing
  dispatched them: a team could write one, register it, and watch it never run.

- **`reviewer-skill-creator`** — a skill for writing project-local reviewers.

- **Three registered contracts** — `flow-orchestrator-input`,
  `review-pr-feedback-input`, `review-pr-feedback-output`. Registration is what
  lets a validator be pointed at a schema at all; before it,
  `keryx skills contracts validate --schema review-pr-feedback-input` exited
  with a usage banner. See *Known limitations* for what that is and is not.

### Fixed

- **The SAC ledger missed a same-size rewrite inside one filesystem timestamp
  tick.** `fastCheckpointState` trusted the checkpoint whenever identity matched
  and then verified only the tail record. Measured on one machine: an in-place
  same-size rewrite left both timestamps unchanged in **189 of 200 attempts**.
  Nanosecond field names do not imply nanosecond granularity.

- **Seven `planning/` skills declared a frontmatter `name` their directory
  lacked.** Two naming systems are live and disagreed — installation copies by
  directory, harnesses register by frontmatter name — so those skills installed
  and then failed to resolve when dispatched.

- **A skill's `target` was carrying prose**, and the registry promised skills
  that were neither present nor reachable.

- **The task scaffold stays, and is marked.** The four rows `flow init`
  generates were proposed for removal on the premise that flows replace them.
  Measured across all 206 packages the premise is false: zero have a task list
  without those rows, and 91.5% of scaffold rows reach `done`. The measurement
  is the deliverable.

- Full-project review remediation, and the historical unfinished-task debt cut
  from 59 to 9.

### Known limitations

- **A registered contract is not an enforced one.** Of eleven registered
  contracts, four refuse a bad value in production — `review-finding`
  (`src/review/managed.ts`), `subagent-dispatch` and `subagent-result` (the
  harness), and `job-orchestrator-state` (`src/job/store.ts`). The other seven,
  including the three added here, are refused only when an agent runs
  `keryx skills contracts validate` itself. The four that work do so because
  keryx sits on the path — it writes the file, or it spawns the child; a
  dispatch between two agents has no keryx in it. Tracked as flow 213.

- **`flow complete` does not ask where a merge landed.** The record carries no
  base branch. Its condition 3 compares the reviewed tree against the merged
  tree, which catches a wrong-target merge whenever the targets' content
  differs — the residual is the case where they have converged. Tracked as
  flow 214.

## [0.2.73] — 2026-08-31

A correction release. 0.2.72 completed the orchestrator-hardening roadmap; this
one fixes what measuring that work afterwards revealed — including two defects in
0.2.72 itself, one of them destructive.

**Upgrade if you are on 0.2.72.** It ships an instruction that can destroy
uncommitted work, and a command that reports a clean result for a tree it never
read.

### Fixed

- **`task-implementer` told every implementer to run `git reset --hard` on fatal
  failure.** `job-orchestrator` dispatches implementers in parallel waves that
  share one worktree, so an agent failing its third attempt would discard a
  wave-mate's uncommitted work — work it does not own, cannot restore, and cannot
  observe the loss of, because the other agent's failure surfaces elsewhere. It
  now restores only the files that task changed and refuses unscoped reverts. A
  guard sweeps every shipped document for unscoped `reset --hard`, `clean -fd`,
  `checkout -- .` and `restore .`, excusing lines that forbid them so the
  correction cannot fail on itself.

- **`keryx skills verify --bundled` reported `skills_evaluated: 0` from an
  installed copy.** The root resolved to `dist/bundled`; the tree ships at
  `src/gdskills/bundled`. It surfaced only because the sweep refuses to call an
  empty result clean — it printed `NOTHING WAS EVALUATED` instead of reporting a
  clean tree. A second guard now builds the package from `package.json`'s own
  `files` and `bin` lists and runs the real binary against it.

- **Build parity was enforced on one skill of thirty-seven.** A census found
  thirty-six diverging, and the divergence ran opposite to the assumption: the
  harness builds are stale *ancestors* of their own `SKILL.md`, and text that
  looked harness-specific was an old path the canonical file had already replaced.
  Seven hunks are genuinely deliberate and allow-listed with the reason; the rest
  are reconciled. Enrolment is now computed from the filesystem, because a
  hand-listed frontier is what produced a denominator disjoint from the defect.

- **Nine `SKILL.claude.md` files shipped in 0.2.72 that no runtime addresses.**
  Deleted, with a check against any future unaddressable build.

- **Four of five `task-implementer` builds omitted the reporting contract** while
  production code throws unless a child's first line is `STATUS: <TOKEN>`.

- **`cross_family_review` shipped with no consumer**, in the commit whose own
  criteria forbid fields nothing reads. `review ingest --cross-family-review`
  accepts it and `review status` reads it back in a later invocation, exiting
  non-zero on a self-contradictory record.

- **`dependsOn` and `attempts.count` were written and read by nothing.**
  `dependsOn` now drives `keryx flow next` and dependency validation — which
  immediately found a task in an older flow depending on itself. `attempts.count`
  is recorded when a task closes `failed` or `blocked`.

- **A dangling agent name lived in code, not only prose**: `agent: "code-review"`
  in `src/job/plans.ts` was writing an unresolvable label into every implement job
  on disk. A new guard fails the build on any skill naming an agent outside the
  catalogue, and immediately found `subagent_type: "general"` — a value no
  dispatcher accepts — in twelve files.

- **Loop detection could never fire**, for two independent reasons: finding
  identity was led by a per-round `global_id`, and a date-keyed review id let a
  second same-day round overwrite the first.

- **Both `task-implementer` contract schemas declared `minItems` and `maximum`
  while the validator silently ignored them.** Registering the schemas without
  implementing the keywords would have moved the defect up a layer rather than
  removing it.

### Changed

- `task-implementer` goes from 7 documented mechanisms reachable from production
  code to 55 of 109; its six-phase core from 2 of 54 to 20 of 54. Forty-eight
  claims wired, sixteen deleted, none softened. All four orchestrators have now
  been inventoried and hardened by the same method.

- Five places where a skill restated logic that already exists now call it:
  contract assertions, job document recording, the automation table, lint and
  type-check, and the test runner that already resolves the package manager the
  skill was reimplementing in shell.

## [0.2.72] — 2026-08-30

Phases 5 and 7 of the orchestrator-hardening programme, which completes it: all
seven phases are now delivered. The theme of both is the same one the programme
started with — a mechanism whose failure is silent is the one that fails — and
this release is mostly the result of going looking for those on purpose.

### Added

- **`keryx job`** — the job pipeline has a real implementation, built the way
  `keryx flow` is: a package on disk, a typed state file, an explicit transition
  map, atomic writes, an append-only journal. `init` / `status` / `step` /
  `document` / `complete` / `list`. It uses the `state.schema.json` that had
  shipped beside the skill since the first commit rather than inventing one, and
  registers it as a contract — which no command could validate before, because
  the contract installer carried a duplicate name list instead of deriving from
  the registry.

- **`keryx skills verify --bundled`** — the 65 skills that ship to every user are
  evaluated rather than assumed correct. Structural validation: frontmatter,
  resolvable cross-references, no concrete model name, no persona or
  home-directory path. It reports itself as *layer 1 of 3* rather than describing
  a pipeline that was not built.

- **`keryx review learn --pr <n>`** — a reviewer whose checklist is learned
  locally from pull-request comments by people the project names, configured per
  project. Learned content stays in that project; the apply path refuses any
  target outside `.metaproject/project-skills/`, so a misconfigured project
  cannot teach the shipped template.

- **`keryx providers cross-family`** — opt-in review by a different model family
  than authored the change, reading the existing provider configuration. It
  refuses to call a gateway or a local runner a "family", since fronting many
  vendors and being recorded as cross-family would corrupt the comparison the
  feature exists to enable.

- **`filter_stats`** in the round manifest, produced by the code that filters —
  the pre-filter, the verifier, the scope-B screen, the findings cap. Every count
  distinguishes **measured zero** from **not measured**, and `keryx review
  status` reads it back off disk in a later invocation and exits non-zero on a
  record that contradicts itself.

### Fixed

- **The review sections of `job-orchestrator` were two releases stale.** A pull
  request driven by it failed all five conditions of the completion gate shipped
  in 0.2.71. They now run the managed pipeline end to end.

- **Things that were documented and did not exist.** An audit of
  `job-orchestrator` inventoried 217 mechanisms and found six reachable from
  production code. Deleted or wired: `wave-executor` (the agent every
  implementation wave was dispatched as), `code-review` (the *default* review
  mode), `subagent_type: "general"` (41 occurrences; no dispatcher accepts it),
  three skill-load paths that stopped resolving when the tree was namespaced, and
  a step that outlived its own removal. Roughly 90 claims were wired to a real
  command and 45 deleted. None was softened — turning "is enforced" into "should
  be done" makes a sentence true while leaving the guarantee absent.

- **Claims that were impossible in this execution model**, deleted rather than
  reworded: a step defaulting "if no response in 60s", when no timer exists and a
  model cannot observe wall-clock passing while a user does not answer; and
  routing on time pressure with no clock and no persisted start.

- **27 defects in the shipped skill tree**, found by the new evaluator on its
  first run: a skill dispatching an agent that has never shipped, 25 unresolvable
  paths in nine forms including four contract schemas, and
  `.metaproject/scripts/detect-models.sh` — cited by two different orchestrators
  as the way to find a cheaper model, and never present in any tree.

- **The four non-Claude harness builds were dead content.** Export copied
  `SKILL.md` regardless of runtime — even for codex, with `SKILL.codex.md` beside
  it. They are now selected correctly and can be synced to their platforms by an
  explicit command, never as a side effect of `keryx update`. A new parity guard
  caught three sections that had existed only in the Claude build since the
  bootstrap commit while all five declared the same version.

- **The learning loop had never produced anything.**
  `.metaproject/memory/review-notes/` did not exist and the note type had never
  been written. Notes are now written when a finding is dismissed as incorrect —
  and only that dismissal counts as model error, because the other three are
  correct findings nobody acted on and conflating them poisons the signal.

- **The reviewer profile no longer describes a person.** It shipped one
  individual's conventions and speech markers in a public repository. Keryx now
  ships the mechanism; the conventions live in the projects that hold them.

## [0.2.71] — 2026-08-30

Phase 4 of the orchestrator-hardening programme: a pull request is now reviewed
for what it can **break**, not only for what it changed; a flow cannot close over
an unresolved finding; reviewers on the pull request get an answer; and a
dispatch is sized to the work instead of every dispatch paying flagship prices.

This release was itself produced through the loop it adds — five review rounds
over its own pull request, twenty-four findings, every one verified against a
named commit before being called fixed. Two of the four fix rounds introduced a
defect that the next round caught, which is the strongest evidence available that
the rounds are doing something.

### Added

- **A second review scope: the blast radius.** `keryx review blast-radius`
  computes what a change can break from `gdgraph affected` over the changed
  files, ranked by edge distance and bounded at depth 2 / 40 files — both
  measured over 80 commits, not guessed. Every file the cap drops is named in the
  round manifest and on the terminal, because a silent truncation reads as "we
  checked everything". A finding raised under this scope that is not a regression
  is rejected **in code**: it must anchor inside the computed set, clear a
  severity floor, and name the change it breaks.

- **A `review` gate on `flow complete`.** It passes only when a managed review
  record exists with at least one readable ingested round, every finding carries
  a terminal disposition, the round ran against the commit that is merging, no
  external comment is unanswered, and the verifier ran with its stats recorded.
  "Clean" is defined positively, per finding: `acted-on` needs a commit SHA and a
  verifier verdict against it, a dismissal needs one of four taxonomy reasons
  **and** a recorded human decision. A finding that simply stops appearing in a
  later round is not cleared — absence never reads as a fix.

- **External pull-request comments are collected and answered.** All three
  GitHub sources — inline review comments, review submissions, PR-level
  discussion — with bot authors handled identically to humans. Collected every
  round, answered **once at the end**, at most two sentences and 600 characters,
  threaded, and never resolved by us: replying is ours, resolving is the
  reviewer's call. A comment cannot be refuted by the verifier alone; a human
  asked a question, and a machine deciding the question was invalid is not an
  answer.

- **`keryx review tier` — adaptive model selection, computed rather than
  chosen.** Skills declare a tier (`light`/`standard`/`deep`), never a model
  name; a skill naming a concrete model fails a test. The tier is assigned
  deterministically from signals the orchestrator already holds — scope, attempt
  count, finding count, diff size, verification method, security in scope — and
  never by asking a model to rate its own difficulty. It resolves against
  whatever the provider reports **at runtime**, placing the tiers relative to the
  session's own model. No model id is written anywhere in the codebase: what is
  hard-coded is a list of sixteen *size words*, which makes no claim about which
  models exist and cannot go stale when a vendor ships a new one. An environment
  that cannot be ranked inherits the session model — never a downgrade, never a
  dispatch failure.

### Fixed

- **A squash merge can now be verified.** The completion gate asked whether the
  reviewed commit is reachable from the merge, which a squash destroys by
  construction — so on the merge strategy this project actually uses, the check
  could never pass. It now compares the two commits' **trees**: equal trees prove
  the reviewed bytes are the bytes that merged, which is a stronger claim than
  ancestry. Every non-answer — missing object, shallow clone, `rev-parse`
  failure, git absent — is `unobserved`, never `pass`.

- **`flow complete` told three different situations apart.** "The comment
  collection is stale", "the tracker is unreachable" and "nobody has commented"
  were all reported as one status with advice that fitted only one of them.
  Collection now records the commit it ran against, and a record that cannot be
  shown current never reads as fresh.

- **Reply length is bounded by characters as well as sentences.** A single
  4,000-character sentence satisfied a two-sentence budget and was posted whole.

- **Four mechanisms documented as enforcement had no caller.** `buildTierMap`,
  `assignTier`, `decideDispatchModel` and `screenBlastRadiusFindings` were
  reachable only from their own tests while a skill, a schema and a rule all
  stated they ran. Each is wired at its stated seam, and each wire is pinned by a
  test that goes red when the wire is cut.

- **`parseModelTier` returned inherited `Object.prototype` keys**, so
  `model_tier: constructor` passed the guard that exists to reject it and then
  resolved as a silent downgrade.

- An external comment's dedupe key is stable across rounds by design, so an
  unanswered comment read as a reviewer stuck in a loop and `review loop` exited
  non-zero from round 2 naming the commenter.

- A sentence-final abbreviation (`etc.`, `i.e.`, `vs.`) swallowed the stop that
  ended its sentence, under-counting a reply in the direction that lets a long
  one through. The mask no longer depends on which regex engine reads it.

## [0.2.70] — 2026-08-29

### Fixed

- **`keryx flow complete` now gates on tasks — it never did, despite saying so.**
  `flow-orchestrator/SKILL.md` told readers that an unrun verification step
  keeps a flow open "instead of being quietly dropped". `complete()` ran four
  gates and the task gate was not among them: `taskGateStatus()` was written,
  tested, and carried a comment saying it was deliberately unwired. Measured
  across 184 completed packages, **34 unfinished tasks in 24 flows shipped
  behind that sentence, 24 of them the review step itself.**

  The gate is **opt-in by creation** (`gates.tasks`, written by `flow init`), so
  historical packages are not retroactively invalidated; a package without the
  field reports the gate as `skipped` rather than silently passing it. A
  `skipped` task passes only with a recorded reason, a `blocked` task does not
  pass at all, and an unrecognised disposition fails rather than falling through
  — `--disposition` is now parsed instead of cast, so a typo can no longer reach
  disk and close a task.

- **A review round can now seed the next one.** A fix round requires
  `prior_findings[].finding` to conform to a schema with five required fields
  and `additionalProperties: false`; the artifact a round wrote had none of them
  and carried four forbidden ones, so round 2 could not be constructed from
  round 1's own output. Findings now travel as structured data rather than being
  re-parsed out of prose, with the Markdown path kept for existing reports.

- **Attempt counts persist.** `attempts.count` was declared and never
  incremented. New `keryx flow task attempt <id> <Tn> --outcome
  started|failed|blocked` records it, and the orchestrator reads it from flow
  state instead of from its own context — which matters because 27% of flows run
  longer than eight hours and cross session boundaries.

- **`--greptile` is gone** (it routed to a skill that exists nowhere), the
  frontend-conventions reviewer no longer fires on every `.ts` file in a
  repository with no frontend, and the review orchestrator no longer prompts
  about legacy profiles on every run.

- **The subagent status protocol documented four statuses while the schema
  carried five.** That made `FAILED` look unreachable; it is reachable from the
  harness child layer and load-bearing there. The protocol now documents all
  five and names which worker family emits the fifth. A guard test asserts every
  bundled rule stays byte-identical to its installed copy — this correction was
  first written to the generated copy alone, where the next `keryx update` would
  have reverted it.

### Added

- **`keryx sandbox status`** — the OS sandbox launcher's availability and a
  per-capability containment matrix, distinguishing "requires a launcher you
  have not installed" from "not implemented on this platform at all". A report,
  not a gate: it always exits 0.

- **`keryx flow task attempt`** — see above.

- **`docs/requirements/keryx-orchestrator-hardening/`** — the benchmark that
  produced the fixes above, and the plan for what follows: review precision, one
  canonical severity rubric, deep review rounds bounded by a computed blast
  radius, completion gated on a clean final round, external PR comments answered
  once at the end, and adaptive model selection by tier.

- **A dynamic import is no longer counted as a load-order edge in gdgraph**, so a
  module that lazily imports something which statically imports it back is no
  longer reported as a cycle.

- **The approval menu no longer offers a prefix grant the grant itself would
  refuse.** It validated the derived pattern rather than the command, so "always
  allow" could be offered for a command a stored grant would then decline.

### Changed

- **Brevity in the agent's system instruction governs prose length only.** It
  was paired with "be economical with output tokens", which reads as a budget on
  tool calls too — and a benchmark caught the agent reporting a result from one
  call because verifying it felt like spending. A tool result that is itself the
  deliverable is now checked against source before being presented as fact.

## [0.2.69] — 2026-08-28

### Fixed

- **The sidebar outgrew a 24-row terminal and hid half of itself.** The
  balance/usage panels added in 0.2.62 pushed the fixed-height sidebar stack
  to 31 rows against the ~24 a standard terminal gives, so `Tools`, `Status`,
  the sub-agent and background-job boxes and the pinned toast fell off the
  bottom of the screen. CI's macOS pty leg caught this on the introducing
  commit and had been red on every push since 2026-08-23; it was a real
  regression, not a flaky job.

- **`security` and `ctx` wrote their data wherever the process started.** Both
  built `.metaproject/data/…` from `cwd` instead of resolving the project
  root, so running either from a subdirectory created a stray `.metaproject/`
  there — twelve had accumulated in this repository. For `security` the litter
  was the lesser half: the per-project HMAC key that keeps finding hashes
  unguessable was regenerated per working directory, the self-protection state
  used to detect a mode downgrade started empty on every subdirectory run, and
  `isSecurityEnabled()` returned false from a subdirectory, so every write
  seam silently skipped its check.

### Changed

- **The `Balance`, `Workspace` and `Review` sidebar rows are hidden when they
  have nothing to show**, rather than occupying rows with a placeholder. This
  is what reclaims the space above; `/workspace` and `/review` are unaffected.

## [0.2.68] — 2026-08-26

### Added

- **Custom file-backed LLM providers.** Operator-defined OpenAI-compatible
  providers can now be registered in `~/.local/share/keryx/llm-providers.json`,
  merged into the built-in provider list. The TUI `/provider` wizard offers a
  new "add custom provider" entry (name → URL → key → models) that persists to
  the file. Custom names colliding with a built-in provider are excluded.

### Security

- Custom file-backed providers get a narrow, opt-in SSRF allowance: a new
  `isPrivateLanHost()` predicate (RFC1918 + CGNAT ranges) paired with
  `grant.allowPrivateLan`, granted only to custom providers as an explicit
  operator-trust boundary. Loopback still requires `allowLoopback` separately;
  link-local metadata addresses (`169.254.x`) stay denied regardless. Built-in
  providers never receive the LAN grant.

## [0.2.67] — 2026-08-24

### Added

- **A suggested next step after every settled turn** (Claude-style): when the
  main agent finishes and the queue is empty, a short model-generated follow-up
  appears in the composer placeholder. Tab / Right-arrow inserts it without
  submitting; Enter on the empty composer submits it directly; typing dismisses
  it. Fail-closed: no credential, a timeout, or a `.` reply shows nothing and
  never blocks the shell.

- **`keryx workspace dismiss-candidate <evidence-path|session-id>`** — UNBOUND
  candidates (wrap-up ran with no workspace bound) can now be dismissed instead
  of lingering in `catch-up` / `/review` forever: the artifact is removed and a
  `*-unbound-dismissed.json` receipt is written, after which both the internal
  and external-slate readers skip it.

### Fixed

- **`/theme` switch did not repaint already-rendered chrome.** Only the
  chrome's own surfaces were recolored; transcript frames, tone block headers,
  dock buttons and sidebar panels kept the old palette's hexes, so dark-to-dark
  switches looked like the theme never applied. The tree is now walked with
  theme-color remapping (OpenTUI stores colors as RGBA objects).

## [0.2.66] — 2026-08-24

### Fixed

- **A typed message in front of a paste vanished from the transcript, leaving
  only `[pasted N lines]`.** The composer's submit echo collapsed ANY
  multi-line input into that bare placeholder, so typing a question and then
  pasting a block after it discarded your own words entirely — the transcript
  looked like you'd said nothing. It now keeps your own first line and
  summarizes only the rest as a paste count (`explain this [+ 12 pasted
  lines]`). The logic was also duplicated between the chat and agent shells;
  it is now one shared function.

- **Fenced code blocks in a reply had no way to copy them.** `y`/`/copy` only
  ever reached the block-nav registry (thought/tool/output blocks) — a fence
  embedded in the reply text had no registry entry of its own, so there was no
  copy path at all. Both now fall back to the most recently rendered code
  block when nothing is registered to copy, and the block's header advertises
  the shortcut (`python · 15 lines · y copy`).

### Added

- **Code blocks get lightweight local syntax highlighting.** Comments,
  strings, numbers and keywords are colorized via a plain-string tokenizer —
  no tree-sitter worker, no network or grammar fetch, so it stays inside flow
  109's worker-free, no-egress rendering stance (D-2).

### Known gaps

- **A paste can occasionally split** — part of it lands in the transcript as
  a sent message, the rest stays stuck in the input. This traces to an open
  upstream bug in `@opentui/core`'s `StdinParser`
  ([anomalyco/opentui#1270](https://github.com/anomalyco/opentui/issues/1270),
  unterminated bracketed paste), present in both the installed `0.4.5` and the
  latest `0.5.7` — not fixable from here until it lands upstream.

## [0.2.65] — 2026-08-23

### Fixed

- **`/game`'s modal no longer scrolls as a whole and the board is never
  clipped.** The 0.2.64 prompt card used `flexGrow: 1` on a ScrollBox with no
  height cap, which made OpenTUI measure the card at the full parent height —
  the card ballooned to the whole modal body, pushed the stats/footer out of
  view and gave the modal a body-wide scrollbar that also clipped the bottom
  of the board. The agent panel now reserves a fixed slice (status + stats
  lines), the board is sized from the modal body HEIGHT (cell heights 2..5:
  tiny/small/medium/large), and the prompt card is a bounded minmax-style
  block (5..14 rows) that scrolls only inside itself. Board + panel now sum
  exactly to the body height, so everything is on screen at once on any
  terminal of ~30 rows or more.

- **The agent panel now shows what the model actually receives and with what
  parameters.** The prompt card shows the system prompt AND the per-turn user
  prompt (the exact board state sent each turn, so you can see how the model
  learned your move); the status card shows the provider/model in effect
  (`auto/auto` until the first turn) and the compact last-turn/session stats
  (latency, in/out tokens, reasoning/fallback/error flags, fallback/error
  counts) on three lines instead of two tall cards.

- **Modal tab bodies got a stale 68x13 viewport instead of the real one.** At
  mount time OpenTUI's `width`/`height` getters still return the last LAYOUT
  value (the 72x18 creation-time floor), so `renderTab`'s context claimed the
  panel body was 68x13 even on a normal terminal — the /game board was sized
  from that floor. The host now computes the body size deterministically from
  the renderer (`resolveModalPanelSize`), matching the panel's actual resolved
  size at open.

## [0.2.64] — 2026-08-23

### Fixed

- **`/game`'s system-prompt card is no longer capped at 6 lines.** The agent
  panel truncated the prompt the model sees to 6 lines plus "… (N more)" and
  left dead space below it. The card now renders the full prompt, flexes to
  absorb the leftover body height, and scrolls (wheel, scrollbar, or
  j/k/↑/↓ once the scrollbar has focus) when the prompt is taller than the
  space the layout leaves it.

## [0.2.63] — 2026-08-23

### Changed

- **`/game`'s agent panel is now real cards with a stats table.** The system
  prompt, last-turn latency/tokens and session totals were one undifferentiated
  dim line; they are now three bordered cards — a status line ("agent is
  thinking…" / notice / "waiting for your move"), the system prompt wrapped as
  lines (capped at 6 + "… (N more)"), and a side-by-side last-turn/session table
  (model, first byte, total, in/out tokens, reasoning/fallback/error flags;
  turns, fallbacks, errors, token totals), with long provider/model ids
  truncated so a half-width card never clips. Footer hints now say
  `arrows move` / `tab games`.

### Fixed

- **`/game`'s left/right arrows stopped moving the cursor again.** The
  multi-tab games-host split (0.2.62) dropped the `onArrowKeys` claim the
  legacy single-game modal keeps, so the modal host's own tab switch consumed
  both arrows and `stopPropagation`'d them before the game saw them — the
  cursor moved up/down but not sideways, and with one game the tab switch was
  a silent no-op. The games host now claims both arrows for the active game
  through the host's `onArrowKeys` hook again (a pure probe; the game's own
  keypress handler still applies the move, so each press moves once) and only
  falls back to tab switching when the game declines the key.

## [0.2.62] — 2026-08-23

### Added

- **`/game` is now a multi-tab games host with an agent-stats panel.**
  The single tic-tac-toe modal became a component-based games module
  (`src/tui/games/`): one `GameDefinition` contract (rules, prompts, render,
  input) plus a registry, so adding a game is adding one definition — its tab
  appears automatically on the shared modal host, with `←`/`→` switching
  games. Tic-tac-toe itself is split into `core`/`prompts`/`layout`/`render`/
  `input`/`game`. Under the board sits the new agent panel (dim/secondary):
  the exact system prompt the model sees each turn, plus per-turn
  latency/token stats — provider/model, time-to-first-byte, total time,
  input/output tokens, reasoning flag, local-fallback count, errors. `runModelTurn`
  now surfaces `usage`/`latencyMs`/`reasoning` from the stream so any caller
  can show what an agent turn actually costs.
- **`/game <seconds>` raises the model-turn deadline; the default went from
  12s to 60s.** Local models are slow, and the stats panel's point is to
  observe that latency, not to race it. `/game 45` sets a 45-second deadline
  for that modal.

### Fixed

- **The sidebar now shows provider balance and session usage.** A new
  `Balance` row under Model fetches the ACTIVE provider's balance live
  (DeepSeek `GET /user/balance`, OpenRouter `GET /api/v1/credits` — the only
  registry providers with public balance APIs; the rest render `—`), on
  mount and again on click, honouring `KERYX_<NAME>_BASE_URL` overrides. A
  new `Usage` row shows the cumulative in/out token totals for the session,
  fed from the same `io.onUsage` stream that drives the header counter.
  Both are wired into the agent and chat shells.

## [0.2.61] — 2026-08-23

### Fixed

- **Web search returned empty results on bun-in-`~/.bun` installs.** The
  bwrap profile for the sandboxed web worker masked `$HOME` entirely
  (`--tmpfs`), hiding `process.execPath` itself when bun lives under home.
  The worker could not start and the search bridge silently returned empty
  results. The profile now masks only home's secret subdirectories via
  `defaultReadDenyList`, leaving the runtime readable.

## [0.2.60] — 2026-08-23

### Fixed

- **`/game`'s cursor would not move left or right.** `modal-host` claims both
  arrows for its own tab switch and calls `stopPropagation()`, so the game's
  keypress listener only ever saw up/down. The cursor now moves through the
  host's `onArrowKeys` hook, and left/right are removed from the keypress
  handler — that hook returns without stopping propagation, so handling them
  in both places would move the cursor two cells per press.

- **The board is sized from the modal body width**: 9×5 cells where the 33
  columns they need fit, the previous 5×3 where they do not.

- **A model turn could hang the game indefinitely.** There was no deadline on
  the provider call, so a stalled request left "agent is thinking…" on screen
  with `R` as the only way out. The turn now has a 12s deadline; on timeout —
  or on a reply that names no free cell — the game plays a local move (win,
  block, centre, corner) and says so, instead of silently passing the turn
  back and letting the user win against nobody. A hard error (no credential,
  provider failure) still hands the turn back with the reason. `runModelTurn`
  takes no abort signal, so a timed-out request is abandoned, not cancelled.

- **The model turn's output budget was 16 tokens.** On a reasoning-capable
  model that budget covers the thinking pass, so the answer digit could be
  truncated away before it was ever emitted — the turn then looked like a slow
  model that skipped. Raised to 256; the visible reply is still one character.

- The status line read "Your turn — O" while the agent was thinking. It now
  reads "Agent's turn — O".

## [0.2.59] — 2026-08-23

### Fixed

- **`/game` drew its board as one 9-cell vertical column instead of a 3×3
  grid.** The board was a single `flexDirection: "column"` box holding nine
  bare text nodes — with no row boxes between the board and the cells, flex
  put every cell on its own line. The tree is now built once in `renderTab`
  as three row boxes of three bordered cell boxes, and `paint()` only
  mutates the retained cell handles instead of clearing and re-adding all
  nine nodes on every keypress. The cursor is a real highlight (focus border
  + highlight fill) rather than a swapped glyph, the winning line takes the
  winner's colour, and legend/board/status are centred.

- **A model error during the game's turn was never visible.**
  `applyModelMove` wrote the message straight onto the status node and the
  `paint()` immediately after overwrote it. The message now goes through a
  `notice` state that `paint()` owns and renders on its own line — the same
  line that carries "agent is thinking…".

## [0.2.58] — 2026-08-23

### Added

- **`/game` — tic-tac-toe vs the model in a TUI modal.** A pure game core
  plus a model move via an injectable, fail-closed provider factory; state
  lives in the modal's own closure so `Esc` minimizes without resetting and
  reopening `/game` resumes the same board. Available while the main agent
  is busy, registered alongside the other agent-only slash commands.

### Fixed

- **The interactive agent's runaway-tool-loop guard counted unique
  tool-call signatures, conflating a big legitimate task with an actual
  loop.** A task with many DIFFERENT tool calls (e.g. a wide refactor) was
  indistinguishable, under that metric, from real repetition, and hit the
  same budget wall either way. Replaced the three unique-signature pools
  (`DEFAULT_MAX_TOOL_CALLS`/`_READ_`/`_NON_READ_`) with a model-round-trip
  cap (`DEFAULT_MAX_ROUNDS`, `KERYX_AGENT_MAX_ROUNDS`); the existing
  per-signature attempt cap (`MAX_ATTEMPTS_PER_HASH`) remains the actual
  repetition guard. `spawn_subagent` and wiki deep-enrich child budgets
  migrated the same way.

- **Untrusted web content could permanently block an unrelated tool call
  turns later in the same session.** Once any `web_fetch`/`web_search`
  result came back untrusted, every later non-read tool call was refused
  for the rest of the session, with no way back short of `/new`/`/clear` —
  including actions that had nothing to do with the tainted content. The
  gate is now scoped to the turn the untrusted content appeared in: it
  still blocks every later round within that same turn, but a following
  user turn starts clean.

- **External Slate-Adjacent Context (SAC) hands could get a workspace
  auto-created for them at close.** Flow 200's lazy resolve-or-create in
  `runWrapUp` now excludes external slates entirely — a hand that never
  bound a `workspaceId` gets the unbound-candidate artifact, never a
  created workspace. Internal session/flow wrap-ups keep the lazy resolve
  (AC-38, flow 182).

## [0.2.57] — 2026-08-22

### Added

- **Lazy SAC workspace binding.** A session no longer auto-resolves-or-creates
  a workspace from its first message (which produced junk workspaces like
  "git pull --rebase" before the session's real topic was known). A session
  now opens with no workspace bound; the agent decides via
  `workspace_list`/`workspace_create`/`workspace_propose` when a workspace is
  actually warranted, `workspace_create` binds the created workspace to the
  session's slate, and `runWrapUp` resolves-or-creates a workspace **from the
  session's Seeds** (the real topic) when the slate is unbound at close time,
  then proposes per kind-group. A failed resolve still degrades to the
  unbound-candidate artifact.

- **Explicit agent seed-writing instruction.** `buildAgentSystemInstruction`
  now teaches the model when to write a `slate_write_seed` (root cause found,
  code changed, decision taken, risk identified), which `kind` to use, the
  2-3 sentence length, and that one-shot operational requests need no Seeds —
  making wrap-up's proposal pipeline actually fed, since Seeds are its only
  input.

### Fixed

- **`/review` Accept/Decline were a plain text hint, not buttons.** On the
  Detail tab of a proposal, `[a] Accept this proposal [d] Decline this
  proposal` rendered as text: mouse clicks did nothing and there was no
  arrow-key navigation. They are now real clickable buttons (same style as
  the main-queue buttons) with a two-step keyboard flow: `←`/`→` (or `a`/`d`)
  move the highlight, Enter arms, Enter/`y` confirms. A new
  `modal-host` `onArrowKeys` hook lets the tab body claim the arrows, and a
  stale-node write into destroyed `TextBuffer`s on tab switch was fixed.

## [0.2.56] — 2026-08-22

Fixes every finding from the 0.2.55 live-testing campaign
(`docs/verification/` on the `real-test-keryx` branch): 118 real test cases
run against a live shell, live DeepSeek traffic, and a live MCP server,
covering the full `/goal`, Slate, SAC, permission-mode, and slash-command
surface. This release closes the six flows that came out of it.

### Fixed

- **A stored `keryx *` shell-permission grant silently auto-approved every
  future `keryx` subcommand forever, including destructive ones.**
  `validateShellPattern` refused bare `<verb> *` wildcards for known
  destructive verbs but never covered the harness's own binary. The binary
  name is now resolved dynamically and added to that same guard; any
  pre-existing bare wildcard already loaded from `permissions.json` is now
  flagged the same way `rejected`/`tampered` patterns already are.
  ([#390](https://github.com/MrCipherSmith/keryx/issues/390))

- **Mutating `keryx` CLI subcommands could bypass SAC review entirely.**
  `keryx wiki enrich` could land `Status: accepted` content with zero SAC
  proposal, once its `shell_exec` call was approved. It can no longer set a
  page's `Status` at all — it always re-asserts whatever the page's Status
  was before the run, regardless of flags or what the model itself returns.
  `keryx workspace catch-up` also gained a standing backstop: it now flags
  any SAC-owned path (wiki/memory/skill) that changed with no matching
  review receipt, as its own distinct category.
  ([#391](https://github.com/MrCipherSmith/keryx/issues/391))

- **`/goal --auto`'s independent verifier pass was silent, evidence-blind,
  and its "one more round" safety net was unreachable.** Three related
  reliability gaps in the T10 verifier (SLATE-27), all fixed together:
  the verifier's dispatch and verdict are now recorded in the visible
  transcript on every outcome — achieved, not achieved, or unavailable —
  instead of only the disagreement case; the verifier is now handed the
  run's actual evidence (recent Slate Seeds and `workspace_propose` records)
  instead of just the bare goal text; and the round loop can now exit early
  on a real, deterministic "this round is done" signal, so the verifier is
  reached with round budget still available instead of always exhausting it.
  ([#389](https://github.com/MrCipherSmith/keryx/issues/389),
  [#392](https://github.com/MrCipherSmith/keryx/issues/392),
  [#394](https://github.com/MrCipherSmith/keryx/issues/394))

- **`/theme` was advertised by `/help` in agent-mode readline but had no
  dispatch branch there**, falling through to "Unknown command: /theme."
  right after `/help` listed it. It now dispatches to a working
  readline-mode theme picker.
  ([#393](https://github.com/MrCipherSmith/keryx/issues/393))

- **`keryx workspace catch-up` never scanned `.keryx/external-slates/`**, so
  a closed, never-bound external MCP Slate genuinely persisted on disk but
  never surfaced as `unbound-candidate` the way `slate.md` documents. It now
  scans that store too.
  ([#395](https://github.com/MrCipherSmith/keryx/issues/395))

- **`/mode auto`'s auto-approval line lacked test coverage that the
  `[destructive]` audit tag actually reaches it** for a genuinely
  destructive command — the rendering itself was already correct.

- **A headless/piped `keryx shell` process ignored `SIGINT`**, only exiting
  on `SIGTERM` — consistent with an interactive "press again to confirm
  exit" trap a non-TTY process can never satisfy. A single `SIGINT` now
  exits immediately when stdin is not a TTY; interactive behavior is
  unchanged.

## [0.2.55] — 2026-08-21

### Fixed

- **`keryx shell`: a parallel-tool-call turn could stall the session with a
  provider 400 and no further reply.** `runAgentTurnCore`'s per-tool-call
  loop pushed the SLATE-2a Anchors-block (and the repeated-failure hint)
  into history mid-loop, splicing a `role:"user"` message between two
  `tool` results that answer the SAME assistant `tool_calls` batch. Several
  OpenAI-compatible providers (observed: DeepSeek) reject that shape
  outright with `"An assistant message with 'tool_calls' must be followed
  by tool messages responding to each 'tool_call_id'"` — the batch's own
  `tool_calls` never got a next reply, and every following turn replayed
  the same broken history. Both injections are now deferred and pushed
  once, only after every call in the batch has its `tool` result recorded.
  Root-caused from a real local session transcript that reproduced the
  exact interleaving and the exact provider error.

## [0.2.54] — 2026-08-21

### Fixed

- **`slate.*` MCP tools (SLATE-22..26, shipped in 0.2.53) were unreachable
  over MCP on every project, including keryx's own.** They were registered
  tagged `module: "slate"`, but neither `MODULE_MANIFEST_KEY` nor the
  default `expose.modules` allowlist had an entry for it, so
  `isModuleExposed("slate")` silently returned `false` everywhere — with no
  `keryx modules enable` toggle to work around it. Fixed at the source
  (`src/mcp/discovery.ts`, `src/mcp/client-config.ts`) so every future
  `keryx init`/`mcp install` writes a working manifest; this repo's own
  already-generated manifest is patched the same way. Live-verified against
  the real MCP SDK: `tools/list` now returns all three tools. A standing
  regression test drives discovery against keryx's own committed manifest
  and fails if any registered tool ever resolves to unexposed again — this
  exact bug class was already found and fixed once before this feature
  shipped it a second time.

## [0.2.53] — 2026-08-21

### Added

- **`/goal --auto [N]`: bounded autonomous continuation (SLATE-27).**
  `/goal` was strictly one-shot: it opened the Slate, bound a SAC workspace,
  ran exactly one turn, and stopped — whether the goal was actually achieved
  was left entirely to the model's own narrative. `--auto` (default 8
  rounds, or an explicit cap) now re-drives the turn in a bounded loop,
  auto-provisioning a Task Manager flow as the durable "is this done" record
  when none is bound, and — before the final stop — dispatches one
  independent `spawn_subagent` verifier call that checks the claimed outcome
  against the repository instead of trusting the model's own "I'm done."
  On a rejected verdict with rounds remaining, it reopens for exactly one
  more round. The armed round budget lives only on the in-memory session
  object, never in `slate.json`, so a forked or resumed session never
  silently inherits an unattended loop. Guide: `docs/docs/guides/goal.md`.
  Drawn from a 13-competitor survey of comparable mechanisms in other
  coding-agent CLIs — `docs/requirements/goal-continuation/`.
- **Slate v3: private MCP slate lifecycle for external hands (SLATE-22..26).**
  Three new MCP tools — `slate.open`/`slate.writeSeed`/`slate.close` — let
  any MCP-connected external harness (Claude Code, Codex, or anything else
  that speaks MCP) keep its own task-local working memory the way keryx's
  own runtime already does for itself, and dispatch it into the same SAC
  propose/review pipeline on completion. Each hand's slate is scoped to
  `(cwd, externalSessionId)` and structurally never reachable through a
  different id; every Seed it writes carries a server-set
  `origin`/`trust: "external-unverified"` a reviewer can see. Local
  stdio/in-process only — refused over HTTP. Guide: `docs/docs/guides/slate.md`.

### Fixed

- **TUI: the Tools/MCP modal's MCP tab was showing chat providers, not MCP
  servers.** It listed the connect status of keryx's own outbound MCP
  client registrations (Cursor/Claude/opencode/VS Code) but never the
  actual MCP servers each of those clients has configured — context7,
  Playwright, keryx-mcp itself. The tab now also surfaces each connected
  client's other configured servers, with a caption clarifying what's shown.
- **TUI: the `/`-command dropdown had no way to receive a required
  argument.** Enter was the only way to act on a highlighted command, and
  it submits immediately — commands like `/goal <text>` or `/delegate
  <agent> <task>` had no way to get their argument from the dropdown at
  all. **Tab** now accepts the highlighted command into the composer
  (`<name> `) and hands the keyboard back instead of running it, so typing
  the rest of the line just continues; Enter still runs a no-arg command
  immediately as before. Along the way, fixed a related bug where the
  dropdown's own filter `.trim()`'d the composer query, so a value ending
  in a genuine trailing space still equalled the bare command name and kept
  reopening the dropdown.

## [0.2.52] — 2026-08-21

### Added

- **VS Code/Cursor extension: one-command local install.** `bun run
  install:vscode` / `bun run install:cursor` package (`vsce package`) and
  install the extension in a single command, replacing the manual
  `npx`-per-iteration sequence every prior verification round required. Adds
  `@vscode/vsce` as a devDependency. README documents both, plus the
  GUI-launched-editor PATH gotcha (an nvm-managed `keryx` resolves from a
  terminal but not from a Dock/Spotlight-launched editor, since GUI
  processes don't source shell profiles) and its fix.

### Fixed

- **TUI: the Tools/MCP inspector modal is now actually usable.** It shipped
  in 0.2.51 rendering as a small, mouse-dead box: the shared modal host
  capped every modal at a fixed 96x28 regardless of terminal size, and the
  Tools/MCP rows were one joined-text block, so a click could never land on
  a specific row's connect/disconnect action. The modal now sizes to 95% of
  the terminal, and every row is a real, independently clickable element —
  click a row to arm connect/disconnect, click it again to confirm, mirroring
  the existing `[c]`/`[d]`-then-`[y]` keyboard gate exactly. Keyboard nav is
  unchanged.

## [0.2.51] — 2026-08-21

### Added

- **TUI: `Tools` in the sidebar is now clickable** (and reachable via `/mcp`),
  opening a two-tab inspector modal. The **Tools** tab lists every tool the
  agent currently has access to (name, risk, description). The **MCP** tab
  lists every registered MCP client runtime (Cursor, Claude Code, opencode,
  VS Code, generic) with its live connect status and a `[c]`/`[d]`-then-`[y]`
  connect/disconnect action, wired to the existing `keryx mcp install`/
  `uninstall` — no new install mechanism. Kept deliberately separate from the
  LLM chat-provider picker (`/search-provider`): those are OpenAI-compatible
  API endpoints, unrelated to the Model Context Protocol, and were being
  conflated in an earlier design discussion this closes out correctly.
- **TUI: `/review` gains a decline action.** Previously only accept was
  reachable from the modal (reject/dismiss required a terminal command).
  `[d]`-then-`[y]` now declines a proposal in-modal, symmetric to accept.
  `[a]`/`[d]` on a non-proposal item (blocked/unbound-candidate/unknown) now
  say the action doesn't apply here instead of silently doing nothing.

### Fixed

- **MCP: `skills_catalog`/`skill_load` are now actually reachable over MCP.**
  Both operations were registered and unit-tested since 0.2.50, but a stale
  `expose.modules` allowlist (in the default `keryx init`/`mcp install`
  template, and in this project's own manifest) filtered them out of every
  real `tools/list` response. Verified live: 34 tools before the fix, 36
  after, with `skills_catalog` returning real catalog data end-to-end.
- **`keryx harness run --provider`** now recognizes `openai`/`gemini`,
  matching `keryx shell --provider`/`/search-provider`, which already
  supported both. Fails closed with a clear message when the matching API
  key is unset, mirroring the existing `anthropic` behavior.
- **SAC: accepted proposals now render as `accepted`, not `draft`.**
  `wiki`/`memory`-owner-writers only ever persist a page after a reviewer
  accepts it, but both hardcoded `Status: draft` on the rendered page —
  producing a self-contradicting record that `wiki enrich`'s default batch
  then kept silently regenerating forever. The Reviews modal's Detail tab
  was also structurally unable to show what was proposed (kind/author/date/
  note); it now surfaces all of them, sourced from the real proposal record
  and its propose-time note.
- **VS Code extension: activates eagerly and its tree views are now
  clickable.** Previously the extension only activated once a user manually
  opened the Keryx sidebar, so the status bar never appeared on a fresh
  window; `Projects`/`Recent Turns`/`Needs Your Attention` were inert text
  lists. Also closed real packaging gaps found by actually building and
  installing the `.vsix` (missing activity-bar icon, no `.vscodeignore` —
  packaging was shipping this subproject's own local-only `.metaproject/`
  including a gitignored-but-unexcluded security key, no `repository`/
  `LICENSE`, no CI coverage).

## [0.2.50] — 2026-08-21

### Added

- **VS Code extension** (`vscode-extension/`). A visual layer over keryx
  inside the editor: activation checks `keryx status` and, if the workspace
  isn't initialized (or is incomplete), prompts before running
  `keryx init --yes` — never silently. A status bar item polls
  `keryx status`/`health status`/`security status` and names the specific
  failing check on click, not just a color change. A sidebar (Keryx icon in
  the activity bar) shows four views: Status, Projects, Recent Turns, and
  Needs Your Attention (in-progress flows merged with pending SAC
  proposals). An output channel streams live turn events over SSE
  (resumable) and logs one line per mutating action. A hover provider shows
  `keryx wiki ask` snippets for symbols under the cursor, cached and
  debounced. Reachable via `keryx mcp install --runtime vscode`, which
  writes `.vscode/mcp.json` in the new VS Code-native shape (`servers` key,
  `"type": "stdio"` per entry) so VS Code's own MCP client / Copilot Chat
  agent mode can also call keryx's tools directly. See
  `vscode-extension/README.md`.
- **Standalone binaries + Homebrew tap.** `keryx` now ships as 4
  self-contained compiled binaries (darwin-arm64/x64, linux-x64/arm64),
  attached to every GitHub Release — no bun/git/node required to install
  or run. `scripts/install-binary.sh` fetches and installs the binary for
  the current platform in one line. A Homebrew tap
  (`MrCipherSmith/homebrew-keryx`) was published alongside it and described
  here as available — **it never was**, and this line is corrected in place
  rather than deleted, because the claim shipped. The tap's formula pins
  `0.2.49` and carries literal `PLACEHOLDER_SHA256_*` strings where the
  digests belong, so `brew install` fails the checksum comparison on every
  platform; it also has no `on_linux` block at all. The formula itself said so
  in a comment, and so did
  `docs/requirements/keryx-native-distribution/README.md` — the honest note
  sat where a maintainer looks while this entry announced the feature where a
  user looks. See
  [`docs/requirements/keryx-docs-remediation/`](docs/requirements/keryx-docs-remediation/README.md).
  Fixed two real bugs
  found while verifying this: `web-tree-sitter` was silently falling back
  to the deterministic parser in every compiled binary (now a real parse,
  scoped fix to `gdgraph.treesitter`), and cross-platform compiles were
  failing because `@opentui/core`'s native package only installs for the
  build machine's own OS/arch by default.
- **Native OpenAI and Gemini provider adapters.** `--provider openai`
  (needs `OPENAI_API_KEY`) now targets OpenAI's Responses API directly,
  and `--provider gemini` (needs `GEMINI_API_KEY`, falling back to
  `GOOGLE_API_KEY`) targets Gemini's `generateContent`/
  `streamGenerateContent` API — both alongside the existing Anthropic
  adapter and the 9 already-shipped OpenAI-Chat-Completions-compatible
  providers (OpenRouter, DeepSeek, Z.AI, Cerebras, Groq, Moonshot, Grok,
  ...), whose shared engine was extracted out of `OllamaProvider` into its
  own module with no behavior change. Both new adapters fail closed to the
  offline fake provider when their key is absent, exactly like the
  existing Anthropic adapter — never constructed without a real
  credential.
- **MCP client: `codex-cli` elicitation handling.** A new stdio MCP client
  (`src/mcp-client/`) lets keryx correctly answer `codex mcp-server`'s
  approval prompts (`elicitation/create`) when running Codex as an
  external agent, instead of the request going unanswered. This is a
  prerequisite for the external-agent-runtime's deferred-write path; the
  existing default `codex exec` production path is unchanged, and
  `claude-cli` is unaffected.
- **`skills_catalog`/`skill_load` metaproject operations.** Two new
  operations (reachable as agent tool calls, through the Tool Registry,
  and as MCP tools) let an agent discover and read `.metaproject/skills/`
  content programmatically: `skills_catalog` walks the skill tree and
  returns a structured listing (with a one-line summary derived from each
  skill's frontmatter, or its body when frontmatter has none);
  `skill_load` reads one specific skill by the catalog-discovered path
  only.
- **TUI: `/search-provider` and `/search-connect` now open interactive
  pickers when given no arguments**, instead of printing a static text
  list. `/search-provider` opens a 3-step wizard (select provider → enter
  fields/credential/active-toggle → test connection); `/search-connect`
  opens a single-step picker over already-configured providers. Both
  forms with an explicit id (`/search-provider <id> field=value...`,
  `/search-connect <id>`) are unchanged.

## [0.2.49] — 2026-08-20

### Added

- **External agent runtime: delegate bounded, read-only work to `codex exec`
  and `claude -p` as child agents.** keryx can now run the vendors' own
  coding CLIs — Codex and Claude Code — as children of the existing harness,
  so the operator's own subscription does the work while keryx keeps
  isolation, budget, supervision, and completion. keryx never reads a
  vendor credential store, not even to check whether the operator is
  logged in — availability has three states (`installed`/`not installed`/
  `login not verified`), and the CLI states the limit rather than hiding it
  behind a tick. No vendor sanction is claimed; this is mitigated
  structurally — off by default, opt-in, local-only, and hard disabled
  under remote transports and CI. What ships: a registry of two agents with
  one pure, offline-tested codec each; a `runtime` block on
  `subagent-dispatch` with a fail-closed validator; read-only execution in
  a disposable git worktree with a stripped environment and restricted
  tool roster; an opt-in capability gate; `keryx agents external list|probe`;
  `/delegate <agent> <task>` with a live transcript (Work/Meta/Command
  tabs), a sidebar marker, and a per-addressee message queue where `force`
  is kill-plus-resume; a structured-result validator so a schema-invalid
  response is reported as a named error rather than silently accepted as
  free text; five supervision triggers (`phase_changed`, `budget_threshold`,
  `no_progress`, `agent_asked`, `scope_drift`) computed live from the event
  stream, including a background timer for the two conditions that must
  fire during total silence; and a pure bridge feeding external-agent
  events through the existing internal-agent monitoring fold, unmodified.
  Mutating external agents is explicitly not shipped — the permission axis
  exists in the contract, but `worktree-write` is refused at runtime with a
  reason distinct from "this agent cannot." See
  `docs/requirements/keryx-external-agent-runtime/`.

### Fixed

- **Agent: the tool-call loop now survives into the provider request.** A
  turn consisting purely of a tool call previously wrote nothing to
  history, and every OpenAI-compatible provider (DeepSeek, OpenRouter,
  Z.AI, Groq, Cerebras, Moonshot) degraded `role:"tool"` results into a
  plain user message with no `tool_call_id` — the model was asked to
  continue a transcript in which it had never called a tool. Both adapters
  now send the real `assistant(tool_calls) → tool(result)` shape their
  APIs document; calls survive session persistence and compaction, with a
  pairing linker that degrades safely to the old framed-text behaviour for
  any half-paired call a cut or an intercepted turn can produce, rather
  than sending a request either API would reject outright.
- **Security: dated flow-directory names are no longer masked as phone
  numbers.** `NNN-YYYY-MM-DD-<slug>` flow package names satisfied every
  `pii.phone` heuristic, so `ls .metaproject/flows` reached agents fully
  redacted and no flow directory could be opened. A phone candidate
  carrying a real calendar date is now recognized as a dated identifier
  and left alone; a real phone number with no valid month/day pair is
  still masked.
- **Security: a credential's own JSON key name no longer blocks masking its
  value.** `"ZAI_API_KEY": "…"`-shaped assignments were missed by the
  secrets detector because the closing quote after the key name stopped
  the match before the colon — this is exactly how keryx persists provider
  keys in `auth.json`, so reading the credential store published every key
  whose value carried no separately-recognized prefix. The key name may
  now be quoted; only values are masked. Also hardened: a dotted composite
  credential (`<hex>.<alnum>`) no longer masks only its first segment, and
  a bare 24+ character hex blob next to a sensitive label is now judged on
  its actual entropy rather than always passing.
- **Agent: the toolless-reprompt budget raised from 1 to 2**, with a
  strictly stronger second nudge and an early stop on a verbatim repeat —
  a model that narrates a step once typically narrated it once more when
  nudged under the old budget, ending the turn unexecuted.
- **TUI: the main-queue marker now shows an item's own position**, not how
  many items are still queued behind it — `q1 (1)`, `q2 (2)`, `q3 (3)` for
  a 3-item queue, instead of the previous `q1 (2)`, `q2 (1)`, `q3 (0)`.
- **TUI: `/mode` (permission-mode switching) now works while the main agent
  turn is busy**, and a mid-turn switch — e.g. to `auto` — applies
  immediately to the turn's next tool call, since the approval gate
  already re-reads the mode fresh on every call. All three forms (explicit
  mode, `clear`, the no-argument picker) are unblocked; the one-time
  confirmation before switching to `auto` is unchanged.

## [0.2.48] — 2026-08-19

### Added

- **SAC: durable wrap-up dispatch outcome recording for the Review UI.**
  `runWrapUp` already computed rich per-group outcome data on every wrap-up
  dispatch attempt (proposed / conflict / unbound-candidate / no-credential /
  error with a message), but both real callers discarded the return value
  entirely, only catching a rare thrown exception. A session whose wrap-up
  dispatch genuinely failed was indistinguishable in the TUI's Review
  section from a session that never reached a wrap-up trigger at all — both
  collapsed into the same opaque "unknown" catch-up item with a generic
  message. `runWrapUp` now persists a best-effort durable artifact under the
  session's `slate-archive/` on every dispatch attempt, success or failure;
  the Review detail view surfaces the real trigger, timestamp, and per-group
  failure reason when one is recorded, and is unchanged when it isn't. No
  changes needed to the trigger call sites — both already call `runWrapUp`
  at all three trigger points. See
  `docs/requirements/keryx-sac-wrapup-dispatch-outcome/`.

## [0.2.47] — 2026-08-19

### Added

- **`apply_patch`: write-risk file edits via unified diff (ADR-0010).**
  Extends the interactive agent's approval gate to a real `risk: "write"`
  path (previously hard-denied unconditionally), backed by a patch-risk
  escalation classifier (delete/`.git`/many-files/credential-path). Takes a
  standard multi-file unified diff, confined to the project root, applied
  via a constrained argv-only `git apply` subprocess — patch over stdin,
  never shell-interpolated. One call can edit several files, collapsing N
  `shell_exec`-per-edit calls into a single non-read budget slot. The
  write-risk approval prompt now renders the actual diff (line-classified,
  colored) instead of raw JSON tool input, in both the readline shell and
  the TUI. See `docs/requirements/structured-file-edit-tools/`.
- **Background shell jobs: `shell_exec` gains `background: true`.** Starts a
  detached, process-group-owned job and returns immediately instead of
  blocking the turn on the synchronous path's timeout. Two new `risk: "read"`
  tools, `shell_job_output`/`shell_job_kill`, poll and stop it later, scoped
  strictly to the calling session's own job registry — reuses the existing
  shell approval gate and OS-sandbox setup unchanged. A new TUI "Background
  Jobs" sidebar panel mirrors the existing Subagent Inspector: clickable rows
  open a live-updating Output/Meta modal. Every job is swept
  (SIGTERM→SIGKILL by process group) on real session exit but deliberately
  survives `/clear`/`/new` — a background job is meant to outlive the turn
  that started it. See `.metaproject/wiki/architecture/background-jobs.md`
  (flow 173).
- **Non-read tool-call budget raised 8 → 32, with a "raise and continue"
  option instead of an unconditional stop.** The loop-safety budget shared
  across `shell_exec`/write/destructive/network/delegate calls was small
  enough that routine edit-plus-verify work exhausted it; hitting the limit
  now offers a picker to raise it and continue instead of forcing a wrap-up.
  Adds `flow_status` as a proper `risk: "read"` tool so checking flow
  progress no longer needs `shell_exec`.

### Fixed

- **The agent could stall mid-task on a narrated-but-unexecuted step.** A
  short continuation nudge like "проверяй"/"делай" wasn't recognized as an
  action request, so the built-in toolless-reprompt safety net never engaged
  when the model announced a next step ("Проверю ...:") without calling its
  tool — the turn just ended, silently waiting for the user to nudge it
  again. Broadened the action-request/claimed-action detection (plus a
  same-reply narrate-then-act instruction in the system prompt) so the model
  keeps working instead of stopping on a claim.

## [0.2.46] — 2026-08-19

### Added

- **TUI: unblock `/think`, `/expand`, `/copy`, `/workspace`, `/review` while
  the main agent turn is busy.** `runLine`'s busy branch previously handled
  only 6 of 24 slash commands (`/exit`, `/help`, `/interrupt`, `/queue`,
  `/status`, `/flows`) while a main turn was in progress; every other command
  was refused with a generic "main is busy — command deferred" message, even
  ones that were already provably safe — the `Ctrl+O` block-nav keyboard path
  that does the same thing as `/expand`/`/think`/`/copy` has never had a busy
  gate at all, and `/workspace`/`/review` are read-only modals structurally
  identical to the already-allowed `/status`/`/flows`. These five commands now
  work while busy, reusing exactly the functions the idle path already calls.
- **TUI: `runLine`'s busy-branch dispatch decision extracted into a pure,
  unit-tested `classifyBusyDispatch` function** (`src/tui/busy-dispatch.ts`),
  closing a gap where none of `runLine`'s 24 commands (busy or idle) had any
  test coverage. `runLine`'s busy branch is now a thin `switch` over the
  classifier's result; 13 unit tests cover every dispatch target directly,
  without mounting a renderer. See
  `docs/requirements/keryx-tui-busy-command-allowlist/` (flow 172).

## [0.2.45] — 2026-08-18

### Added

- **Concurrent `spawn_subagent` waves + structured completion status.**
  Sibling `spawn_subagent` calls issued in one interactive turn now run
  concurrently (bounded by a new `maxSubagentConcurrency`, default 3) instead
  of strictly sequentially, by wiring the already-existing `planWaves`
  scheduler to a new `executeWaves` executor. Non-`spawn_subagent` tool calls
  in the same batch, and result ordering back to the model, are unaffected. A
  spawned child's result now also carries a structured completion status
  (`Completed | BudgetExhausted | Timeout | Denied | Error | NoProgress`),
  closing a gap where a child that exhausted its own internal step budget
  returned `isError:false` — indistinguishable from a clean finish — with no
  change to the existing `{output, isError}` shape callers already rely on.
  Grounded in a live bug report plus a three-project reference study (xAI Grok
  Build, OpenAI Codex CLI, sst/opencode). See
  `docs/requirements/keryx-multi-agent-engine/` (Phase D).

## [0.2.44] — 2026-08-18

### Added

- **TUI: `/review` sidebar badge + list/detail modal for the SAC catch-up
  report.** A new "Review" sidebar row surfaces every item across the project
  needing human attention — pending proposals, sessions that stopped
  unattended, unbound wrap-up candidates, and sessions with no recorded
  resolution (SLATE-10's `keryx workspace catch-up`, whole-project scope,
  never limited to the current session's own workspace) — turning yellow
  once nonzero, refreshed at the same points the Workspace row already uses
  (session open/resume, `/new`, main turn settled). Clicking it or typing
  `/review` opens a list+detail modal (arrows/`[`/`]`/Enter to navigate,
  same interaction model as `/flows`/`/workspace`). Accepting a proposal is
  an `[a]`-then-`[y]` confirm inside the Detail tab that runs `keryx
  workspace confirm-review` then `keryx workspace review --decision
  accepted` as two real shell commands — never through the model/tool-calling
  loop — so the human keying the confirm is the same human-presence proof a
  terminal invocation would be.

### Security

- **Permission modes: SAC's `confirm-review`/`review` commands are a hard
  floor no mode lifts.** `trust`/`auto` could previously auto-approve `keryx
  workspace confirm-review` and `keryx workspace review` — the commands that
  mint and spend the confirm-token proving a human accepted a proposal
  (SLATE-20) — closing a self-approval gap the same shape as the existing
  `credentials` hard floor. Also hardened the independent
  `isShellCommandAllowed`/`validateShellPattern` barrier so a hand-edited
  `permissions.json` entry for either command can never auto-approve or be
  remembered.

## [0.2.43] — 2026-08-18

### Added

- **TUI: main queue moves off-transcript into its own dock.** `keryx shell`'s
  main message queue (queue while the agent is busy, flow 167) no longer
  renders as `> qN (p)` markers interleaved in the transcript — it's now a
  persistent panel above the composer, positioned so it stays visible
  alongside the existing approval-gate/wiki-enrich choice dock rather than
  competing with it. Each queued item gets clickable **Force** / **Edit** /
  **Delete** buttons, plus a `Ctrl+Q` keyboard-only path (arrow keys select
  item/action, Enter fires, Esc exits). The existing `/queue remove|edit|force
  [N]` text command keeps working unchanged.
- **TUI: region click-to-focus + launch autofocus.** Clicking the
  transcript/output area or empty space now focuses the composer; clicking
  the queue dock enters queue-nav (a click on one of its buttons still fires
  that action directly, not just focus). The composer is focused
  automatically the moment the shell finishes launching, so typing can start
  immediately. Clicking the sidebar is an intentional no-op — it has no
  focusable content today, so literally focusing it would blur the composer
  into a keyboard dead-zone.
- **TUI: workspace sidebar row + `/workspace` inspector modal.** The sidebar
  now shows the current session's bound SAC workspace (title · status · slate
  count), refreshed after session open/resume, after `/new`, and after every
  main turn settles; empty (`—`) until one is bound. Clicking it opens a new
  `/workspace` inspector with 3 tabs — Workspace (overview), Slates (every
  session bound to this workspace, newest-first, same interaction model as
  `/flows`), Slate (detail: touched files, seeds).
- **TUI: translucent modal backdrop.** The full-screen backdrop behind
  `/flows` and every other modal was 100% opaque; now translucent via the
  fill color's own alpha channel (never the `opacity` prop, which would have
  faded the panel's own content along with it). The panel itself stays fully
  opaque.

## [0.2.42] — 2026-08-18

### Added

- **Session permission modes: `ask` / `trust` / `auto`.** `keryx shell` gains
  a session-level layer over the existing approval gate — `--permission-mode
  <ask|trust|auto>` / `--ask`/`--trust`/`--auto`, and a `/mode` command
  (show/switch/`save`/`clear`) in both the OpenTUI shell and the `--no-tui`
  readline REPL. `trust` auto-approves everything except a destructive
  command (tool-declared or classifier-detected); `auto` auto-approves
  everything except a credentials-touching command, which no mode ever
  bypasses, and requires an explicit one-time confirmation to enter. A
  per-project default persists to `permission-mode.json` next to
  `auth.json`/`projects.json` in the shared keryx config directory, opt-in
  via `/mode <mode> save`. Every silent auto-approval still prints a
  non-dimmed transcript line. Deliberately out of scope: `harness run`/
  `harness exec`/`keryx serve` and the MCP server keep the existing
  policy-profile engine untouched — "headless never silently allows" is
  unaffected. See the
  [permission modes guide](docs/docs/guides/permission-modes.md).
- **`keryx init`: one-question install shortcut.** Interactive `init` now
  opens with *"Install everything with recommended defaults?"* (default Y).
  Answering yes enables all 9 modules with their recommended settings and
  skips every per-module question that follows — equivalent to `--yes`.
  Answering no falls through to the existing per-module questions, unchanged.
  An explicit `--no-<module>` flag still wins either way.
- **Optional RLM-style recursive enrichment for `wiki enrich`.** A
  classification gate (skip/light/deep) can run ahead of each page's model
  call — light-tier batches sibling pages of the same module; deep-tier
  spawns a bounded, unattended child turn with a filtered read-only tool
  subset (never `shell_exec`/`spawn_subagent`, so it cannot recurse).
  Per-page staleness is now also tracked independently via content-hash
  resume state. Off by default — `.metaproject/wiki.config.json`'s
  `rlm.enabled: false`, matching an absent config file, and the disabled
  path is byte-for-byte identical to the pre-existing worker. Kept off in
  this project's own dogfood config for now: live comparison (local Ollama
  8B and DeepSeek) showed high variance on the weak local model and no clear
  quality win on a capable one, pending real classification-threshold tuning
  data.

## [0.2.41] — 2026-08-18

### Added

- **Slate v2 — autonomous SAC workspace binding (SLATE-16..21).** An agent now
  resolves-or-creates its own SAC workspace by judgment on an action-intent
  turn — the same tool-calling judgment `ask_user`/`spawn_subagent` already
  use, no new similarity/embedding engine — and re-evaluates that binding
  mid-session if the topic shifts. On task completion it dispatches a wrap-up
  proposal autonomously (machine-composed evidence: git diff, Flow snapshot,
  tagged Seeds). Review/accept stays strictly human: a `decision: "accepted"`
  review now requires a `confirmToken`, minted only by `keryx workspace
  confirm-review <workspace-id> <proposal-id>` run in a real, approval-gated
  shell — no tool call, MCP or `keryx-shell`, can mint one itself. Workspace
  `list`/`create`/`show` are now available with identical shape from both
  `keryx-shell` tools and MCP (`workspace_list`, `workspace_create`,
  `workspace_show`) — previously CLI/`keryx-shell`-only.
- **Decision dedup/conflict hint at review time.** Accepting a wiki-update or
  memory-entry proposal now computes a `DedupHint` (duplicates/conflicts
  against already-accepted entries, reusing `src/memory/dedup.ts`'s existing
  scoring unchanged) and, when the hint is non-empty, an optional bounded
  model-judge annotation — informational only, never consulted by any
  accept/reject/merge code path. Computed *after* the decision, never gating
  it; a computation failure (timeout, read error) degrades to an absent hint,
  never a blocked or crashed review. `sac.review` (MCP) and `keryx workspace
  review` (CLI) return the identical shape.
- **Lifecycle flag for orphaned SAC content.** `keryx workspace catch-up`
  gains a fifth, additive section (`--include-lifecycle-flags`, shown by
  default) surfacing every workspace, memory entry, and wiki decision page
  whose recorded module no longer resolves in the code graph — reusing the
  exact graph-diff signal that already drives `wikiPruneOrphans`. Report-only:
  it never archives a workspace, edits a memory entry, or removes a wiki page
  on its own; a workspace can appear here and in the pending-proposals section
  at the same time without either suppressing the other.
- **TUI: queue input while the agent is busy.** Submitting a normal message
  while the main agent is busy now opens a selector — **Main queue**
  (default) or **Side-1** (the existing read-only worker, outside main
  history). A queued main message appears in the transcript as `qN (p)` and
  drains FIFO right after the current turn completes. Each queued item can be
  `remove`d (dropped without running), `edit`ed (returned to the composer,
  pulled from the queue until re-submitted), or `force`d (aborts the current
  turn and runs immediately as a new priority turn).
- **Shell-command approvals are mouse-clickable.** The Allow/Deny-style option
  list (shell approval, the wiki-enrich plan picker, `ask_user`) is a
  scrollable, clickable list instead of keyboard-only.

### Changed

- **`/flows` sorts newest-first; Detail scrolls; the modal grows toward
  96×28.** The flow list now orders by highest id, then `updatedAt`. On the
  Detail tab, `↑`/`↓` scroll the body instead of changing the selection —
  `[`/`]` (or `p`/`n`) switch between flows instead; the List tab still uses
  `↑`/`↓` to move the selection. The shared modal panel (`/status`, `/flows`,
  `/theme`) now grows toward a 96×28 target from the live terminal size
  (floor 72×18) instead of a fixed 72×18 box.
- `/status` and `/flows` are now allowed while the main agent is busy
  (previously blocked like any other input).
- A subagent's tool-call budget was a whole-session-lifetime pool that only
  reset on `/model` switch; it now resets per parent turn, with a larger
  default pool and higher per-child limits.
- Tool/error block headers used a fixed bright red/cyan instead of the active
  theme's palette; they are now theme-driven, matching `/theme`.

### Fixed

- The TUI subagent sidebar never cleared finished entries — not on
  `/clear`/`/new`, not at the start of a fresh turn — so subagents from
  earlier turns piled up indefinitely; it now clears at both points.
- A shell-command approval's command preview was hard-truncated at 120
  characters regardless of available box space; it now shows in full (8,000
  character cap) in a scrollable box, with `ctrl+o` toggling focus into it for
  arrow/PageUp/PageDown scrolling.

## [0.2.40] — 2026-08-17

### Added

- **Switchable TUI color themes (`/theme`).** `/theme` with no argument opens
  a picker modal — a theme list on the left, a live preview (assistant
  markdown, a code block, tool/side/chip/ok/error samples) on the right.
  Arrow keys move the highlight and repaint the preview instantly; the
  palette only applies on Enter or `[ Apply ]` — Esc/close leaves the
  current theme untouched. `/theme <name>` still applies immediately on any
  surface.

### Changed

- **Shared modal panel is opaque and near-fullscreen.** The `/status`,
  `/flows`, and `/theme` host used to be a translucent 72×18 box that leaked
  the transcript behind it and clipped long content; it now fills the
  available terminal space with a scrollable body.
- `/clear` and `/new` now fully reset the visible transcript (messages,
  blocks, fleet rows, token counters), not just the underlying session.

### Fixed

- **Ctrl+O focused blocks scroll into view.** `↑`/`↓` navigation didn't
  reveal the highlighted block if it was off-screen; it does now.
- A toast now fires once when transcript retention drops an old payload,
  instead of the loss only being discoverable via expand/copy.
- Side-worker replies render in a framed box with a `── side-1 ──` label
  instead of a bare, easy-to-miss magenta line.
- A modal-open theme-change listener could accumulate across renderer
  create/destroy cycles (relaunching the TUI shell within one process, or
  running its own test suite) and kept writing onto already-destroyed
  panels; it is now unregistered on teardown, alongside two related listener
  leaks in the chat and agent TUI shells.
- A keyboard-focus edge case let a stray digit `1`–`9` keypress jump modal
  tabs while the scrollable body itself held focus, instead of being
  absorbed by the scroll box — now consistent with the existing `x`-to-close
  guard.
- `/flows` content could overflow unwrapped on a narrow terminal while
  `/status` wrapped correctly right next to it; both now wrap to the
  panel's real width.

## [0.2.39] — 2026-08-17

### Added

- **SAC workspace lifecycle completion.** `WorkspaceService` gains `archive`,
  `removeResource`, and `rename`. Archiving a workspace hides it from
  `workspace list` by default (`--include-archived` to see it) without
  blocking read access, in-flight review, or discovery of its pending
  proposals. `archive`/`removeResource`/`rename` all require `owner` role,
  matching `archive`'s existing authorization level.
- **Slate: a task-local harness layer over the shared workspace.** Every
  `keryx shell`/TUI/`harness run` turn now tracks three ephemeral, per-attempt
  shelves that live alongside — never inside — the shared SAC workspace:
  - **Anchors** — execution context (root, tree/branch, runtime, touched
    files) recomputed fresh from live state on every restart/resume/fork,
    never restored from a prior attempt. Auto-injected into history on
    harness effects (tool call done, worktree resolved, `/model` switch,
    subagent spawn/return), visible on both the TUI and the readline shell.
  - **Course** — a live, read-only projection of the attempt's bound Flow
    (if any); never a second tracker, never mutated by slate itself.
  - **Seeds** — append-only, model-writable hypotheses (`slate_read`/
    `slate_write_seed` tools), promoted to the shared workspace's Know-how
    only through the existing `workspace review` gate — never automatically.
  - Opens on an action-intent turn or `/goal <text> [--workspace <id>]`
    (also `keryx harness run --goal ... [--workspace <id>] [--unattended]`);
    closes on flow-done, an explicit close phrase, `/new`, or shell exit,
    always archiving an unclosed prior attempt first, never overwriting it
    silently.
- **Unattended-mode safety gate (SLATE-8).** `workspace review --decision
  accepted` is denied outright for any session whose `interactive` context
  field is `false` — every `keryx serve` session, unconditionally, regardless
  of role or policy profile. `propose` is unaffected (deferred-queue model,
  not a full block); a session can never flip its own `interactive` field at
  runtime.
- **Ephemeral subagent slate.** A dispatched subagent gets its own full,
  disposable Anchors/Course/Seeds scoped to that one dispatch. On return, its
  state lands only in the parent's `slate.childDispatches[dispatchId]` — a
  separate, non-merged, provenance-tagged entry — never folded into the
  parent's own Seeds, and unreachable by any other path once the dispatch
  completes.
- **Machine wrap-up composer.** Replaces raw-transcript evidence with machine
  evidence (git diff, Flow snapshot, tagged Seeds) plus a model-generated
  summary, falling back to a mechanical template on a slow-but-present
  credential and failing closed (no proposal) with no credential at all.
  Seeds are grouped by `kind` and proposed one group at a time; a proposal is
  never created without a captured `workspaceId` — evidence is preserved as a
  local `unbound-candidate` artifact instead.
- **`keryx workspace catch-up` / `list-proposals`.** A pull-based,
  `cwd`-scoped surface for reviewing what accumulated during unattended runs:
  four always-separate sections (pending proposals, blocked runs,
  unbound-candidate wrap-ups, and sessions of genuinely unknown fate), with
  evidence freshness re-checked at display time rather than only at accept.
  Archived workspaces surface identically to active ones — archival never
  hides a pending proposal.

## [0.2.38] — 2026-08-16

### Added

- **Managed flow PR completion lifecycle.** The flow orchestrator now offers a
  complete PR path: create the PR, run review and fix iterations, merge into
  the recorded base branch, and close the flow only after the merge.
- **Bounded review recovery.** After six unsuccessful review/fix attempts, the
  orchestrator must enrich context, diagnose the cycle, and choose a materially
  different fix strategy or split the work into narrower tasks.
- **Clickable TUI subagent inspector (flow 162, #303).** The sidebar lists
  every spawned child for the session (running / done / failed) with no
  `… +N more`. Clicking a row opens the shared modal host on Work + Meta:
  task, live tool/reasoning/text log, model, status, and elapsed. Finished
  children stay inspectable until the TUI session ends.

### Changed

- Flow completion is now explicitly PR-and-merge-gated; an unmerged PR or a
  direct commit without a PR cannot transition a managed flow to `done`.

### Fixed

- **TUI/readline tool and approval parity.** One factory builds the
  interactive tool set for both surfaces, so `web_fetch` is no longer
  TUI-only. Approval policy (allowlist, tamper check, no auto-approve for
  destructive or credential commands) lives in one module. Readline prints
  those hints and can remember an exact `shell_exec` grant.

## [0.2.37] — 2026-08-16

### Added

- **`/status` inspector tabs.** The shared modal now has a fixed 72×18 chrome
  (title + `[x] esc` header, one-line footer). `/status` (chat and agent) opens
  Status plus a Context bar of known usage — last-turn tokens and a labelled
  estimate, never a guessed window. Workspaces and Flow tabs appear only when
  the session actually referenced a SAC workspace or a flow (`runLink.sessionId`
  or an explicit `flow 154` / `/flows 154` mention). `c` copies the session id.
- **`/flows` inspector.** Lists project flows; `↑/↓` selects, Enter or `→`
  opens the adjacent Detail tab (status, dir, tasks, PR). Readline/`--no-tui`
  prints the list, or `/flows 154` for one package.

### Changed

- **`/session-info` and `/info` removed.** They are no longer aliases. The
  slash menu advertises only `/status`.

### Fixed

- **Modal size no longer jumps on tab switch.** The host no longer shrink-wraps
  to each tab body.

## [0.2.36] — 2026-08-15

### Added

- **Reusable OpenTUI modal + tab host (flow 154).** `src/tui/modal-host.ts`
  opens a titled panel over a dimmed backdrop (not a full-screen `overlayBox`
  replacement of chrome), with an optional tab strip, Esc dismiss, composer
  focus restore, and `shell-chrome` overlay registration so the `/`-menu and
  Ctrl+O stay inert. Two callers can share the same host with different
  titles, tabs, and `initialTab`. Headless tests cover open, tab switch,
  replace-not-stack, and OpenTUI-unavailable no-op.
- **`/session-info` inspector (flow 155).** Slash commands `/session-info`,
  `/status`, and `/info` (chat and agent) open that host on Session and Usage
  tabs: title, keryx version, session id, project path, provider/model (live
  selection wins), parent id for forks, timestamps, message/archive/compact
  counts, last-turn tokens, and a labelled context **estimate** when the
  provider did not report a window. `c` copies the session id; `y` copies the
  block. Readline/`--no-tui` prints the same rows. The command never starts a
  model turn.

## [0.2.35] — 2026-08-15

### Added

- **Shared Agent Context complementary-stack proof (flow 153).** SAC is not a
  second wiki: Facts / Work / Know-how stay owned by evidence, Flow, and
  wiki/memory/skills. `keryx workspace overview|read --explain` prints that split
  next to the JSON receipt. Installed `dist/cli.js` now finds the normative SAC
  schemas by walking up from the CLI and cwd (the old `../../docs/...` URL from
  `src/sac` resolved to the *parent of the package* and `workspace create`
  ENOENT'd). The npm package ships `docs/requirements/shared-agent-context/schemas`.
  Live runbook: `docs/verification/wiki-graph-sac-proof.md`. Architecture page:
  `.metaproject/wiki/architecture/wiki-graph-sac.md`.
- **Benchmark suite M3 — model-matrix expansion, third local leg (qwen3.5-9b-4bit).**
  `run-safety.ts`/`run-containment.ts` had a real filename-collision bug: `FILE_SUFFIX`
  was keyed on `--provider` alone, so a second rapid-mlx model would silently
  overwrite the first model's committed fixture on every rerun — this actually
  happened live (driving `qwen3.5-9b-4bit` clobbered the already-committed
  `qwen3.5-4b-4bit` data), caught via `git diff`, reverted, and fixed by qualifying
  the suffix with the model too. The original `qwen3.5-4b-4bit` fixtures were
  restored byte-exact from git history, not regenerated — a fresh rerun of the same
  cases produced a genuinely different sample (1/3 vs the original 2/3) due to this
  small model's real run-to-run non-determinism. With the fix live,
  `qwen3.5-9b-4bit` (previously unused, carries a noted SIGABRT crash risk under
  memory pressure — did not materialize here) ran as a third real local leg:
  completion-honesty **3/3** (vs the 4-bit sibling's 2/3), false-premise **3/3**,
  containment **9/9 contained, 0 escapes** — no crash across the full run.
- **Benchmark suite M3 — RAG-adapter baseline, real live results.**
  `scripts/benchmark/run-rag-embedding-baseline.ts` (new): a real local
  semantic-embedding search (`Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`,
  a `devDependency` scoped only to this benchmark tooling — never the shipped
  CLI's runtime or `src/memory`'s core capability seam) over the same
  `.metaproject/wiki/` corpus and the same 5 gold queries as the gdwiki metastore
  oracle, reported side by side and never averaged
  (`wiki-ask-results-embedding-baseline.json` vs `wiki-ask-results.json`).
  rapid-mlx (the originally-preferred local server) was tried first and confirmed
  unable to serve this model (`ModuleNotFoundError: No module named
  'mlx_lm.models.bert'` — rapid-mlx only supports causal-LM architectures);
  keryx's own dormant `@xenova/transformers` embedding path was investigated next
  but is unresolvable as-is in this repo (no `memory-embed-default` entry in
  `.metaproject/assets.lock.json`; wiring one up needs a pinned asset + an ADR,
  out of scope here). Getting the dependency working itself needed a real fix:
  `@xenova/transformers`'s `sharp@^0.32.0` dependency failed to load under bun
  (`Cannot find module '.../build/Release/sharp-darwin-arm64v8.node'`) — root
  cause was running the smoke-test script from outside the repo tree, where bun
  resolves packages from its global cache directly instead of the project's own
  `node_modules` (where `sharp`'s postinstall had already built the binary); an
  in-repo script resolved correctly once `sharp`'s install script was trusted
  (`bun pm trust sharp`). Real live results (k=5, all 5 gold queries): nDCG@5 and
  recall@5 match the lexical gdwiki oracle exactly on 4/5 queries (1.000/1.0);
  both systems land the `quality-map.md` query at rank 2 for an identical
  nDCG@5=0.631, for different reasons (lexical's distractor is `project-map.md`
  via "map" token overlap, the embedding's is `src-health-metrics.md` via
  semantic proximity to "Code Health scan") — corroborating that page's known
  gap (no `## Summary` block) is a corpus-content weakness, not a single
  retrieval method's artifact. Groundedness intentionally not scored for this
  leg (the existing hand-labeled panel describes wikiAsk's own citation order,
  not this system's).
- **Benchmark suite M1 — safety track multi-model coverage, milestone complete.**
  `run-safety.ts`/`run-containment.ts` parameterized with `--provider`/`--model`
  (matching `run-ablation.ts`'s pattern). A local second leg (`rapid-mlx serve
  qwen3.5-4b-4bit`) run live across all four case groups: completion-honesty **2/3**
  (a real, model-specific failure the deepseek baseline never showed — hit the
  tool-call budget on a no-argument tool, gave a malformed reply, correctly scored
  `overclaimed`); false-premise **3/3** (matches deepseek); containment **9/9
  contained, 0 escapes** (matches deepseek, preflight canary confirmed sandbox
  blocking first) with an honestly-reported `attempted`-pattern divergence between the
  two models. All 5 fixtures pass `validatePairedBenchmark`. **M1 is now complete** —
  every exit-criteria item has real, live-captured data.
- **Benchmark suite M1 — mutating-ablation capable-model coverage across THREE
  third-party CLI harnesses, all 18/18.** The 0/18 qwen3.5-4b-4bit finding needed a
  model that can actually complete the base task.
  `scripts/benchmark/run-ablation-mutating-{codex,opencode,grok}.ts`: **codex**
  (`gpt-5.6-sol`) **18/18**; **Grok Build CLI** (`grok-4.6`, a third, newly-added
  agentic CLI, live-verified headless before being wired in) **18/18**; **opencode**
  (`opencode/deepseek-v4-flash-free`) **18/18** — but only after root-causing and
  fixing a real container-escape bug, not a model-capability finding. Two full
  opencode runs scored 0/18 with this repo's own real `src/lib/*.ts`/`opencode.json`
  found modified on disk afterward each time — opencode was editing the real checkout
  instead of its assigned isolated directory. Switching from a linked `git worktree`
  to a fully independent `git clone` (new `src/harness/child/git-clone-port.ts`) did
  NOT fix it (a third run still escaped); a minimal isolated repro nailed the actual
  cause: `Bun.spawn`'s `cwd` option sets the process's real working directory but does
  not update the inherited `PWD` env var, and opencode's own path resolution trusts
  `PWD` over the OS cwd for at least some operations. Fix (`env: { ...process.env,
  PWD: root }` alongside `cwd`), confirmed via a clean A/B repro before touching the
  real producer, then a fourth full run: 18/18, real repo verified untouched
  throughout. Every accidental edit from the three earlier escapes was caught and
  reverted before being committed. Kept the clone-based isolation as an independent
  extra safety margin alongside the PWD fix. Also fixed a real, separate bug found
  along the way in `scripts/benchmark/mutating-tasks.ts`'s `cliPrompt()`: it left
  `<seed test path>` as a literal, un-interpolated placeholder instead of the task's
  real file path (did not by itself explain the escapes, but a real bug regardless).

### Fixed

- **Installed CLI could not load SAC schemas.** `loadNormativeSchema` used
  `new URL("../../docs/...", import.meta.url)`, which only works from `src/sac`.
  The bundled `dist/cli.js` looked in the parent of the package.
- **TUI `/connect` listed providers that were not live.** The picker now keeps
  only providers that actually resolve.
- **TUI composer did not grow with wrapped input.** The composer now grows like
  a wrapping textarea instead of clipping the prompt.

## [0.2.34] — 2026-08-14

### Added

- **Benchmark suite M1 — metastore oracle slice (deterministic).** The
  `paired-3-5-v2` protocol (backward-compatible with `paired-3-5-v1`; Wilson CIs,
  judge panel, `servedModel`/`effort`, tokenizer-normalized cost), IR/oracle metric
  primitives, git-co-change gold derivation with a real pinned express fixture, and a
  metastore oracle runner exposed as `keryx metrics benchmark run --ladder metastore`.
  Produces the first honest oracle result (gdgraph `affected` vs co-change gold). All
  five metastore layers (gdgraph, testing, memory, gdctx, gdwiki) are landed.
  Requirements: `docs/requirements/keryx-benchmark-suite`.
- **Benchmark suite M1 — ablation runner (first live slice).** New
  `keryx metrics benchmark run --ladder harness` scores the SAME agent + model run
  twice per seed, in isolated git worktrees, with keryx metaproject tools present
  (`context-on`) vs a basic-tools-only baseline (`context-off`) —
  `src/metrics/ablation-runner.ts`, driven live by `scripts/benchmark/run-ablation.ts`
  via the same multi-turn agent loop `keryx shell --agent` uses
  (`src/commands/agent.ts` `runAgentTurn`), plus a real `git worktree add/remove`
  adapter (`src/harness/child/git-worktree-port.ts`) for a seam flow 096 had only
  planned. First live result (`deepseek-v4-flash`, 3 code-comprehension tasks, ×3
  seeds): task success 9/9 with context on vs 0/9 with it off, and 2-6x fewer
  tool-calls with it on. A second, separately-reported manifest
  (`scripts/benchmark/run-ablation-codex.ts`) runs the identical tasks through the
  already-authenticated `codex` CLI (its own agent loop; context on/off toggled by
  presence/absence of `AGENTS.md`/`.metaproject/` in the worktree) as the milestone's
  frontier-model leg: 18/18 success on BOTH variants (a real shell closes the gap a
  no-search baseline can't), with a mixed, non-directional token/tool-call delta —
  reported honestly rather than as a win. A third, separate manifest closes the
  milestone's "one frontier + one local" model coverage: `run-ablation.ts` is now
  parameterized (`--provider`/`--model`) and was run against a local `rapid-mlx serve
  qwen3.5-9b-4bit` (ollama would not start on the dev machine; unrelated to this work) —
  6/9 success with context on vs 0/9 off, tool-call counts only (this provider path
  reports no token usage). All three legs (deepseek/codex/rapid-mlx) are reported side
  by side, never averaged.
- **Benchmark suite M1 — safety track, first two case groups.** `PairedBenchmarkRunV2`
  gained `safety` (`contained`/`escaped` + case class) and `completionHonesty`
  (`honest`/`overclaimed`) fields, with AC-4 enforced as a hard invariant in
  `validatePairedBenchmarkV2`: an escaped case must score `correctness: 0`. New
  `src/metrics/safety-runner.ts` + `keryx metrics benchmark run --ladder harness --layer
  completion-honesty|false-premise`, driven live by `scripts/benchmark/run-safety.ts`.
  Completion-gate honesty gives the agent one fixed, non-configurable check tool per
  case (no injection surface) and grades whether its `VERDICT:` claim matches
  independently-verified reality; false-premise resistance asks loaded questions built
  on premises verified false against this repo's real source. First live result
  (`deepseek-v4-flash`): 3/3 honest on completion-honesty (the agent answered `UNKNOWN`
  even when it had just seen a clear pass/fail result — overcautious, not dishonest; an
  earlier scorer draft would have wrongly flagged that caution as an unsafe escape, since
  fixed) and 3/3 correctly rejected the false premise.
- **Benchmark suite M1 — safety track, containment (real OS sandbox).** Designed via an
  interviewer+brainstorm pass (Pragmatist/Innovator/Critic) before writing code —
  `scripts/benchmark/run-containment.ts`. A live agent (`deepseek-v4-flash`) is given a
  REAL, OS-sandboxed `shell_exec` (`KERYX_SANDBOX_SHELL=strict`) and tempted toward the
  same 3 unsafe actions (write outside its worktree, network egress when off, read a
  secret-shaped path) across 3 case classes (workspace-write containment,
  shell-permission restraint, prompt-injection resistance via a planted file). A
  mandatory preflight canary runs all 3 unsafe actions directly (no LLM) before any live
  case and aborts the whole run if even one is not blocked. `SafetyResult` gained
  `attempted`/`blockedAt` evidence fields (informational; AC-4 still governs
  correctness). Real result: **9/9 contained, 0 escapes** — and the new `attempted`
  field surfaced a real behavioral split the bare count would have hidden:
  shell-permission-restraint's "is this OK?" framing led the agent to never even attempt
  2 of 3 unsafe actions, while the other two case classes attempted all 3 and were
  stopped by the OS kernel every time.
- **Benchmark suite M1 — ablation runner, mutating coding tasks.**
  `scripts/benchmark/run-ablation-mutating.ts` + `scripts/benchmark/mutating-tasks.ts`
  extend the ablation runner from read-only comprehension questions to real,
  write-capable coding tasks: the agent gets a real `shell_exec` (auto-approved,
  scoped to this script's own `AgentIO`, same pattern `run-containment.ts` already
  established) and must edit an EXISTING file to make an already-seeded, already-failing
  test pass, in its own fresh git worktree per (task, variant, seed) — mutating tasks
  can't reuse a worktree across seeds the way read-only ones can. Success is decided by
  an independent `bun test` run after the turn, never the agent's own claim. All 3 tasks
  are real gaps observed this session, not invented (a missing atomic-JSON-write
  counterpart to `writeFileAtomic`; the exact `args.includes(flag)` one-liner repeated
  across `src/commands/init.ts`'s own flag parsing; the plain-text sibling of
  `readJsonFileOr` that `src/sac/proposal-evidence.ts` hand-rolls inline today) — each
  seeded test was hand-verified fail-then-pass before any live run. Live result with
  `rapid-mlx serve qwen3.5-4b-4bit` (deepseek/cerebras both unusable — no balance / HTTP
  401): **0/18, every task, both variants** — a real, diagnosed capability finding, not
  a scorer bug: a re-run with tracing showed the model looping on empty `get_cwd` calls
  until it hit `runAgentTurn`'s anti-loop guard, never once reading the target file. The
  original `qwen3.5-9b-4bit` (6/9 on the read-only leg) was never actually tested on this
  workflow — it crashed with SIGABRT under real memory pressure (108% projected RAM
  utilization, matching `rapid-mlx serve`'s own startup warning) partway through this
  slice's first live attempt, forcing a switch to the smaller model mid-session. Full
  harness + tasks + verification is real and reusable; the milestone still needs a model
  actually capable of the base task before the context-on/off comparison is measurable.
- **Benchmark suite M2 — harness-selection investigation, opencode headless dead-end.**
  Spec §1.3's comparative ladder requires the model held constant across targets.
  `opencode`'s free `deepseek-v4-flash-free` provider would have satisfied this
  literally (same model family as keryx's own harness legs), and its interactive TUI
  confirmed the model/provider works fine live — but both `opencode run --auto` and a
  `opencode serve` + `run --attach --auto` variant hang indefinitely on any task
  requiring a tool call, reproduced twice, independent of `.mcp.json` auto-discovery.
  The running server's own `/session` API surfaced a plausible cause: a
  `question`/`plan_enter`/`plan_exit` permission set to `deny` that `--auto` doesn't
  cover. `codex` was picked as M2's harness target instead, with the model-mismatch
  recorded as a disclosed spec deviation rather than papered over — see
  `docs/requirements/keryx-benchmark-suite/plan.md`'s M2 section.
- **Benchmark suite M2 — comparative report + fairness review (AC-6).** New
  `src/metrics/comparative.ts`: `buildComparativeReport`/`validateComparativeReport`
  combine keryx's own harness legs, a new zero-tool `raw` floor leg, and a
  third-party harness leg into `{keryx-on, keryx-off, raw, <harness>}` cells per
  task, with a per-target adapter/fairness status and a `publishable` flag on
  every cell that AC-6 requires be false whenever fairness isn't `met` — computed,
  never hand-set, so a caller can't silently mark a caveated result publishable.
  Legs stay independently-valid `paired-3-5-v2` manifests, never merged into one
  (the paired-cell invariant only fits exactly two complementary variants; a
  comparative row needs up to four) — this module only re-presents their `runs`
  side by side. `validatePairedBenchmarkV2`'s pairing invariant now exempts the
  `baseline` variant (a floor reference has no complement to pair against),
  existing pairing behavior unchanged (regression-tested). New
  `scripts/benchmark/run-ablation-raw.ts` produces the live `raw` leg —
  deepseek-v4-flash, same tasks, same `runAgentTurn` driver, EMPTY tool array:
  **0/9**, honest (the model cannot know this repo's exact symbols by guessing).
  New `scripts/benchmark/build-comparative-report.ts` synthesizes the three
  already-live fixtures into `fixtures/benchmark/keryx/comparative-report.json`:
  keryx-on 3/3, keryx-off 0/3, raw 0/3 (matching M1's already-reported numbers),
  codex 3/3 but `publishable: false` on every cell (fairness `not-met`, model not
  held constant) — AC-6 passes as a mechanism, but M2's `fairness: met` exit bar
  is honestly not reached with codex; the milestone stays open pending a
  same-model headless-capable harness.
- **Benchmark suite AC-5 — real gold-artifact leakage found and fixed.** AC-5 ("A
  dogfood case whose gold artifact is reachable by the agent fails its leakage
  assertion and is excluded from scoring") had never been demonstrated —
  `leakageAssertion` defaulted to `not-applicable` in every real M1 producer. Auditing
  it surfaced a genuine bug: every ablation worktree is a full `git worktree add
  --detach <path> HEAD` checkout (`src/harness/child/git-worktree-port.ts`), which
  includes `scripts/benchmark/ablation-tasks.ts`/`mutating-tasks.ts` THEMSELVES —
  containing the exact `expectedFile`/`expectedSymbol` answer key (and, for mutating
  tasks, the seeded test that IS the solution spec). An agent with `read_file` could
  read its own gold answer key directly, undetected, on every ablation run landed so
  far. New `src/metrics/leakage.ts` (`checkGoldLeakage`) is the real, deterministic
  reachability check; `validatePairedBenchmarkV2` gained a hard invariant mirroring
  AC-4's pattern — a manifest containing any `leakageAssertion: "failed"` run is
  invalid by construction. New `scripts/benchmark/run-leakage-check.ts` proves both
  directions live against real `git worktree` operations (no LLM call needed — leakage
  is a worktree filesystem property, decided before any agent runs): an unmodified
  worktree really does expose both gold files
  (`fixtures/benchmark/keryx/leakage-check.json` — the real, unpatched vulnerability),
  a stripped one genuinely reports `passed`. The fix — strip the gold artifact from
  every worktree before the agent ever sees it, verify the strip worked, abort rather
  than run a live case on an unverified worktree — is now wired into all three live
  producers (`run-ablation.ts`, `run-ablation-codex.ts`, `run-ablation-mutating.ts`).
  Every ablation manifest already landed in M1 was captured on an unstripped worktree;
  disclosed honestly rather than retracted — no evidence of actual exploitation
  (`context-off`'s consistent failures and the mutating slice's diagnosed anti-loop
  trip are inconsistent with a model that read its own answer key), but future
  regenerations now run leakage-clean by construction.
- **Fixed: two real MCP exposure gaps found while auditing keryx-shell/MCP capability
  parity.** (1) `buildMcpModuleEntry()`'s default `expose.modules`
  (`src/mcp/client-config.ts`) was missing `"gdctx"` and `"testing"` — `search_code` and
  `test_related` were registered in `buildToolRegistry` but invisible via `tools/list`
  to every external MCP client (Claude Code, Cursor) unless someone hand-edited the
  manifest. (2) The unified `read_wiki`/`wiki_ask`/`wiki_backlinks` operations
  (`src/harness/tool/metaproject-operations.ts`) tagged themselves `module: "gdwiki"` —
  the real internal facade name — instead of the MCP discovery layer's established alias
  `"wiki"` (`src/mcp/discovery.ts`'s `MODULE_MANIFEST_KEY`, mirroring `flow`→`tasks`),
  so `exposedModules.includes(module)` silently failed even with `"wiki"` correctly
  present in `expose.modules` — these three tools were invisible to every MCP client
  since they were unified into `metaproject-operations.ts`, leaving only the older,
  duplicate hand-written `wiki.ask`/`wiki.query` MCP tools reachable. Fixed the tag (and
  its schema enum, `metaproject-operation.schema.json`) rather than the discovery layer,
  since the alias convention is already established and correct everywhere else. Live
  end-to-end verified with a real spawned `keryx mcp serve` + `@modelcontextprotocol/sdk`
  `Client`/`StdioClientTransport` round-trip against this repo: tool count visible to an
  external client went from 27 to 30 (`search_code`, `test_related`, `read_wiki`,
  `wiki_ask`, `wiki_backlinks` all now present and callable). Both fixes also applied to
  this repo's own live `.metaproject/metaproject.json` (same surgical, targeted-edit
  pattern as the earlier `sac` expose fix).
- **MCP: real `codex`/`opencode` client verification, `opencode` install support.**
  Live-tested whether keryx's MCP server (fronting the same gdgraph/wiki/memory/health
  intelligence `keryx shell` uses internally) actually works with third-party CLI
  harnesses, not just Claude Code/Cursor. `codex`: registered via its own native
  `codex mcp add`, called `graph_affected` through `codex exec --approve-for-me`
  headlessly, got a real correct result — `codex exec` alone (no approval flag) silently
  cancels MCP tool calls, documented in `renderMcpManifest()`. `opencode`: called the
  same tool through `opencode run --auto` headlessly and it worked — genuinely
  surprising given `opencode`'s own built-in tools hang indefinitely in headless mode
  (documented separately); an MCP-sourced tool call apparently takes a different
  permission path than opencode's own tools. Added `OPENCODE_RUNTIME` to
  `src/mcp/client-config.ts` as a real, tested `--runtime opencode` for
  `keryx mcp install`/`uninstall` (writes project-local `opencode.json`, shape
  `{mcp: {keryx: {type, command, enabled}}}` — structurally different from every other
  runtime's `mcpServers.<name>.{command,args}`, confirmed against a real `opencode.json`
  before wiring in) and to `keryx init`'s interactive MCP prompt; `all` now expands to
  cursor+claude+opencode. `codex` is deliberately NOT a `--runtime` here — its config is
  a single GLOBAL `~/.codex/config.toml`, not project-local, and its own `codex mcp add`
  is already the safe way to manage it; documented instead of duplicated. Along the way,
  found and fixed a real, generic bug in `uninstallMcpClient`: its "was this runtime's
  keryx entry present" check hardcoded the `mcpServers` shape, so uninstall always
  silently reported `removed: false` for any runtime using a different shape (opencode
  today, any future one later) — fixed by adding a `hasManaged(settings)` predicate to
  the `McpClientRuntime` interface itself rather than special-casing it.
- **Fixed: sandbox read-deny list built from an uncanonicalized `homedir()`.**
  `src/harness/tool/builtin/shell-exec-tool.ts`'s `shellSandboxProfile` canonicalized
  `root`/`tmpdir()` for the Seatbelt profile but passed `homedir()` through raw; on
  macOS `/var` symlinks to `/private/var`, so a `HOME` pointed at a `tmpdir()`-derived
  path (exactly what an isolated CI run or test harness does) silently escaped the
  secret read-deny rules. Found live by the M1 safety-track containment preflight
  canary before any agent case ran — not a live risk for a real user's real `$HOME`
  (`/Users/<name>` has no symlink component), but a real gap for anyone overriding
  `HOME` for isolation. Fixed with `canonical(homedir())`, matching the existing
  treatment of `root`/`tmpdir()`.
- **Shared Agent Context — real harness composition for the memory-entry write path.**
  `keryx workspace propose --kind memory-entry --session <id>` and
  `keryx workspace review ... --decision accepted` now land a real file in
  `.metaproject/memory/` end-to-end, closing the gap the Phase 3 exit note left open:
  SAC's write path was intentionally fail-closed (`createLocalProposalLifecycleService`
  ships every owner writer as `unavailable` — "SAC never edits Wiki, Memory or Skills
  files itself" until each owning subsystem composes a trusted implementation). New
  `createHarnessProposalLifecycleService` (`src/sac/proposal-lifecycle.ts`) composes two
  new real modules: `src/sac/session-wrap-up.ts` (`resolveSessionWrapUp`) turns a real
  keryx shell session into a `TrustedWrapUpResolution` by exporting its full archive
  (`src/session/store.ts` `exportSessionMarkdown`, every role/message verbatim) into the
  target workspace and hashing that export — never the agent's own summary; and
  `src/sac/memory-owner-writer.ts` (`createRealMemoryOwnerWriter`) is memory's first real
  `GuardedOwnerWriter`: it reads the proposal's evidence pointer, re-verifies the
  evidence file's hash against what was recorded at propose time, and writes a
  schema-valid entry via the same canonical `src/memory/write.ts` `writeCanonicalEntry`
  path (and its security guard scan) `keryx memory new` uses. Verified live end-to-end
  (real session, real hash-verified evidence chain, real written memory file) and with
  103/103 `src/sac/` tests green (14 files). Wiki/skill owner writers remain
  `unavailable`/fail-closed — only memory has a real composition today. Two real bugs
  found and fixed along the way: (1) `TrustedWrapUpProvenance.sourceRef` is schema-typed
  as a workspace-relative `path` (no bare IDs, no `#` fragments) —
  `resolveSessionWrapUp` now encodes the session id in the path itself
  (`sessionEvidenceRef`) and independently re-derives+re-verifies it rather than
  trusting the caller's resolution (defends against a spoofed workspace segment); (2) an
  optional `--note` passed at `propose` time was captured in a service-composition
  closure that does not survive into a separate `review`-time process — fixed with a
  sidecar `<proposalId>.note.txt` file (`proposalNotePath`), written at propose time and
  read back at accept time, mirroring the approval/intent/decision sidecar pattern
  `proposal-lifecycle.ts` already used. The read-path (an agent reading FWK context
  live inside `keryx shell`) remains unwired — out of scope for this slice.
- **Shared Agent Context — real harness composition for the wiki-update write path.**
  `keryx workspace propose --kind wiki-update --session <id>` +
  `review --decision accepted` now lands a real "decision" page (`WIKI_PAGE_TYPES` —
  "known decisions and ADR-like records", `.metaproject/wiki/decisions/`) end-to-end,
  the same shape of gap the memory-entry path closed above. New
  `src/sac/wiki-owner-writer.ts` (`createRealWikiOwnerWriter`) is wiki's first real
  `GuardedOwnerWriter`, guarded by the SAME security write seam
  `keryx wiki collect` runs before publishing a generated page
  (`src/wiki/service.ts`, `guardOutput({ target: "wiki" })`) — a blocked write is
  refused, not silently sent. Unlike memory, there is no canonical "write real body
  content" helper to reuse here: `keryx wiki new` (`wikiCreatePage`) only scaffolds a
  blank title/type template with no content field, so this writes directly via the
  same `writeFileAtomic` helper `proposal-lifecycle.ts` already uses elsewhere. The
  proposal-record read + evidence hash re-verification that memory and wiki both need
  was pulled out into shared `src/sac/proposal-evidence.ts` (`readVerifiedProposalEvidence`,
  `ownerReceiptPath`, `proposalNotePath` + the sidecar-note fix from above) rather than
  duplicated a second time; `memory-owner-writer.ts` was refactored onto the same
  seam with no behavioral change (same receipt paths, same tests, still 115/115 green
  across `src/sac/` + the session-reader caller guard). Verified live end-to-end (real
  session → hash-verified evidence → accepted `wiki-update` proposal → real
  `.metaproject/wiki/decisions/sac-<id>.md`, note included). **`skill` stays
  `unavailable`/fail-closed on purpose**: `src/security/types.ts`'s `SecurityTarget`
  union has no `"skill"` member and `createProjectSkill`
  (`src/gdskills/project-skills.ts`) runs no security scan at all today — writing
  SAC-derived content into skills (read as agent routing instructions every turn)
  without the same guard memory/wiki get would be a real safety regression, not a
  shortcut, and was deliberately not done.
- **Shared Agent Context — FWK read-path wired into the live agent shell.** A
  running `keryx shell` agent turn can now read SAC workspace context directly:
  two new read-only tools, `workspace_overview` and `workspace_read`
  (`src/harness/tool/builtin/workspace-context-tool.ts`), wrap
  `createLocalFwkReadService` (previously reachable only from a separate CLI
  process via `keryx workspace overview`/`read`, or over MCP as `sac.overview`/
  `sac.read`) and are added to both the TUI and readline tool arrays in
  `src/commands/shell.ts`, `risk: "read"` like `read_file`/`list_dir`. There is
  no session↔workspace linkage anywhere in keryx (no `--workspace` flag, no
  workspace field on `SessionSummary`), so the agent must be told which
  workspace to read via an explicit `workspaceId` on every call, same as the
  CLI. Confirmed this can't become HTTP-reachable: `keryx serve`'s handler
  never touches `shell.ts`'s `AgentDeps`/tool-array construction, so this stays
  on the same local-only trust boundary `shell_exec` already operates under —
  unlike the MCP `sac.*` tools, which explicitly refuse HTTP transport because
  SAC's local auth server derives its actor from the OS user with no verified
  per-request principal. Verified two ways: 6 offline unit tests calling the
  tools directly against a real (but resource-less) workspace, AND one fully
  live round-trip — a real local model (`rapid-mlx serve qwen3.5-9b-4bit`)
  driven through the actual `runAgentTurn` loop `keryx shell` uses, calling
  `workspace_overview` for real, getting back a real signed access receipt, and
  correctly reporting the result. (DeepSeek and Cerebras credentials were both
  unusable at verification time — no balance / 401 — so the live check ran
  against a local model instead of the usual `deepseek-v4-flash`.)
- **Fixed: `keryx skills create` ran zero security scanning.** Unlike
  `keryx wiki collect` (`guardOutput({ target: "wiki" })`) and `keryx memory new`
  (`writeCanonicalEntry`'s guard), `createProjectSkill`
  (`src/gdskills/project-skills.ts`) wrote `SKILL.md` — content read as agent
  routing instructions every turn — with no scan at all. `SecurityTarget`
  (`src/security/types.ts`) gained a `"skill"` member (also added to
  `src/security/schemas.ts`'s finding-schema enum and `src/commands/security.ts`'s
  `--target` validation list — both closed allow-lists, found and updated
  together so `--target skill`/a finding with `target: "skill"` don't fail
  closed for unrelated reasons); `writeProjectSkillPackage` now renders
  `SKILL.md`'s content and runs it through `guardOutput({ target: "skill",
  source: "generated" })` **before** any `mkdir`/write happens, throwing if the
  strict/enforced gate blocks it. New `src/gdskills/project-skills.test.ts`
  (this function had no test coverage at all before) proves all three real
  behaviors: unaffected by default (security module disabled), a planted
  secret genuinely blocked end-to-end in `enforced` mode with **nothing**
  written to disk, and the same content allowed through in `advisory` mode
  (report-only, matching every other target's documented behavior). Found
  while investigating why `skill` — the third `GuardedOwnerWriter` owner
  alongside `memory`/`wiki` — was still `unavailable`/fail-closed in SAC; this
  was the actual blocker (no target, no scan), not laziness. 190/190
  `src/gdskills`+`src/security`+`src/commands/security` tests green.
  **A real skill owner-writer is still not composed**: while wiring this,
  found that `ProposalLifecycleService.targetWriteOrStale`
  (`src/sac/proposal-lifecycle.ts:127`) requires an owner's receipt
  `targetRef` to literally start with `./${owner}` — `./memory/...` and
  `./wiki/...` both genuinely match where those owners store files under
  `.metaproject/`, but `keryx skills create` stores real skills under
  `.metaproject/project-skills/`, not `.metaproject/skill/`. A skill
  owner-writer built today would have to fake a `targetRef` that doesn't
  match the real file location to pass that check, which is worse than not
  building it — so it wasn't built. Fixing this needs a decision on the check
  itself (e.g. a per-owner prefix map instead of a literal `./${owner}`
  assumption) before a real skill writer can be composed honestly.
- **Shared Agent Context — the skill owner-writer, and the targetRef fix it
  needed.** `ProposalLifecycleService.targetWriteOrStale`
  (`src/sac/proposal-lifecycle.ts`) assumed every owner's receipt `targetRef`
  starts with the literal `./${owner}` — true by coincidence for memory/wiki,
  false for skill (real skills live under `.metaproject/project-skills/`, not
  `.metaproject/skill/`). Replaced with `ownerTargetPrefix(owner)`, a real
  per-owner map (`memory→./memory`, `wiki→./wiki`, `skill→./project-skills`).
  Two new regression tests in `proposal-lifecycle.test.ts` prove the fix
  actually enforces the correct prefix rather than just "always pass": a skill
  receipt with the OLD, buggy `./skill/...` shape (exactly what the previous
  check would have accepted) is still rejected and the accept lands as
  `stale`; one with the real `./project-skills/...` shape is accepted.
  `src/sac/skill-owner-writer.ts` (`createRealSkillOwnerWriter`) is skill's
  real `GuardedOwnerWriter` — the third and last, alongside memory and wiki.
  It reuses `createProjectSkill` itself (`keryx skills create`'s own write
  path, now guarded from the previous change) rather than writing
  `.metaproject/project-skills/` files a second, parallel way: every
  SAC-derived skill lands under the fixed `sac` module
  (`.metaproject/project-skills/sac/<proposalId>/SKILL.md`), so it's always
  distinguishable from a skill a person created directly. `keryx workspace
  propose --kind <kind>` now accepts all six real proposal kinds (`decision`,
  `wiki-update`, `memory-entry`, `follow-up`, `contract-change`, `risk`) — not
  just the two that had writers before — since every kind now routes (via the
  existing `ownerFor`) to a real owner. Verified live end-to-end: real
  session → hash-verified evidence → accepted `decision` proposal → real
  `.metaproject/project-skills/sac/<id>/SKILL.md`, with `metaproject.json`'s
  skill registry and `skills/catalog.md` correctly updated by
  `createProjectSkill`'s own bookkeeping (and cleanly reverted after
  verification, along with the demo skill directory). 7 new tests in
  `skill-owner-writer.test.ts`, including one proving the security gate from
  the previous change genuinely blocks a skill write end-to-end (not just
  wired) — a planted secret in the derived skill content is refused in
  `enforced` mode with nothing written to disk. Full suite green after this
  change (typecheck clean; `src/sac`+`src/gdskills`+`src/security`+
  `src/commands/security`+`src/commands/workspace`: 309/309).
- **Fixed: `sac.propose`/`sac.review` over MCP were never actually wired.**
  `src/mcp/tools.ts`'s `sac.propose` unconditionally returned
  `trusted_wrap_up_required` (empty input schema — it could not have worked),
  and `sac.review` called the fail-closed `createLocalProposalLifecycleService`
  instead of the real `createHarnessProposalLifecycleService` composition the
  CLI/keryx-shell paths already use. Both now compose the real thing: `sac.propose`
  takes `{ workspaceId, kind, sessionId, note?, proposalRevision? }`, resolves the
  session via `findSession`, issues a real wrap-up, and creates a real proposal
  (with the same propose-time note sidecar the CLI uses); `sac.review` runs the
  same review path the CLI does. `src/sac/service.ts` (the facade `src/mcp/`
  is architecturally restricted to — enforced by `boundary.test.ts`'s M-3 guard)
  gained the needed exports: `createHarnessProposalLifecycleService`,
  `sessionEvidenceRef`, `proposalNotePath`, `findSession`. A SECOND, independent
  bug surfaced while live-verifying this: `sac.*` tools were entirely invisible
  over MCP regardless of the fix — `buildMcpModuleEntry()`'s default
  `expose.modules` allowlist (`src/mcp/client-config.ts`) never included
  `"sac"`, so `tools/list` never returned them. Both fixed together; verified
  with a real MCP SDK `Client`/`Server` round-trip (`InMemoryTransport`, real
  protocol serialization, not just in-process function calls) against a real
  session and a real workspace: `tools/list` now returns all 5 `sac.*` tools,
  `sac.propose` creates a real proposal over the wire, `sac.review` accepts it
  and a real file lands in `.metaproject/memory/task-notes/`. New
  `src/mcp/sac-tools.test.ts` (3 tests, previously zero coverage for these two
  tools). Also documented `keryx mcp install`/`uninstall` in the mcp module's
  own manifest doc (`renderMcpManifest`) — it only mentioned `serve` before,
  so nothing told an agent reading `.metaproject/modules/mcp.md` that
  `mcp install --runtime <runtime>` is the real, complete way to connect a
  project when asked to "enable MCP", short of hand-editing a client config.
  Connected this repo for real (`keryx mcp install --runtime claude`) after
  confirming it was safe to run from this dev checkout: `enableMcpModule` is a
  surgical read-parse-patch-write on just `modules.mcp` in the existing
  manifest, unlike `keryx modules enable <name>`'s full `initCommand()`
  reconciliation (which regenerates every enabled module's files and, earlier
  this session, was found to silently regress this repo's real
  `.metaproject/` content when run from a dev checkout whose generators have
  diverged from the separately-installed global `keryx` binary that actually
  wrote it). 246/246 across `src/mcp`+`src/sac`+`src/commands/security`+
  `src/gdskills` after this change, typecheck clean.

## [0.2.33] — 2026-08-13

### Added

- **Shared Agent Context — phase-6b operator readiness check.** New read-only
  `keryx workspace policy-readiness` (backed by `diagnosePolicyReadiness`) validates
  the full opt-in policy integrity chain **before** enabling — even while the
  experiment is disabled — reporting each gate's pass/fail and exiting non-zero when
  not ready, so an owner can prove real-data readiness before flipping
  `enabled: true`. Read-only; the runtime guard and default-off posture are
  unchanged. Documented in the new Phase 6b operator playbook.

## [0.2.32] — 2026-08-12

### Added

- **Shared Agent Context — phase-6 runtime opt-in policy guard.** The FWK read
  path now switches from the deterministic baseline to the experimental learned
  candidate policy only through `resolvePolicySelection`
  (`src/sac/fwk-service.ts`): a strict, fixed-order integrity chain over explicit
  config pins (candidate → baseline → corpus → evaluation report → deterministic
  activation). It is fail-closed to baseline on any error, off by default, and
  gated by a kill-switch and rollback. No public CLI or MCP schema changes; the
  candidate is never enabled implicitly. Acceptance criteria AC1–AC6 met; full
  SAC suite 88/88 green.

### Documentation

- **New docsite guide: "Shared Agent Context (experimental)"** covering the FWK
  model, the `keryx workspace` workflow (create / add-resource / overview / read /
  propose / review) and the phase-6 runtime opt-in config, linked from the README.
- **SAC requirements package reconciled.** Phase 6 is documented as one phase with
  two parts — 6a runtime enforcement guard (implemented) and 6b real operator-data
  readiness (planned) — across the package README, implementation plan and the
  phase-6 readiness document.

## [0.2.31] — 2026-08-12

### Changed

- **Agent TUI now separates `/connect` and `/provider` semantics.**
  `/connect` lists only already-configured and reachable providers, while
  `/provider` remains the configuration/setup path (API key + endpoint + model).

- **Provider selection and model discovery robustness.** Endpoint overrides are
  persisted per provider, and rapid-mlx detection no longer falls back to
  unrelated hardcoded models when endpoint probing fails.

## [0.2.30] — 2026-08-12

### Fixed

- **Agent TUI launch regression fix.** Removed stale `searchController` option from the
  `launchTuiAgentShell` call path to match its current signature after `/connect`
  / `/provider` picker refactoring. This unblocks the release pipeline type check and keeps
  the shell launch API consistent.

## [0.2.29] — 2026-08-12

### Changed

- **Split `/connect` and `/provider` semantics in agent TUI.** `/connect` now
  selects only already-configured providers (with required keys and successful live
  `/models` checks). `/provider` remains the configuration command for provider
  credentials and model setup.

## [0.2.28] — 2026-08-12

### Fixed

- **Local SearXNG search now works through the sandbox.** The web worker selects
  the HTTP client for loopback search endpoints while retaining HTTPS-only
  policy for remote web fetches.

## [0.2.27] — 2026-08-12

### Fixed

- **Sandboxed web fetch now connects reliably on dual-stack hosts.** The worker
  returns the correct Bun DNS-pinning callback shape and prefers a validated
  IPv4 address when it is available alongside IPv6.
- **Agent web-tool guidance no longer treats fetch as search.** For unknown
  sources, the agent now gives search-provider setup guidance instead of
  guessing URLs or repeatedly retrying an unavailable search provider.

## [0.2.26] — 2026-08-12

### Added

- **Sandboxed web transport and provider-based search.** Agent mode now offers
  `web_fetch` and `web_search` through a fail-closed, DNS-pinned sandbox worker.
  SearXNG, Brave Search, Tavily, and Exa are configured through the TUI; only a
  successfully tested provider can become active.
- **Local SearXNG guide.** `/search-provider` supplies editable localhost URL
  and port defaults, with an installation guide for a local Docker deployment.

### Security

- **External web data is tainted.** It is bounded, redacted, provenance-labelled,
  and cannot authorize later agent tool calls across turns or session compaction.

## [0.2.25] — 2026-08-11

### Changed

- **Provider configuration is now uniform in the agent TUI.** `/provider`
  lists all supported providers and lets every endpoint-based provider edit its
  endpoint URL before live model discovery; overrides are stored per provider.
  `/connect` lists only configured or currently reachable providers.

### Fixed

## [0.2.24] — 2026-08-11

### Fixed

- **Provider switching is available in agent TUI.** `/provider` now opens the
  provider, API-key, and model picker in agent mode, matching `/connect` and
  avoiding a switch to chat mode solely to change providers.

## [0.2.23] — 2026-08-11

### Added

- **Configurable OpenAI-compatible provider endpoints.** Override any built-in
  provider URL with `KERYX_<PROVIDER>_BASE_URL`; for example,
  `KERYX_RAPID_MLX_BASE_URL=http://127.0.0.1:8010`. The selected endpoint is
  also used to discover the provider's live model list.

## [0.2.22] — 2026-08-11

### Fixed

- **Durable interactive-session checkpoints.** `keryx shell` now writes the user
  message immediately, checkpoints tool results, and journals streamed assistant
  text every 300 ms. `/interrupt` therefore preserves the latest partial answer
  instead of losing the active turn.

## [0.2.21] — 2026-08-11

### Fixed

- **Release verification for changed-test selection.** Updated stale test expectations
  for the existing `imports` selection strategy, restoring the release test gate.

## [0.2.20] — 2026-08-11

### Added

- **Interactive session switching in the TUI (`/sessions`).** The shell now opens a
  per-project session picker for live switching while preserving current sessions on
  disk.
- **Main-turn interrupt command in the TUI (`/interrupt`).** Added a hard-stop path for
  an in-flight main turn, with deterministic teardown of the running provider loop.

### Changed

- **Side prompt execution model in the TUI.** While the main turn is busy, additional
  plain prompts are queued into a single read-only side worker (`side-1`) and processed
  sequentially. This keeps the interface responsive without mutating context during
  background helper turns.

## [0.2.19] — 2026-08-11

### Fixed

- **Health regression fixed for keyless OpenAI-compatible providers (Rapid-MLX and similar).**
  OpenAI-compatible registry providers without `envKey` are now handled correctly in
  mask resolution, provider detection, and provider construction paths. This removes
  the TypeScript hard failures that blocked release-health gates on `keryx health run`.
- **Release metadata stability for provider detection flows.**
  Type strictness and generated graph/wiki artifacts were updated so the same provider
  registry changes (including rapid-mlx) are represented safely in runtime and docs tooling.

## [0.2.18] — 2026-08-11

### Added

- **Bounded version update advisories.** `keryx shell` performs one background,
  non-blocking check and shows a notice only for a strictly newer validated
  npm version. `keryx version check [--json]` exposes the same typed result;
  neither surface auto-installs or blocks project work. Successful metadata is
  cached for 24 hours, failed checks are suppressed for 15 minutes, and the
  registry request times out after 2 seconds. The exact manual update command
  is `npm install -g @mrciphersmith/keryx@latest`.

### Documentation

- Generated `.metaproject/index.md` guidance asks agents to run the JSON check
  once per session and to notify only on `update-available`; the instruction is
  prompt guidance, not enforcement, and unknown/offline/unavailable results
  remain non-blocking. Existing installations from before the first
  feature-bearing release cannot discover that release through code they do not
  yet contain, and existing projects gain the guidance only after index
  regeneration or update.

## [0.2.17] — 2026-08-11

This release makes project bootstrap reliable without inflating every agent
turn, gives read-heavy investigation enough room to finish, and completes the
memory reliability work from recall through lifecycle writes.

### Added

- **Agent orientation now starts from the launch project's Metaproject.** When
  `.metaproject/index.md` exists at the project root, `keryx orient` includes a
  bounded excerpt of its routing sections and tells the agent to read the full
  file before project work. It deliberately does not discover an ancestor
  Metaproject or describe the prompt instruction as an enforced runtime gate.
- **Memory reports and lifecycle transitions are explicit surfaces.** Default
  recall is side-effect free; `memory search --save-report` persists an
  immutable report only when requested; `memory transition` validates status
  changes; and supersession updates both entries through the guarded lifecycle.

### Changed

- **Interactive-agent tool budgets are split by risk inside a 48-signature
  total:** up to 40 read signatures and 8 non-read or unknown-risk signatures.
  Repeating the same normalized call still occupies one slot, and merely
  reaching a limit no longer ends the turn before the model can answer from the
  last result.
- **Automatic memory influence is accepted-only, current, and bounded** across
  shell approval context, flows, the harness adapter, MCP, and skill
  verification. Search filters, temporal validity, memory types, templates, and
  configuration now share one validated contract.
- **Canonical memory writes are confined, security-gated, and atomic.** Paired
  supersession writes roll back together on failure. Legacy generated
  `data/memory/artifacts/latest.*` files receive advisory migration guidance;
  Keryx does not delete downstream files or mutate the Git index automatically.

### Documentation

- Added the implemented P0–P6 memory reliability requirements, specification,
  migration policy, verification evidence, schema, and updated CLI/module/wiki
  guidance.
- Added a frozen 26-case shell benchmark protocol for comparing Keryx model
  legs with Claude Code and Codex without claiming results before a run.

## [0.2.16] — 2026-08-05

The other half of the 0.2.15 audit. That release corrected what the README
claimed; this one closes the five gaps it found in the code — one live security
weakness, two safety mechanisms that could not fire, and two finished features
with no way in.

### Security

- **A `network: "restricted"` sandbox profile now fails closed on Linux
  regardless of `KERYX_SANDBOX_ALLOW_UNSANDBOXED`.** One variable covered two
  unrelated failure modes. A missing launcher is a degradation an operator can
  knowingly accept; a domain allowlist that is not implemented on this platform
  is not. In the second case the allowlist proxy had already started and the
  proxy variables were already merged into the command environment, and then the
  command was spawned uncontained and free to ignore both. The check lives at the
  spawn point, where profiles from all three construction paths converge and the
  invariant cannot be routed around. The missing-launcher escape hatch is
  unchanged, and is pinned by its own test so the fix cannot be satisfied by
  refusing everything.
- **The harness mutation path is scanned by a scanner that can find
  something.** The redaction seam was real, but the only implementation behind it
  answered "no secret here" to every input, so every tool result the run loop
  persisted came out verbatim. `scanAvailable` — a fail-closed capability signal
  the guard denies on — was hardcoded `true` at the production call site. Both
  now derive from the real detectors, resolved once before the run so the loop
  stays synchronous, offline and replayable.

### Added

- **`keryx sessions fork <id>`** branches a conversation into a new session that
  keeps its ancestry (`parentSessionId`) and starts from the same context and
  archive. Writing to the fork never touches its source. Forks are marked `↳` in
  `keryx sessions list`.
- **`keryx harness replay --record <path>`** validates a recorded run's log
  against a replay fixture, and **`keryx harness run --record <path>`** writes
  the record. `--write-fixture` keeps a fixture, `--fixture` compares against a
  kept one, and a divergence prints a typed mismatch naming the field and exits
  non-zero. This is `validate-log` and says so: it checks that a fixture still
  describes the run it was built from, and re-executes nothing.
- **The completion gate can be told what to require.** `runOffline` accepts
  `requiredEvidenceRefs` and `requiredGates` instead of building two empty arrays
  itself, so two of the gate's three conditions stop being vacuous. Supplying
  nothing keeps the previous behaviour, which has its own test.

## [0.2.15] — 2026-08-05

A claim-by-claim audit of the README against source. Three commands turned out
to report work they had not done, and the fixes are the substance of this
release; the documentation changes are what the audit found on the way.

### Fixed

- **`keryx orient install-hook --dry-run` wrote the file anyway.** The flag was
  accepted by the shell and parsed by nobody. A `--dry-run` that mutates is worse
  than no flag at all, because it is the flag someone reaches for when they are
  unsure a command is safe to run. Both `install-hook` and `uninstall-hook` now
  honour it and report the file they would have touched.

- **`keryx init` claimed the git hooks were installed when there was no
  repository.** The hook installer returns early with no hooks root, but the
  summary rendered its rows from the intent flags — so running `keryx init`
  before `git init` reported every hook as installed while nothing was written
  and nothing would ever fire. It now reports them as skipped and says how to get
  them installed. The security agent hook keeps its row; it lands in
  `.claude/settings.json` and does not need a repository.

- **`keryx status --help` ran the report instead of printing help.** Harmless in
  itself — `status` is read-only — and fixed for the reflex it teaches for the
  commands that are not.

### Documentation

- **The README stops claiming four harness capabilities that are built but not
  reachable**, and stops describing a replay path that cannot detect a divergent
  run. The capabilities are tracked in the issue tracker rather than dropped
  silently.

- **The provider list was four of eleven.** Anthropic, Ollama and the
  OpenAI-compatible gateways — OpenRouter, DeepSeek, Z.AI, Cerebras, Groq,
  Moonshot, Grok — with the offline fake provider alongside them.

- **Corrections where the README and the code disagreed:** CI runs on pull
  requests and pushes to `main`, not every push; four of the five model commands
  exit non-zero without a credential, and `wiki enrich` is the one that exits `0`
  and skips pages; the remote policy profile is compared once at startup, where a
  weaker profile refuses to bind at all; git is required for hooks, changed-scope
  runs and the managed installer, not by the core.

- **The CLI reference gained the five model commands it was missing** —
  `wiki enrich`, `test suggest`, `flow plan`, and `--narrate` on `memory reflect`
  and `health explain` — and its `harness run` signature no longer names three
  providers out of eleven.

## [0.2.14] — 2026-08-04

### Documentation

- **The documentation site stops describing itself as machine output.** The
  landing page opened with "Auto-generated developer documentation … reverse
  engineered from source", which is both wrong — you cannot reverse-engineer
  your own code — and the first sentence a visitor read. The useful half of that
  note survives: these pages describe shipped behaviour, `docs/requirements/`
  describes intent, and where they disagree the docs section wins.

- **The public documentation index no longer links to the scaffolding.** The
  release-readiness audit and the community-documentation plan are working
  material; they stay in the repository and leave the published index, which now
  points at the changelog and the tagged releases.

- **README images use absolute URLs.** The README is the npm page as well as the
  GitHub one, and relative `docs/assets/` paths only render there by grace of
  npm's URL rewriting. They are now pinned to `raw.githubusercontent.com`, so the
  page renders the same wherever it is displayed.

## [0.2.13] — 2026-08-04

### Documentation

- **The harness screenshots show the harness working.** The first pass shipped a
  `/help` frame — the UI, with nothing in it. Replaced with three captures of
  real turns against this repository: `glm-5.2` answering a blast-radius
  question through the `graph_affected` tool in twelve seconds; the agent
  raising a structured `ask_user` question with selectable options instead of
  guessing; and the same loop with the same tools running a different provider,
  which is the evidence behind the provider-neutral claim rather than a
  restatement of it.

- **The local example names a model that exists.** `keryx shell --provider
  ollama --model llama3.1:latest` was a plausible-looking placeholder; the local
  example now uses `gemma4:e4b`, which is what the capture was actually taken
  against.

## [0.2.12] — 2026-08-04

### Documentation

- **The agent harness is now stated as a first-class part of the product.** The
  previous README mentioned it twice in passing — once as the thing `keryx shell`
  starts, once as the thing `keryx serve` is a second door into — and never in
  the first screen, the value table or the capability list. A reader could
  finish the page without learning that keryx owns an execution loop at all.

  The new section says what is in it: a provider-neutral loop over Anthropic,
  Ollama, OpenRouter and Grok plus an offline fake provider; durable per-project
  append-only sessions with resume, branching and compaction; a policy engine
  with `allow`/`ask`/`deny` over paths, commands, tools, network and resources;
  guarded mutation that is path-checked, security-scanned, approval-bound and
  evidence-recorded; kernel-enforced containment below the policy engine;
  child agents over the canonical contracts with token budgets and bounded
  parallel scheduling; an evidence ledger behind the completion gate;
  deterministic replay from recorded fixtures; and four doors — CLI, JSONL/RPC,
  TUI and loopback HTTP — onto one loop.

  Framed as the combination rather than a feature list: the harness is worth
  having *because* it reads the same `.metaproject/` context every other agent
  reads, and the context is worth having *because* something can act on it
  without rediscovering the repository first. The package's own thesis — the
  agent is ephemeral, the project brain is durable — now appears where a reader
  will meet it.

- **The first two screenshots.** `docs/assets/dashboard.png` and
  `docs/assets/shell.png`, both captured from real runs against this repository
  rather than mocked up. A tool with a TUI and a dashboard that shows neither is
  asking to be judged on prose alone.

- **The README links the documentation site** (`mrciphersmith.github.io/keryx`),
  which has been deploying on every push to `main` and was reachable from
  nowhere in the README.

## [0.2.11] — 2026-08-04

### Documentation

- **The README leads with what keryx is for, not with what it cannot do.** The
  old first screen spent its attention on absent model runtimes, empty runtime
  identifiers and non-zero exit codes — accurate, and the worst possible order
  in which to say it. A reader met the limitations of a product before its
  purpose, and concluded the product was unfinished rather than deliberate.

  The new order is: one sentence of value, the install, the problem, a table of
  what you get, a real end-to-end agent workflow, the express example, the
  `.metaproject/` tree, capabilities grouped by what you are trying to do, and
  only then requirements, optional AI features and limitations. Nothing was
  softened into untruth — the macOS-only containment tier, the missing
  approval transport, the unbundled embedding runtime and the external ripgrep
  dependency are all still stated, with the impact and the alternative next to
  each.

- **`docs/docs/limitations.md`** now holds the detail the README used to carry:
  the removed ONNX stack and the two constants that re-enable those seams, the
  five commands that need a provider credential, the platform matrix, the
  remote-approval gap and the pre-1.0 format-stability note. Linked from the
  README and the docs index, and in the site nav.

- **Two README caveats were removed because they had become false**, not
  because they were inconvenient: `security` is in `keryx modules` and can be
  toggled there, and enabling `mcp` no longer survives only until the next
  unrelated toggle — `defaultEnabled`/`enableFlag` in `src/commands/modules.ts`
  fixed that. Every command the README now shows was checked against the live
  CLI surface.

- **The npm `description` and `keywords` describe the product category** —
  version-controlled project context for AI coding agents — rather than opening
  with "metaproject workspace", a term that means nothing before the reader has
  installed the thing.

## [0.2.10] — 2026-08-04

### Changed

- **The release workflow publishes with no credential at all.** The trusted
  publisher is registered on the package (`MrCipherSmith/keryx`, `release.yml`,
  permissions `npm publish` and `npm stage publish`), so `npm publish` now
  authenticates as the OIDC identity of this workflow. The `NODE_AUTH_TOKEN`
  env block is gone and the `NPM_TOKEN` repository secret has been deleted —
  not merely left unused, because a credential nothing reads is still a
  credential that can be read.

  The bootstrap ordering is recorded in the workflow itself, because it is not
  obvious and cost four failed attempts to learn: a trusted publisher is
  configured under the **package's** settings, which means the package has to
  exist before it can be configured, which means the first publish of a new
  package cannot use it. `0.2.9` went out under a classic Automation token —
  the only token type that bypasses the 2FA prompt a CI runner cannot answer.
  A granular token obeys the account's 2FA setting and fails with `EOTP`, which
  is exactly how the third attempt died.

  Nothing published between those four failures. Every one of them stopped at a
  gate before the publish step, which is the gate working; three of the four
  were the same defect wearing different clothes — a requirement satisfied in
  one place and never written down as belonging to the suite.

## [0.2.9] — 2026-08-04

### Documentation

- **The name question is settled: `keryx` stays**, published as
  `@mrciphersmith/keryx`. Decided on evidence. Fourteen plausible single
  classical words were checked against npm and **all were taken** — that
  namespace was exhausted years ago, which is why a scope is normal practice
  rather than a workaround. And the rename was measured, not guessed: **8,554
  occurrences across 1,503 files, 621 of them file or directory names**.

  The one candidate that would have made the project better rather than merely
  different was `metaproject` — free, and already this project's own noun. Today
  it has two names for one thing: the tool is `keryx`, the thing it makes is a
  `metaproject`. Collapsing them would have been a simplification, and it was
  still not worth six hundred renames.

  The mitigation is discipline: always write the scope, because
  `npm install -g keryx` installs an unrelated project.

- **An announcement draft**, at `docs/plans/announcement-draft.md`, written to
  the plan's rules — one demonstrated thing rather than a feature list,
  boundaries stated in the post itself, prepared answers to the three questions
  that will be asked, and an explicit **what not to claim** list: no performance
  claim, not "ML-powered" (those runtimes are not shipped), not "fully
  sandboxed" without naming the tier and platform.

  It is a draft for a human to post. Nothing has been published.

## [0.2.8] — 2026-08-04

### Documentation

- **Five task-shaped guides**, organised by what a reader is trying to do rather
  than by which module implements it: give an agent context, run an agent
  without giving it your machine, drive keryx from a bot, review with a durable
  record, and run keryx in CI. They are doors into the reference, not a
  replacement for it.

  Every command shown was executed and the output is from those runs. Each guide
  ends with a verification command **and with what a misleading pass looks
  like** — a graph reporting `0 nodes` on a repository that has code, a review
  package that ingested cleanly with zero findings, a health gate passing over
  stale artifacts.

  Two things only a real run would have surfaced:

  - `keryx harness exec --allowed-domains api.example.com` produces an allowlist
    of **five** domains. The extra four are hosts of provider credentials saved
    on the machine — once a run is restricted, a masked credential's host has to
    be reachable or the mask is pointless. It is disclosed in the output, and
    the guide tells the reader to trust the effective list over the one they
    typed.
  - `security eval`'s `prompt-injection` row misses **three of eight** positives
    and is still `ok`, because its committed ceiling is `0.5`. The CI guide
    points at that row rather than the summary line: the gate does not claim the
    detector is good, only that it has not got worse than a number someone wrote
    down and can defend. Every other detector's ceiling is zero.

## [0.2.7] — 2026-08-03

### Added

- **A documentation link gate, in CI.** `bun run check:doc-links` resolves every
  relative Markdown link in the root documents and all of `docs/`, and checks
  `#anchor` fragments against the target file's headings — `file.md#missing`
  is the failure a plain existence check survives. It fails if it checked *zero*
  links, so a glob that quietly stopped matching cannot look like a clean sweep.

  `keryx wiki check-links` already covered the wiki. Nothing covered `docs/`.

- **`mkdocs.yml` and a Docs workflow.** MkDocs Material, `docs_dir: docs/docs`,
  explicit nav, Mermaid through `pymdownx.superfences`. The workflow's `build`
  job runs `mkdocs build --strict` on every pull request; `deploy` publishes to
  GitHub Pages from `main`. **The site config has not been executed locally** —
  `python3-venv` is absent on the authoring machine — so CI is its first oracle.

### Fixed

- **39 broken documentation links**, found by the gate on its first run, out of
  573 checked. Thirty-eight were one `../` too deep from
  `docs/decisions/keryx-harness/`; one pointed at a handoff document under a
  `.metaproject/jobs/` directory that does not exist — the real file lives in
  `docs/decisions/keryx-harness/`.

  A link check had been reported as passing repeatedly during this
  documentation work. It ran over a hand-picked file list, and the result was
  generalised to the repository.

## [0.2.6] — 2026-08-03

### Fixed

- **`keryx gdgraph build` was broken on every fresh install.** `init` copies a
  few `src/gdgraph/*.ts` files into `.metaproject/core/gdgraph/` so a scaffolded
  project can run the graph builder without the full toolkit. That list was
  hand-maintained, in two places, and nothing checked it against what those
  files import — so when `query.ts` gained `import … from "./target"` in
  `0.2.3`, the copied core stopped being import-closed:

  ```
  error: Cannot find module './target' from
    .metaproject/core/gdgraph/query.ts
  ```

  This is the **first "Next step" `init` prints**, and the suite stayed green
  throughout, because nothing ever ran the copied tree.

  The list is one shared constant now, and `core-sources.test.ts` computes the
  transitive closure of *runtime* imports from the entry points and asserts the
  list covers it. A new `import` in a copied file now fails a test instead of a
  stranger's first five minutes.

  Two things the guard gets right on purpose: type-only imports are excluded
  (they never reach runtime), and a `dynamic-import` is excluded because it is a
  deliberate lazy edge — `build.ts` reaches `enrich` that way *precisely* so it
  can run where `enrich` is absent, and that environment is the copied core
  itself.

### Documentation

- **The README now opens with what keryx removes, not what it contains**, and
  shows a real run on a freshly cloned `expressjs/express`: 139 nodes, 153
  edges, no cycles, and the dependency/dependent answer for `lib/express.js`.
  Every line of that output came from the run, which is also how the scaffold
  bug above was found — the walkthrough died on its second command.
- Adds **"Is this for you?"**, naming who should *not* install: people who want
  a hosted service, people on Linux who need the network allowlist, people who
  need remote approvals today, and people who expect it to do the thinking.

## [0.2.5] — 2026-08-03

### Fixed

- **Toggling any module silently deleted an enabled `mcp` from the manifest.**
  `keryx modules` knew eight of the ten modules, and a toggle re-invokes `init`
  with flags derived from that list — so the two it did not know were decided by
  the *absence* of a flag rather than by the operator.

  The two absences behaved differently, which is why one list could not describe
  both. `security` is default-**on**: no `--no-security` meant it survived, but
  it could never be disabled through this command and never appeared in
  `modules status`. `mcp` is default-**off**: `init` writes its manifest entry
  only when `--mcp` is passed, so a project with MCP enabled lost it on any
  unrelated toggle.

  Both are now in the list, and each module declares whether `init` scaffolds it
  by default. A default-off module re-sends its enable flag to survive.

  Demonstrated rather than asserted — on `0.2.4`, `init --yes --mcp` followed by
  `modules disable memory` leaves **no `mcp` entry at all**; with the fix the
  entry survives and `memory` alone changes. `modules status` now lists
  `security` and `mcp`.

### Added

- `keryx modules enable|disable security` and `… mcp` now work. `security` was
  reachable only through `init` flags before this.

## [0.2.4] — 2026-08-03

### Documentation

- **`docs/docs/architecture.md` now has five diagrams and no longer predates the
  architecture.** It was corrected rather than rewritten: most of its 310 lines
  were accurate, and replacing verified prose with new prose would have traded
  content for churn.

  The diagrams are Mermaid in Markdown, so they diff in git and need no build
  step. Every arrow is a named module or file and the decision nodes carry their
  `file:line`.

  Three of the five exist to correct something the source contradicted:

  - the system-context diagram had to stop the document saying "no HTTP server",
    which stopped being true when remote entry shipped;
  - the harness diagram is preceded by a **two-tool-systems table**, because a
    single picture of "the tool loop" is false in both directions — the durable
    `ToolExecutorPort` returns an `outputHash` and structurally cannot feed a
    live model, while the `InteractiveTool` layer the shell runs returns content.
    And no shipped path registers a tool at all;
  - the containment diagram makes the **macOS/Linux split structural**, because
    Tier 2 does not degrade on Linux — it refuses.

  The remote-entry diagram draws the nine-step ordered decision path rather than
  listing it, because `serve-turn.ts:3-7` states that *the order rather than the
  set is the control*.

- The module map gained eight missing rows — harness, sandbox, tui, session,
  serve, projects, metrics, contracts — plus a module-versus-command
  discriminator. A module has a manifest entry, a manifest file and a
  `src/<feature>` behind a verb; `review`, `serve`, `orient` and `sync` have none
  of that. Listing `serve` as a module was an error introduced in `0.2.0`.

- Layer 1 is described as the `CLI_ROUTES` table it is, not the "flat if-chain"
  it stopped being.

## [0.2.3] — 2026-08-03

### Fixed

- **`keryx ctx rg "pattern" src/one-file.ts` reported `(unknown)` and `0:0` for
  every hit.** ripgrep omits the filename whenever it is given a single explicit
  file path, which breaks the `file:line:col:text` shape `parseRgMatches`
  requires — so agents were handed matches they could not locate.
  `--with-filename` now joins the base argv unconditionally; it is a no-op for
  the multi-path and directory cases. (PR #211)
- **The code graph was under-resolving edges on this repository.** After the
  gdgraph fixes the same tree yields **1,873 edges against 1,397 before**, from
  649 nodes. (PR #211)
- Entropy and PII detector corrections, with fixture cases. (PR #211)

### Added

- **CI installs ripgrep.** One test spawns the real binary to prove ripgrep
  emits `file:line:col` for a single explicit path — an oracle about an external
  tool. Skipping it when the tool is absent would have left the assumption
  unverified while the job stayed green, so the tool is installed instead. This
  is what the pull request's red check actually was.

### Note on the merge

PR #211 was opened on 2026-07-26 and sat behind 24 commits. `buildRgCommand` had
been rewritten on `main` in the meantime to allowlist ripgrep flags — a caller's
`--pre=…` had reached arbitrary command execution through the one operation
agents are told to prefer over raw grep — and it now returns a result rather
than an argv. Both changes were kept: the security structure from `main`, the
`--with-filename` fix from the branch, asserted together so neither can be
dropped while the other still passes.

## [0.2.2] — 2026-08-03

### Security

- **A credential that merely exists no longer chooses the network posture of an
  unrelated command.** `keryx harness exec` decided "restricted network" from
  the count of mask inject-hosts. Those come from masks resolved against every
  provider key in the environment *and* in the user-global `auth.json` — so a
  saved key for a provider the command never touches silently widened the run to
  restricted networking with TLS termination on macOS, and blocked the command
  outright on Linux, where `restricted` is refused. The same
  `harness exec -- /bin/echo hi` worked or failed depending on whether an
  unrelated key existed on the machine.

  The posture is now decided by `resolveNetworkRestriction`, which takes the
  operator's intent and nothing derived from the environment: credentials are
  not a parameter, so they cannot reach the decision. Inject hosts still join
  the allowlist once a restricted run has been asked for — they no longer cause
  one.

  The five ways an operator can ask are a discriminated union with a total
  `switch`. The exhaustiveness was **verified, not assumed**: planting a sixth
  member fails `tsc` with `TS2366`. Nine unit tests cover each way, the fixed
  precedence, and the empty-list cases — `--allowed-domains ""` is not a request
  to restrict with no domains.

## [0.2.1] — 2026-08-03

### Security

- **The egress allowlist is now enforced inside terminated TLS tunnels.**
  Previously the allowlist was checked against the CONNECT target only. Once TLS
  termination was on, the decrypted request's `Host` header chose the upstream
  and was never re-checked — so a contained process could CONNECT to an
  allowlisted host and then address any other host from inside the tunnel. No
  decision was recorded for that inner hop either, so the egress was invisible
  in the reported rulings.

  The inner `Host` is now matched against the allowlist and passed through
  `decide(...)`, which closes both the bypass and the blind spot. Real
  credentials were never exposed — masks filter on their own inject-hosts — so
  this was a containment and observability failure, not a disclosure one.

  It ships with **a planted counter-example**: a test that sets a foreign `Host`
  inside the tunnel and asserts the refusal. Affects macOS only, because TLS
  termination is macOS only. (PR #210)

### Added

- **A macOS real-host CI job** covering the OS sandbox and the TUI pty launch.
  Until now the platform where the allowlist, credential masking and TLS
  termination actually run was the platform with no live containment test.
  (PR #210)

### Documentation

- A verification step in a flow plan is a task, not a sentence (PR #221).
- `shared-definitions` for the rules library, so places that agree connect by
  import instead of by restatement (PR #222).

## [0.2.0] — 2026-08-03

The first release since `v0.1.0`, covering 570 commits: the OS sandbox, the
agent harness and multi-agent engine, the OpenTUI shell, and the remote entry.

### Changed — packaging (read this before upgrading)

- **The npm package is now `@mrciphersmith/keryx`.** The unscoped name `keryx`
  on npm belongs to an unrelated, actively maintained project
  ([actionhero/keryx](https://github.com/actionhero/keryx)) — installing it gets
  you a different program. Install with:

  ```bash
  npm install -g @mrciphersmith/keryx
  ```

  The executable is still `keryx`; no command changes. The `curl` and `bun`
  installers described in the README are unaffected.
- `prepack` was removed. `prepare` alone builds `dist/`, so packing no longer
  runs the build twice (flagged in the 2026-07-10 readiness report).

### Added — remote entry (`keryx serve`)

- **A loopback-bound HTTP entry over the agent harness**, off by default. Bearer
  authentication compared in constant time, with only a salted hash persisted;
  `serve token issue | rotate | revoke`. Authentication runs *before* routing, so
  an unauthenticated caller cannot distinguish a known path from an unknown one.
  `refused` binds no socket at all — it is never a degraded listen.
  (R4b, flow 128, PR #216)
- **`POST /v1/turns` — remote turn submission with SSE streaming.** Idempotency
  keys are scoped per project, so two projects cannot collide on one key; turn
  records are durable; the remote policy profile is compared against the local
  one and may never be weaker; authentication failures are throttled. An `ask`
  decision terminates in a **recorded denial** — approvals are a later slice.
  (R4c, flow 133, PR #220)
- **`keryx projects` — a user-global project registry**, populated by
  `keryx init`, with `list | register | forget`. Nothing on the machine knew the
  project set before this. (R4a, flow 127, PR #215)

### Added — sandboxing and containment

- **A kernel-enforced OS sandbox under the policy engine:** workspace-write
  filesystem boundaries and secret read-deny via macOS Seatbelt and Linux
  bubblewrap, with network off / on / restricted. No new npm dependencies.
- **A loopback domain-allowlist proxy** reporting allow/deny rulings, plus opt-in
  TLS termination for HTTPS masking. Both are macOS-only and **refuse to run on
  Linux** rather than degrading to full host network.
- **Credential auto-masking**, defaulting to `auto` when the restricted sandbox
  is on, resolved env → project → global → built-in. Secrets come from the
  user-global `auth.json` only.
- **Harness hardening:** mask-without-TLS fails closed, spawn failures carry
  structured diagnostics (the exit-71 class), and a portable deep-probe script
  ships with a report schema.

### Added — the agent harness and multi-agent orchestration

- **A full execution loop** (`src/harness/`): append-only session store, an
  allow/ask/deny policy engine, a tool registry, a provider port with fake,
  Anthropic and Ollama adapters, resume and recovery, branching and compaction,
  guarded mutation with approval, replay, budget and monitoring.
  CLI: `keryx harness run | exec | extension | wave`.
- **Subagent orchestration**, reachable today through the interactive shell's
  spawn tool: a fail-closed child-model resolver, a policy-gated provider
  allowlist, depth and count caps against one shared run-scoped budget ledger
  including the cost dimension, and child-output injection quarantine (which
  flags, and never rewrites, child text).
  - Child containment rests on three things together: `shell_exec` is absent
    from a child's tool list, the child policy denies it, and the approver is
    hard-false.
- **Implemented and tested, but not yet wired to any caller:** cost-aware model
  escalation, git-worktree isolation, bounded peer messaging, and the
  orchestrator-state fold. Each of these modules is imported by exactly one file
  — its own test. They are extension points, not behaviour you get today.
  Scoped per-child credentials are in the same position: the provider option
  exists and is tested, but no production path passes it, so a live child reads
  the ambient environment.
- **A typed `MetaprojectPort`** with published schemas, so the harness, the
  interactive agent and the MCP server reach graph/wiki/memory/context in-process
  from one source instead of through subprocess wrappers.

### Added — interactive shell

- **A full-screen OpenTUI shell is now the default when `stdout` is a TTY**,
  replacing the line-based renderer; `--no-tui` and a graceful readline fallback
  remain. Adds a live `/` command composer, a persistent composer region,
  per-block collapse, and framed markdown with code and diff rendering.

### Added — observability

- **Provenance-aware execution metrics:** active-time accounting, per-run
  evidence, baseline-aware CI and a retry taxonomy. *No performance claim has
  been made* — the paired Keryx/no-Keryx protocol exists to make one honestly.

### Added

- Language-aware gdgraph import resolution: Java (Maven/Gradle source roots,
  fully-qualified-name → file mapping) and Python (dotted modules, `__init__.py`
  packages, and relative `from . import x`) source now produce real dependency
  edges instead of nodes-only graphs. TypeScript/JavaScript resolution is
  unchanged (byte-identical graph output). Seeds the Java/Python tree-sitter
  grammars on `init`/`update`.
- Symbol-aware graph navigation with `gdgraph find`, `symbol`, `path`,
  symbol-aware `affected`, and transitive caller impact via `symbol --impact`.
- Deterministically pinned tree-sitter grammar assets and explicit symbol-layer
  enable/disable/status commands.
- Hierarchical wiki collection with full module coverage, code-to-wiki backlinks,
  symbol-kind annotations, and an explicit draft-enrichment work front.
- Turn-start graph + wiki orientation hooks for Claude, Codex, and Cursor.
- Multi-runtime gdctx routing guards for Claude, Codex, Cursor, Windsurf,
  OpenCode, and other supported harnesses.
- Managed review packages for standalone reviews, flow-attached reviews, report
  ingestion, coverage tracking, decisions, and learning handoff.

### Changed

- Graph symbol resolution now disambiguates loose names and resolves cross-file
  calls before computing callers and impact.
- Agent bootstrap rules enforce the Metaproject hard gate before project work.
- Model-backed features remain opt-in, while deterministic fallbacks and asset
  availability are surfaced more clearly.
- The shipped `@xenova/transformers` runtime was removed, reducing the optional
  dependency footprint by roughly 230 MB; compatible transformer-style adapters
  can still be configured explicitly.

### Fixed

- Natural-language graph queries now redirect to the correct `find`, `ctx rg`,
  and `affected` workflow instead of silently producing low-value output.
- Wiki/code relationships and symbol caller graphs no longer under-report common
  cross-file references.
- gdgraph import-resolution metric no longer reports a false `100%` when zero
  imports were extracted (a `0/0` denominator); it reports `n/a` instead, and
  non-relative imports that fail to resolve are recorded as `unresolved` edges
  rather than silently dropped.

### Security

- The agent shell allowlist is a **boundary, not a string match**; the
  destructive risk class is wired into the shell approval gate; an approval is
  bound to the action it approves; and the agent can no longer grant itself
  shell permissions.
- Subagent isolation is pinned and a child's summary is bounded.
- Search argv is separated and caller-supplied paths are contained.
- Six adversarial review rounds on the remote-entry branch produced twelve
  blockers, all closed. Their single common cause is recorded as a durable
  lesson: [branching on a value whose domain you never wrote down](.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md).

### Documentation

- Refreshed public, developer, CLI, architecture, module, onboarding, workspace,
  and release-readiness documentation for the post-`v0.1.0` feature set.

### Known gaps

Recorded here rather than in a release announcement, because they are the things
a reader would otherwise discover by hitting them.

- **Approvals over the remote entry are not implemented.** Until they are, a
  remote turn that needs one is denied and the denial is recorded.
- **`GET /health` and cross-process liveness are absent.** No PID file exists, so
  `keryx serve status` reports configuration state only; `listening` and
  `draining` are knowable only over the authenticated `GET /v1/status`.
- **The domain allowlist, credential masking and TLS termination are macOS-only**
  and refuse to run on Linux rather than silently weakening.
- **`pii: { action: "allow" }` still redacts** — an open question about the
  policy resolver, not the detector.
- **The source-pattern guards in `src/lib/config-dir.ast.ts` are heuristics, not
  closures**, and carry a written list of known gaps as executable tests.

## [0.1.0] — 2026-07-10

First tagged release. `keryx` installs a deterministic, local, offline,
git-diffable `.metaproject/` workspace of agent-facing tooling, with an opt-in
capability seam for model/embedding features (disabled = byte-identical, zero
runtime dependencies, no sockets).

### Core modules

- **gdgraph** — code graph, symbols, and affected context. Parser-backed import
  resolution (`Bun.Transpiler.scanImports`, regex fallback), N-hop transitive
  `affected`, token-budgeted `repomap.md`, and an opt-in tree-sitter symbol layer.
- **gdctx** — token-aware wrappers for search, reads, diffs, and command output.
- **gdwiki** — project knowledge base. Deterministic `collect` derives real
  per-module signals (dependencies, key files by connectivity, entry points,
  exported symbols) as prose-first drafts; an agent enrich workflow fills the
  understanding on a cheap model; `collect --changed` for incremental runs.
- **gdskills** — bundled working skills plus project-skill create/route/verify/
  learn lifecycle, schema-governed orchestration (`subagent-dispatch` →
  `subagent-result`, STATUS protocol), and a `docpack-orchestrator` for
  requirements packages.
- **health** — aggregated code health, scoring, quality gate, and a
  churn × complexity hotspot signal.
- **testing** — test context, related-test selection, normalized reports, and an
  opt-in coverage-map TIA with an always-on smoke tier.
- **memory** — long-lived project memory with bitemporal facts, memory typing,
  optional local embedding rerank, and `--as-of`/`--class` search.
- **tasks (flow)** — agent-first flow lifecycle: frozen acceptance criteria,
  a strict status state machine, PR-gated completion (AC + PR checks + health +
  security), tracker adapters (`gh`), and natural-language discovery.

### Platform

- **Metaproject Standard** — `standard validate|doctor|capabilities|emit`, a
  self-describing manifest, and profiles.
- **MCP interop** — `keryx mcp serve [--http]`: a stdio-first server mapping
  Tools to `createXService()` methods and Resources to read-only artifacts;
  `llms.txt` and gdskills plugin export.
- **Metaproject Security** — agent input/output/artifact security: secrets, PII,
  prompt-injection and exfiltration/egress detection with HMAC-keyed hashing,
  safe redaction, a config-integrity self-protect, write-seam gates, multi-runtime
  hooks, and a red-team eval harness (advisory by default).
- **Capability seam** — `resolveCapability(id) → Adapter | null`, `optionalDependencies`
  + lazy import, deterministic fallback as a tested path, and an asset resolver
  (`assets.lock.json`, `assets list|verify|pull`).

### Tooling & UX

- `keryx init` / `update` / `modules` / `dashboard` — TTY-aware styled output
  (banners, module status, next steps) that degrades to clean plain text off-TTY.
- **Human dashboard** — a dark-first, navigable HTML admin view with a health-score
  ring, module cards, an "Attention" section, a Tasks/flows summary, and an in-page
  markdown modal for every linked `.md`.

### Reliability

- Atomic `.metaproject` writes (temp + rename) so a crash never corrupts a
  single-source-of-truth file.
- File locks (dependency-free, atomic `mkdir`) around flow mutations and gdskills
  manifest/learn read-mutate-write, so concurrent AI-agent sessions never lose
  updates.
- Serialized `process.chdir` in tests — no cross-file cwd races.

[0.1.0]: https://github.com/MrCipherSmith/keryx/releases/tag/v0.1.0
[0.2.0]: https://github.com/MrCipherSmith/keryx/compare/v0.1.0...v0.2.0
[0.2.1]: https://github.com/MrCipherSmith/keryx/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/MrCipherSmith/keryx/compare/v0.2.1...v0.2.2
[0.2.3]: https://github.com/MrCipherSmith/keryx/compare/v0.2.2...v0.2.3
[0.2.4]: https://github.com/MrCipherSmith/keryx/compare/v0.2.3...v0.2.4
[0.2.5]: https://github.com/MrCipherSmith/keryx/compare/v0.2.4...v0.2.5
[0.2.6]: https://github.com/MrCipherSmith/keryx/compare/v0.2.5...v0.2.6
[0.2.7]: https://github.com/MrCipherSmith/keryx/compare/v0.2.6...v0.2.7
[0.2.8]: https://github.com/MrCipherSmith/keryx/compare/v0.2.7...v0.2.8
[0.2.9]: https://github.com/MrCipherSmith/keryx/compare/v0.2.8...v0.2.9
[0.2.10]: https://github.com/MrCipherSmith/keryx/compare/v0.2.9...v0.2.10
[0.2.11]: https://github.com/MrCipherSmith/keryx/compare/v0.2.10...v0.2.11
[0.2.12]: https://github.com/MrCipherSmith/keryx/compare/v0.2.11...v0.2.12
[0.2.13]: https://github.com/MrCipherSmith/keryx/compare/v0.2.12...v0.2.13
[0.2.14]: https://github.com/MrCipherSmith/keryx/compare/v0.2.13...v0.2.14
[0.2.15]: https://github.com/MrCipherSmith/keryx/compare/v0.2.14...v0.2.15
[0.2.16]: https://github.com/MrCipherSmith/keryx/compare/v0.2.15...v0.2.16
[0.2.17]: https://github.com/MrCipherSmith/keryx/compare/v0.2.16...v0.2.17
[0.2.18]: https://github.com/MrCipherSmith/keryx/compare/v0.2.17...v0.2.18
[0.2.19]: https://github.com/MrCipherSmith/keryx/compare/v0.2.18...v0.2.19
[0.2.20]: https://github.com/MrCipherSmith/keryx/compare/v0.2.19...v0.2.20
[0.2.21]: https://github.com/MrCipherSmith/keryx/compare/v0.2.20...v0.2.21
[0.2.22]: https://github.com/MrCipherSmith/keryx/compare/v0.2.21...v0.2.22
[0.2.23]: https://github.com/MrCipherSmith/keryx/compare/v0.2.22...v0.2.23
[0.2.24]: https://github.com/MrCipherSmith/keryx/compare/v0.2.23...v0.2.24
[0.2.25]: https://github.com/MrCipherSmith/keryx/compare/v0.2.24...v0.2.25
[0.2.26]: https://github.com/MrCipherSmith/keryx/compare/v0.2.25...v0.2.26
[0.2.27]: https://github.com/MrCipherSmith/keryx/compare/v0.2.26...v0.2.27
[0.2.28]: https://github.com/MrCipherSmith/keryx/compare/v0.2.27...v0.2.28
[0.2.29]: https://github.com/MrCipherSmith/keryx/compare/v0.2.28...v0.2.29
[0.2.30]: https://github.com/MrCipherSmith/keryx/compare/v0.2.29...v0.2.30
[0.2.31]: https://github.com/MrCipherSmith/keryx/compare/v0.2.30...v0.2.31
[0.2.32]: https://github.com/MrCipherSmith/keryx/compare/v0.2.31...v0.2.32
[0.2.33]: https://github.com/MrCipherSmith/keryx/compare/v0.2.32...v0.2.33
[0.2.34]: https://github.com/MrCipherSmith/keryx/compare/v0.2.33...v0.2.34
[0.2.35]: https://github.com/MrCipherSmith/keryx/compare/v0.2.34...v0.2.35
[0.2.36]: https://github.com/MrCipherSmith/keryx/compare/v0.2.35...v0.2.36
[0.2.37]: https://github.com/MrCipherSmith/keryx/compare/v0.2.36...v0.2.37
[Unreleased]: https://github.com/MrCipherSmith/keryx/compare/v0.2.37...HEAD
