# Specification: Keryx P0 Improvements

Version: 0.1.1

## 0. Status

Specification written; nothing implemented. Every command, flag and file
named below that is not marked *(exists)* is planned.

## 1. Module identity

| W | Module(s) | New or changed |
|---|---|---|
| W1 | `harness/external` *(exists)*, `fixtures/external` *(exists)* | live fixtures, `external:live` script, write-mode apply step |
| W2 | `session` *(exists)*, `commands/shell`, `tui` | new `session/snapshot.ts`, `/rewind`, `sessions rewind` |
| W3 | `review` *(exists)*, `commands/review` | new `review run`, `review metrics`; new repo `keryx-review-action` |
| W4 | `harness/policy` *(exists)*, `commands/serve` *(exists)*, `trigger` *(exists)* | new `approvals/` module, `keryx approvals` CLI, transports |
| W5 | `cli`, `commands/mcp-servers`, `memory`, `health/sources`, `commands/providers` | `doctor`, did-you-mean, exit semantics, search, detection |

## 2. Storage structure

- W1: `fixtures/external/live/<agent>/<YYYY-MM-DD>/{transcript.jsonl,
  outcome.json, versions.json}`; `versions.json` records the vendor CLI
  version, keryx version, OS.
- W2: `<session dir>/snapshots/` — a bare git repository (`git init --bare`)
  used as a shadow store; one commit per turn, message `turn <n>`; a
  `snapshots.json` index `{turn, commit, files[], bytes, at}`. Never touches
  the project's `.git`.
- W3: review packages as today under `.metaproject/reviews/` or the flow;
  the action uploads the package as a workflow artifact. `metrics.json` per
  repository under `.metaproject/data/review/metrics/`.
- W4: `.metaproject/data/approvals/<id>.json` — request and answer; appended
  to the governance ledger.
- W5: none new.

## 3. Manifest / config shape

- W2: `shell.rewind: { maxSnapshotBytes: 512MiB, maxAgeDays: 14, enabled:
  true }` in the shell config *(planned)*.
- W3: action inputs `pr`, `scope: changed|full`, `spend-cap-usd`, `post:
  inline|summary|none`, `provider`, `model`.
- W4: `serve.approvals: { transport: "helyx"|"cli"|"http", expiresSeconds:
  900 }`; `trigger` entries may set `approvals: inherit|deny`.
- W5: none.

## 4. CLI / skill surface

### W1

- `bun run external:live <agent> [--task <text>]` — runs the real CLI on the
  fixture task, records under the storage path, then replays through the
  offline runner and diffs the outcome. Skips with a clear message when the
  CLI is absent or `KERYX_EXTERNAL_LIVE=1` is not set.
- `keryx agents external run <id> --write` *(exists)*: the patch stays
  never-applied, as today.
- `--apply` *(planned)* on the same command: after the run, presents the
  patch, runs `keryx review run --ref <patch>` (W3.1) and, on an approval in
  the shell, applies it with `git apply --3way`.

### W2

- `/rewind` — list; `/rewind <turn>` — restore both; `/rewind <turn>
  --files-only | --transcript-only`; `/rewind --status` — snapshot size.
- `keryx sessions rewind <id> <turn> [--files-only|--transcript-only] [--yes]`.
- TUI: plan sidebar row "↶ rewind" opens the same list; session picker shows
  snapshot size.

### W3

- `keryx review run (--pr <n> | --ref <range>) [--scope changed|full]
  [--reviewers auto|<list>] [--verify] [--json] [--spend-cap <usd>]` — headless
  orchestration; exit 0 clean, 3 findings, 2 spend cap hit.
- `keryx review metrics [--repo] [--since <date>] [--json]`.
- GitHub Action `MrCipherSmith/keryx-review@v1` (separate repository) with the
  inputs from §3.

### W4

- `keryx approvals list|show <id>|approve <id>|deny <id> [--reason]` — from any
  machine holding a serve token.
- helyx transport: a card with summary, risk class, expiry; two buttons.
- `keryx serve` HTTP: `GET /approvals`, `POST /approvals/<id>` (signed).

### W5

- `keryx doctor [--json]`.
- Unknown command output: `Unknown command: docto. Did you mean: doctor? Run
  \`keryx --help\` for the list.`
- `keryx mcp list` exit codes: 0 listed; 1 project config unreadable; foreign
  config problems printed under `warnings:`.
- `keryx memory search` output gains a trailing hint line on zero hits.
- `keryx providers` bare = `keryx providers status`.

## 5. Data contracts

