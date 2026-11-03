# Context

Collected deterministically by `keryx flow init` at 2026-11-02T07:11:16.780Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.573] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.564] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
3. [1.526] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.488] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
5. [1.488] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`

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

### herdr-core / Herdr app facts (verified against upstream source, 2026-11-02, hc 0.1.16 installed locally)

- Status is OSC 7501 only (`herdr-core/CONTRIBUTING.md`: no per-agent integrations or hooks).
  Wire format, from `crates/herdr-core/src/status.rs` `Status::encode`:
  `ESC ] 7501 ; state=<w>[:id=<id>][:kind=<k>][:progress=<0..100>][:app=<name>][:title=<b64>][:msg=<b64>] ESC \`
  (BEL terminator also parsed). States: `idle working done blocked error`, plus `clear`
  (removes the record). `kind` (blocked only): `permission question auth`. `title`/`msg` are base64.
  Parser test strings: `\x1b]7501;state=working:app=claude-code:progress=40\x1b\\`,
  `\x1b]7501;state=blocked:kind=permission:id=a/b:msg=QXBwbHk/\x07`.
- A turn ends whenever the root record leaves `working` (`status.rs` `end_turn`); `hc wait`,
  `hc send --wait` and child notifications are built on it. `blocked`/`error` = "stuck":
  hc notifies the parent.
- Herdr app: `done` = finished while the user wasn't looking, the app turns it into `idle`
  once someone looks, with sound + toast (`herdr-app/defaults/AGENTS.md` "Agents").
- Env inside an hc terminal: `HC_TERMINAL_ID` (the address, e.g. `t7`), also `HC_SOCKET`,
  `HC_TERMINAL_SOCKET`, `HC_SCOPE` (`herdr-app/scripts/bench.py`). No `HERDR_*`.
- Templates `~/.config/herdr-core/templates/<name>.md` (`herdr-core/docs/templates.md`):
  frontmatter `command` (required), `description`, `ready` (default: wait for the first 7501
  report, 30 s, then leave the screen alone and report `first_message.sent=false`; `quiet` =
  wait for output to settle), `submit`, `stop`, `paste_gap_ms`. Body + task are typed as the
  first message.
- Child messages arrive as typed input: `<hc from="t7 review">…</hc>` (child report) or
  `<hc from="t3 lead" reach="hc send t3 when done or stuck">task</hc>` (task from a parent).
  hc manual: treat as agent messages, not user instructions.
- `herdr-app/defaults/programs.json` (120 entries) has no `keryx`. User overrides in
  `~/.config/herdr-app/programs.json` `{programs:{<id>:{name,icon,tint,tile,color,match,run}}}`;
  invalid file → `programs.error`; icon path relative to `~/.config/herdr-app`, not in `icons/`
  (Herdr-owned). `run` puts the agent into the "+" menu (`knownAgents()`).
- herdr-core security: anyone who can connect to the core socket can run commands with the
  user's access; sockets under `$XDG_RUNTIME_DIR/herdr-core/` or `~/.local/state/herdr-core/<session>/`;
  `HC_SESSION=<name>` + scratch `XDG_STATE_HOME`/`XDG_CONFIG_HOME` give an isolated core for tests.

### keryx code (context-collector report, worktree at origin/main 2026-11-02)

- Old reporter: `src/tui/herdr-report.ts` (env `HERDR_ENV/HERDR_PANE_ID/HERDR_SOCKET_PATH`,
  JSON `pane.report_agent` over the pane socket). Created `src/tui/tui-shell.ts:4524`, reported
  from `setMainAgent` `:5664-5679` (`herdr.report(herdrStateFor(status))` at `:5678`), released `:11446`.
- `herdrStateFor` (`herdr-report.ts:93-100`) also feeds the agent bus join (`tui-shell.ts:7675-7678`);
  bus vocabulary is `idle working blocked held` (`src/bus/schema.ts:42`), asserted by
  `src/tui/tui-bus.test.ts:512-521`. ⇒ `done`/`error` must come from a NEW herdr-core mapper;
  `herdrStateFor` stays as is.
- Status call sites: queued `:5681` (launch, after chrome mount + input focus at `:4918`) and
  `:7910` (`/new`, `/clear`); running `:5784 :5823 :5847 :5852 :5860 …`; done/failed `:11009`,
  failed `:5864` (budget/error); blocked for every approval (`:5574` external spawn,
  `:6246 :6287 :6419 :6492 :6573 :6654`, `:6751` shell_exec with `cmd`, `:6879` telegram) and
  `ask_user` `:6953` (question `req.question`, card body `:6972`). The `detail` string is only
  "approval"/"ask" — the command/question text is NOT carried into setMainAgent today.
- Resume picker (`opts.session?.pickOnStart`) can run after the first `queued` (`:4914` comment).
- `keryx shell` has NO initial-prompt argument: `parseShellCliFlags` `src/commands/shell.ts:3505-3624`
  throws `Unknown shell argument` (`:3622`); `-p/--print` is headless one-shot (`:3603`).
- Readline fallback (`runAgentRepl` `shell.ts:4806`) does not use the herdr reporter.
  Debug env list `shell.ts:3862-3864` (only in `--debug` `session.start` event).
- OpenTUI (`@opentui/core`): `useThread` defaults true except Linux; keryx does not set it
  (`src/tui/shell-chrome.ts:610-621`). Frames are written by the native thread. A private
  `renderer.writeOut(chunk)` exists (`renderer.d.ts:382`) and, when threaded, goes through native
  `lib.writeOut`, ordered with frame output; otherwise `realStdoutWrite`. No public raw-write API.
  A bare `process.stdout.write` may interleave with a frame (unverified) ⇒ use `writeOut` when present.
- Subagents: `spawn_subagent` internal children run in-process; external children
  (`src/harness/external/`, registry codex-cli/claude-cli/antigravity-cli/gemini-acp) parse stdout
  lines through `ExternalSpawnPort` (`supervise.ts:65-110`) — a terminal-hosted hc child has no clean
  stdout, so an hc-backed port is NOT a small change (out of scope, see plan).
- OS sandbox for interactive `shell_exec` is opt-in (`KERYX_SANDBOX_SHELL`,
  `.metaproject/wiki/architecture/os-sandbox.md` "Entry Paths and Defaults"). When on, Seatbelt
  emits `(deny network*)` + write-deny outside workspace (`src/harness/process/sandbox/seatbelt.ts:73-74`)
  ⇒ `hc` cannot reach the core socket from a sandboxed shell. Opening the socket inside the sandbox
  would be a full sandbox escape (core runs anything unsandboxed) ⇒ never do it.
- Precedent for writing another tool's home config: `keryx skills sync --global`
  (`src/gdskills/sync.ts:49-141`: refuses if the harness home dir is missing, `dryRun`, manifest,
  opt-in, never from `keryx update`); merge-safe JSON edit in `src/mcp/client-config.ts`
  (`readSettings` throws on invalid JSON `:438-451`, idempotent managed entries, `writeContained` is
  project-root-only). No backup step exists anywhere yet.
- Command registry: `src/standard/command-registry.ts` `COMMAND_DESCRIPTORS` (`:76`), entry shape
  `:60-70`, example `:100-119`; keep `json: true` honest.
- Tests: `src/tui/herdr-report.test.ts` mutates `process.env` with before/after restore and injects
  the writer through `createHerdrReporter(clock, connect)`.
- No wiki page mentions herdr. Icon: `vscode-extension/media/keryx.svg` (24×24, `currentColor`
  glyph → suits `tint: true`).
