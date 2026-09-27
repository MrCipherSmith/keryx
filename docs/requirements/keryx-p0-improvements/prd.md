# PRD: Keryx P0 Improvements

Version: 0.1.0

## Problem

keryx's position in the market is a layer of durable project knowledge and
managed work above any coding agent, plus a harness of its own. The
competitive review ([competitive-review.md](competitive-review.md)) found the
position sound and the proof thin in one place and the basics missing in four:

- **The one capability nobody else has is unproven.** `keryx agents external
  run` dispatches Claude Code, Codex or Gemini CLI as a read-only child in a
  disposable worktree. `docs/docs/harness.md:175` says: "Nothing here has ever
  been run against a real vendor process." A reader who checks stops trusting
  the rest of the page.
- **No file rewind.** A turn that edits the wrong files can be undone only
  with git by hand. Claude Code (`/rewind`), Gemini CLI (`/restore`), Kiro and
  OpenCode snapshot files per turn. keryx's `flushSessionCheckpoint` saves the
  transcript, not the tree.
- **Review lives on the laptop.** keryx's review has more machinery than any
  competitor's — several reviewers, a verifier that deletes findings it cannot
  reproduce, findings anchored to a quoted line, price per round — and no way
  to run on a pull request without a person at a terminal. Cursor Bugbot ships
  one number ("70 %+ of flags resolved before merge"); keryx cannot produce
  its own.
- **No remote approval.** `docs/docs/limitations.md:179`: a remote turn whose
  policy decision is `ask` ends in a recorded denial. Triggers and schedules
  therefore only work for turns that never need a human, which is the
  opposite of when a human most wants to be asked.
- **The first hour is rough.** `keryx doctor` is "Unknown command" followed by
  the full usage while `mcp doctor`, `integrations doctor` and `standard
  doctor` exist; `keryx mcp list` exits 1 because `~/.cursor/mcp.json` is
  malformed; `keryx memory search "release"` finds nothing and does not
  mention `--semantic`; `keryx health run` on keryx itself reports the test
  source missing.

## Goal

Within one release train: the external-agent claim is backed by recorded live
runs; a turn's file changes can be rewound; a pull request can be reviewed by
keryx unattended with the verifier's status visible; a remote or scheduled
turn can ask a human and get an answer; the first five commands a new user
types do what they expect.

## Users

- **Evaluators** comparing keryx with Claude Code or Codex in their first
  session (W2, W5).
- **Operators who delegate** part of a task to a vendor CLI they already pay
  for (W1).
- **Teams with a PR flow** who want a reviewer that verifies before it posts
  (W3).
- **Operators running triggers, schedules or `keryx serve`** from a phone or a
  chat channel (W4).
- **keryx's own docs**, which must stop saying "never run" (W1).

## Requirements

### W1 — External agents run for real

- W1.1 A recorded live run per registered agent (`codex-cli`, `claude-cli`,
  `gemini-acp`) against the real CLI, on a fixture task, with the transcript
  committed under `fixtures/external/live/<agent>/<date>/` and replayed by the
  existing offline tests.
- W1.2 The live run is repeatable: `bun run external:live <agent>` (env-gated,
  skipped without the CLI on PATH) — and a CI job on a self-hosted or
  credentialed runner runs it weekly.
- W1.3 `--write` mode: the child's patch from the worktree is presented as a
  reviewable diff; applying it to the operator's tree is a separate,
  approval-gated step that runs the managed review first.
- W1.4 The "never run" sentences in `docs/docs/harness.md` and the README are
  replaced with the date, versions and outcome of the recorded runs.
- W1.5 Failures found by the live runs are fixed or recorded in the ledger
  before W1 closes.

### W2 — `/rewind`

- W2.1 Before each agent turn that may write, keryx records a snapshot of the
  working tree (tracked and untracked, respecting `.gitignore`) in a shadow
  repository under the session directory, keyed by turn.
- W2.2 `/rewind` lists the last N turns with their file deltas; choosing one
  restores the tree to that snapshot and truncates the transcript to that
  turn, as one operation with one confirmation.
- W2.3 `/rewind --files-only` and `--transcript-only` are available.
- W2.4 `keryx sessions rewind <id> <turn>` does the same from outside the
  shell.
- W2.5 Snapshots are bounded: per-session size cap and age cap, configurable;
  `keryx sessions list` shows snapshot size.
- W2.6 The TUI shows a "rewind" affordance in the plan sidebar and the
  session picker; readline has `/rewind`.

### W3 — Review as a GitHub Action

- W3.1 `keryx review run --pr <n> | --ref <range>` runs the review
  orchestrator headless: reviewer selection, reviewers, verifier, ingest —
  producing a review package and a JSON summary.