No `schemas/*.json` yet by decision: the shapes below are first drafts and
each workstream is its own flow. The flow that implements a workstream adds
its schema under `schemas/` and links it from this section when the shape is
frozen — the same order `keryx-agent-bus` followed.

- W1 `outcome.json`: `{agent, task, exit, durationMs, filesTouched[],
  usage?, cost?, keryxDecisions[]}` — the same shape the offline runner
  returns today *(exists: `ExternalRunOutcome`)*.
- W2 `snapshots.json` entry: `{turn: number, commit: string, files: string[],
  bytes: number, at: ISO}`; `/rewind` result event in the session transcript:
  `{kind:"rewind", toTurn, files, transcriptTruncatedAt}`.
- W3 action summary JSON: `{packageId, reviewers[], findings[{id, file, line,
  severity, verified: true|false|skipped, disposition}], spendUsd,
  resolvedBeforeMerge?: number}`.
- W4 approval record: `{id, createdAt, expiresAt, sessionId, turn, tool,
  risk, summary (redacted), transport, answer?: {by, at, decision, reason},
  signature}`. `summary` passes `redactSensitiveText`; tool arguments are
  never included.
- W5 `doctor --json`: `{checks: [{id, status: ok|warn|fail, detail, fix?}]}`.

## 6. Integration points

- W1 ↔ audit remediation R2/R3: live runs exercise the external env strip
  (#770) for real.
- W2 ↔ session lease (`keryx-agent-bus` §6): rewind refuses when the session
  is leased elsewhere; `/new` starts a new snapshot store.
- W3 ↔ flow: `--flow <id>` attaches the package to the flow as `review
  attach` does today *(exists)*.
- W3 ↔ Jev: `jev-select` chooses reviewers when enabled *(exists)*;
  `--reviewers auto` uses it.
- W4 ↔ policy engine: the `ask` decision gains an `awaiting-approval` state
  with expiry; headless default without a transport stays `deny` *(exists)*.
- W4 ↔ governance report *(exists)*: approvals section.
- W5 ↔ `keryx integrations doctor`, `mcp doctor`, `standard doctor`
  *(exist)*: `keryx doctor` calls them and aggregates.

## 7. Security requirements

- W3: the action runs with the repository's `GITHUB_TOKEN` only; provider
  credentials come from secrets and are never echoed; the review package
  artifact passes `check-output` before upload.
- W4: requests are signed with the serve token; answers are verified; a
  credential-class action is never requestable; the transport carries the
  redacted summary only; every answer is attributed.
- W2: snapshots inherit the project's ignore rules so ignored secrets files
  are never copied into the shadow store; the store lives under the session
  directory with the session's permissions.

## 8. Acceptance criteria

- AC1 (W1): `fixtures/external/live/` holds one dated run per registered
  agent; the offline replay of each matches its recorded outcome; `bun run
  external:live` skips cleanly without the CLI; the two "never run" sentences
  are gone from `docs/docs/harness.md` and README.
- AC2 (W1): `--write --apply` shows the patch, runs the headless review, and
  applies only after an approval; without approval the tree is unchanged.
- AC3 (W2): after three writing turns, `/rewind 1` restores every file to its
  turn-1 state, removes files created later, and the transcript ends at turn
  1; `--files-only` leaves the transcript.
- AC4 (W2): a session leased by another shell refuses `sessions rewind`;
  snapshot storage stays under the cap over 200 turns; ignored files are not
  snapshotted.
- AC5 (W3): `keryx review run --pr <n> --json` on a PR with one planted defect
  returns exit 3 and the finding with `verified: true`; a planted false
  positive appears with `verified: false` and is not posted inline.
- AC6 (W3): the action, on a re-push that fixes the defect, marks the comment
  resolved; `keryx review metrics` reports it as resolved before merge.
- AC7 (W4): a `keryx serve` turn with an `ask` decision produces an approval
  record; approving from `keryx approvals` on another machine completes the
  turn; the governance report shows who and from where.
- AC8 (W4): an unanswered request expires and the turn ends on the denied
  path with `approval-expired`; a credential-class action never produces a
  request.
- AC9 (W5): `keryx doctor` exits 0 on a healthy tree and lists every check
  with a fix hint on a broken one; `keryx docto` suggests `doctor` in one
  line; `keryx mcp list` exits 0 with a malformed `~/.cursor/mcp.json` and
  prints it under `warnings:`.
- AC10 (W5): `keryx memory search release` on the keryx tree returns hits
  (stemming) or prints the `--semantic` hint; `keryx health run` on the keryx
  tree reports `tests: available`; bare `keryx providers` prints status.