- W3.2 A composite GitHub Action (`MrCipherSmith/keryx-review@v1`) that installs
  keryx, runs W3.1, and posts findings as inline PR comments with the
  verifier's disposition and the review package id.
- W3.3 The action never posts a finding the verifier could not confirm; those
  go to a collapsed "unverified" section.
- W3.4 Re-runs on new commits update the same comments and mark findings
  resolved when the anchored line no longer exists.
- W3.5 `keryx review metrics --repo` computes "findings resolved before merge"
  from the recorded packages.
- W3.6 Spend per run is capped by the action input; the cap is a hard stop.

### W4 — Remote approval

- W4.1 An approval request is a record: id, turn, tool, risk class, summary,
  expiry. `keryx serve` and trigger dispatch write it instead of a denial when
  a transport is configured.
- W4.2 Transports: the helyx channel (Telegram), a `keryx approvals` CLI on
  another machine, and the `keryx serve` HTTP surface. One approval is one
  single-use grant, as today's interactive grants.
- W4.3 Expiry produces a denial with reason `approval-expired`; the turn
  continues on the denied path.
- W4.4 Every request and answer lands in the governance report with who
  answered and from which transport.
- W4.5 The credentials hard floor is unchanged: no transport can approve a
  credential-class action.

### W5 — First hour

- W5.1 `keryx doctor`: one page — version, Bun, ripgrep, sandbox launcher,
  providers with credentials (never the values), MCP servers, integrations
  drift, stale worktrees, `.metaproject` freshness — each line green, yellow
  or red with the command that fixes it.
- W5.2 Unknown command or subcommand: one line, up to three "did you mean"
  suggestions, and the exact help command; never the full usage.
- W5.3 `keryx mcp list` exits 0 when it listed the servers it could; foreign
  config errors are a warning block; exit 1 only when the project's own config
  is unreadable.
- W5.4 `keryx memory search`: stemming and simple synonym expansion in lexical
  mode; when zero hits and embeddings exist, the output says
  `--semantic` is available; when embeddings do not exist, it says how to
  build them.
- W5.5 `keryx health run` sees `bun test` and coverage on a tree where `bun`
  is on PATH only (shared with audit remediation G-3).
- W5.6 Bare `keryx providers` prints the status summary, not usage.

## Success criteria

- W1: three committed live transcripts; the two doc sentences gone; the weekly
  job green for two consecutive runs.
- W2: in a session that edited five files over three turns, `/rewind 1`
  restores the tree and transcript in under two seconds; snapshot storage for
  a 200-turn session stays under the cap.
- W3: the action runs on keryx's own PRs for two weeks; zero unverified
  findings posted as verified; the metric is computed.
- W4: a trigger turn that needs approval is answered from Telegram and
  completes; an unanswered one expires and is recorded.
- W5: `keryx doctor` runs on a fresh clone in under three seconds;
  `keryx docto` suggests `doctor`; `mcp list` exits 0 with a malformed foreign
  config; `memory search release` on the keryx tree returns hits or names the
  `--semantic` path; health on the keryx tree reports `tests: available`.

## Risks

- **W2 storage and speed.** A shadow repo per session on a large monorepo can
  be slow and big. Mitigation: snapshot only paths the turn touched plus
  `git status` deltas; cap and prune; measure on a 100k-file tree before
  choosing.
- **W2 semantics with the session lease.** Rewinding a session another shell
  holds must be refused (lease), and rewinding must not cross a `/new`.
- **W3 cost and noise.** A PR action that spends money on every push needs the
  cap (W3.6) and a "changed lines only" default scope.
- **W4 is a security surface.** An approval transport is a way to say yes from
  outside the machine. Requests must be unforgeable (signed with the serve
  token), single-use, expiring; the transport never carries tool arguments
  that could hold secrets — a redacted summary only.
- **W1 depends on vendor CLIs that change weekly.** The recorded runs are
  dated; the weekly job is what keeps the claim honest.
- **W5 touches `cli.ts`**, which source-text tests read (`backlog.md` item 11).

## Recommendation

Order: **W5 → W1 → W2 → W3 → W4.** W5 is a week of small, safe changes that
improve every demo. W1 is evidence for the strongest claim and finds real
bugs. W2 is the most-requested table-stakes feature and self-contained. W3
builds on the review machinery that exists and creates the public artifact
(the action) that shows it. W4 is the largest design surface and benefits from
W3's headless runner and W1's unattended runs existing first.

One flow per workstream, each with frozen acceptance criteria from
[specification.md](specification.md) §8.
