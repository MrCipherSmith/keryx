# Self-learning loop

`keryx learn` turns what actually happens in your agent sessions into
durable, reviewable knowledge — without ever storing a transcript, and
without ever mutating a skill, rule, agent, or memory file except through a
human-typed command at a real terminal.

## The pipeline

```
observe  ->  extract  ->  review / accept  ->  apply (or reviewer apply)  ->  promote  ->  graduate  ->  prune
```

- **Observe.** A hook or `keryx learn observe` appends redacted, digest-only
  events to a daily JSONL file. Nothing is interpreted yet.
- **Extract.** `keryx learn extract` runs five deterministic signals (plus an
  optional, disabled-by-default model extractor) over the observation window
  and writes/updates `status: candidate` records.
- **Review / accept.** A human reads a candidate with `keryx learn review
  [<id>]` and decides with `keryx learn accept <id>` or `keryx learn reject
  <id>` — both require a real terminal.
- **Apply.** An accepted, non-`review-conventions` record becomes a
  project-skill proposal via `keryx learn apply <id> --skill <module/name>`.
  An accepted `review-conventions` record becomes a reviewer-profile `.mdc`
  via `keryx review learn --reviewer <id>`.
- **Promote.** A project-scope accepted record that has independently
  reinforced across enough distinct projects can be promoted to a user-scope
  candidate with `keryx learn promote <id>` — itself requiring its own later
  accept.
- **Graduate.** `keryx learn graduate` clusters accepted, reinforced records
  into a graduation *proposal*; a human applies it separately.
- **Prune.** `keryx learn prune` deletes observation files past their TTL and
  expires candidates nobody decided about in time.

Every arrow above except **Observe** and **Extract** requires a human to type
a command; **Observe** and **Extract** never write a decision or mutate a
skill, rule, agent, or memory file — see [What is observed, and what is
never stored](#what-is-observed-and-what-is-never-stored) and [Consent
guarantees](#consent-guarantees) below.

## CLI reference

| Command | Effect |
|---|---|
| `keryx learn observe [--hook claude]` | Without `--hook`, reports today's observation file line count (manual/offline use). With `--hook claude`, reads one host-hook payload from stdin, maps it to an observation event, always exits `0`, and prints nothing — the command an opt-in Claude Code hook runs. |
| `keryx learn extract [--domain <d>] [--since <YYYY-MM-DD>] [--json]` | Runs the deterministic signals (and, if enabled, the model extractor) over the observation window, writing/updating `status: candidate` records. |
| `keryx learn list [--status <s>] [--domain <d>] [--scope <s>] [--json]` | Lists records with filters. |
| `keryx learn review [<id>] [--scope <s>]` | Prints one candidate, or all candidates, with its evidence, for a human to read before deciding. |
| `keryx learn accept <id> [--scope user] [--refresh]` | `status: candidate -> accepted`. Terminal-only; project scope also writes one index entry (see [Cross-project index and promotion](#cross-project-index-and-promotion)). `--refresh` overwrites only the current project's index entry, without changing status. |
| `keryx learn reject <id> [--scope user]` | `status: candidate -> rejected`. |
| `keryx learn apply <id> --skill <module/name> [--dry-run]` | Renders the accepted record as a `LearningProposal` and calls the existing `applyLearningProposal` — the only writer under `.metaproject/project-skills/`. |
| `keryx learn promote <id>` | Terminal-only; see [Cross-project index and promotion](#cross-project-index-and-promotion). |
| `keryx learn graduate [--domain <d>]` | Clusters accepted records and writes a graduation proposal. |
| `keryx learn graduate apply <proposal-id>` | Terminal-only; writes an agent candidate. A skill-target proposal is not applied by this command — see below. |
| `keryx learn prune [--dry-run] [--json]` | Deletes observation files past their 30-day TTL and expires candidates past `ttl.expiresAt`. |
| `keryx review learn --reviewer <id> [--dry-run]` | Applies an accepted `review-conventions` record as a reviewer-profile `.mdc` — the reviewer-profile sibling of project-skill `apply`. |

`accept`, `promote`, and `graduate apply` never take a `--yes` / `--force` /
`--non-interactive` flag: each refuses outright outside a real interactive
terminal, with a named reason, and there is no bypass. None of the three is
reachable through MCP — an agent cannot accept, promote, or graduate its own
learned pattern; only the human at the terminal can.

A graduation proposal whose cluster resolves to an **agent** target is
applied directly by `keryx learn graduate apply`, writing
`.metaproject/agents/<name>.md` with `origin.kind: "learned"` and
`sourceRef` set to the source pattern's `id`. A proposal that resolves to a
**skill** target is not applied by this command at all — it prints the
equivalent invocation of the existing W1 scout/record path for a human to
run:

```
keryx skills scout <name-or-description> --record <dir> --origin learned --source-ref <id>
```

## What is observed, and what is never stored

Observation is deliberately shallow. Each observation event is one line of
JSON appended to `.metaproject/data/learning/observations/<YYYY-MM-DD>.jsonl`
(one file per UTC day):

| Field | Contains |
|---|---|
| `event` | One of `tool-start`, `tool-complete`, `tool-failed`, `user-prompt`, `session-start`, `turn-stop`, `session-end` |
| `inputDigest` | sha256 of the tool input — never the raw input |
| `inputPreview` | First 200 chars of the (redacted) tool input |
| `outputPreview` | Same bound and redaction, tool-complete/tool-failed only |
| `cwdHash` | sha256 of the resolved cwd — never the raw path (a path can carry a username) |
| `edit` | Optional, present only for a file-editing tool call: `{ pathDigest, removedDigest, addedDigest }`, each a sha256 hex digest — never the raw path or diff content |
| `sessionId`, `toolUseId`, `project`, `observedAt` | Session/project bookkeeping, no content |

What this rules out by construction:

- **No transcripts.** No full tool input, no full tool output, no prompt
  text, no file content, no diff content — only sha256 digests and 200-char
  redacted previews.
- **Redaction before write, not after.** Every `*Preview` field passes
  `keryx security check-output` before it is written; a finding (secret,
  credential, …) replaces the preview with `"[redacted:<category>]"` rather
  than dropping the event, so the event still counts for extraction.
- **Bounded storage.** 200 chars per preview field, 5000 events per daily
  file (further events roll to the next UTC-boundary file early), and a
  30-day TTL: `keryx learn prune` deletes an observation file 30 days after
  its date.
- **Gitignored.** `.metaproject/data/learning/observations/` and
  `.metaproject/data/learning/candidates/` are in `.gitignore` and in
  `keryx init`'s managed ignore block — neither ships in your repository.
- **Off switch.** `KERYX_LEARNING=off` makes both the manual `keryx learn
  observe` path and the host-hook `--hook claude` path no-ops; nothing is
  appended.

### Opt-in host observer (Claude Code)

An opt-in `learning-observer` surface (flag `observe`) lets a Claude Code
hook call `keryx learn observe --hook claude` on every tool and session
event (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`,
`SessionStart`, `Stop`, `SessionEnd`), mapping Claude's own hook payload
shape onto the same observation event shape used everywhere else. Install it
with either the flag or the surface id:

```
keryx integrations install --runtime claude --surface observe
# or, equivalently:
keryx integrations install --runtime claude --surface learning-observer
```

It is opt-in by design (plan decision D5): installing the `claude` runtime
with no `--surface` never installs this observer, the same way the `agents`
surface is opt-in — only naming its flag or id does. It shares
`.claude/settings.json` with the ctx-guard/orient/security-check surfaces,
composing by sentinel so none of them clobber each other's hook entries. The
command it installs, `keryx learn observe --hook claude`, always exits `0`
and prints nothing to stdout, so it never affects Claude's own control flow —
regardless of what happens inside the observation sink.

## The confidence model

Every learned-pattern record carries a numeric `confidence` in `[0, 1]`,
derived from fixed, documented constants — never a runtime-tunable
parameter:

| Constant | Value |
|---|---|
| Seed, deterministic extractor | `0.4` |
| Seed, model-backed extractor | `0.3` |
| Reinforcement rate | `0.35` |
| Contradiction rate | `0.5` |
| Decay rate | `0.02` per day |
| Max evidence weight | `1.5` |

Each new evidence item updates confidence:

```
confidence' = clamp(
  confidence + (kind == "reinforcement"
    ? (1 - confidence) * 0.35 * weight
    : -confidence * 0.5 * weight),
  0, 1
)
```

Worked example: a deterministic candidate seeds at confidence `0.4`. One
reinforcement at `weight: 1.0` moves it to exactly `0.61`
(`0.4 + (1 - 0.4) * 0.35 * 1.0`).

Decay runs once per whole UTC day with no new evidence:
`confidence' = confidence * (1 - 0.02) ^ days`.

`confidenceLevel` is derived, never authored directly:

| Level | Range |
|---|---|
| `low` | `< 0.5` |
| `medium` | `0.5 <= confidence < 0.8` |
| `high` | `>= 0.8` |

At confidence `0.61` the example above is `medium`.

## Project identity

A learned pattern's `project` field is a stable identity that survives a
clone or a rename:

1. If the project has a git remote, `identity` is a sha256 hash of the
   **normalized** remote URL (protocol, credentials, trailing `.git`, and
   case differences are all stripped or lowercased first, so the same
   conceptual remote hashes the same way regardless of how it is spelled).
2. Otherwise, `identity` falls back to a sha256 hash of the resolved
   (symlink-free) worktree root path.

`identityKind` records which of the two applied (`"remote-hash"` or
`"path-hash"`); an optional `displayName` is review-UI-only and is never used
for identity comparison or dedup.

## Cross-project index and promotion

Accepting a `scope: project` record additionally writes one entry —
`{projectIdentity, identityKind, confidence, acceptedAt}` — under that
pattern's `id` in `~/.keryx/learning/index.json`. Accepting a `scope: user`
record changes only its own status; it writes no index entry.

A pattern becomes eligible for promotion once its `id` has independently
reinforced in **two or more distinct project identities**, each indexed at
`confidence >= 0.8`. `keryx learn promote <id>` then:

- refuses outright in a non-TTY context, with a named reason, and has no
  bypass flag;
- refuses a fixture with only one qualifying identity, even when run
  interactively, with its own named reason;
- uses each identity's **indexed, accept-time** confidence, not the live
  source record's current confidence — so a record that has since decayed or
  been contradicted in one project does not silently retro-qualify;
- requires typing the pattern's id back to confirm; and
- on success, writes a new `scope: user`, `status: candidate` record under
  `~/.keryx/learning/patterns/` — never an automatic `accepted`. The promoted
  candidate needs its own human accept at user scope, same as any other
  candidate.

`keryx learn accept --refresh <id>` is the one way to update an already
-indexed entry: it overwrites only the current project's own entry with the
source record's live confidence, without changing `status`.

## Consent guarantees

- **Terminal-only mutation.** `accept`, `promote`, and `graduate apply` each
  refuse outside a real interactive terminal, with a named reason, and none
  accepts a bypass flag (`--yes`, `--force`, `--non-interactive`, …). None of
  the three is exposed through MCP, so an agent cannot drive them on its own.
- **Decisions log.** Every human action that changes a record's status
  appends one line to `.metaproject/data/learning/decisions.jsonl` (or the
  user-scope equivalent): `{schemaVersion, action, id, scope, actor, tty:
  true, at}`. `action` is one of `accept`, `reject`, `refresh`, `promote`,
  `graduate-apply`.
- **`accepted` is unforgeable.** `keryx learn accept` is the only code path
  that can produce `status: "accepted"` — the store itself refuses an
  `accepted` write from any other caller. `extract`, `prune`, `promote`, and
  the graduation pipeline never produce `accepted`.
- **The exit guard.** `auditAcceptedRecords` flags any accepted record (either
  scope) that has no matching `accept` decision in its scope's log — the
  property a CI test pins so nothing can reach `accepted` silently.
- **Injection and secret scanning.** Every candidate's `trigger`, `action`,
  and evidence text is scanned before it is persisted, and again before
  `apply` / `graduate` / reviewer-profile writes. Injection-shaped text
  (e.g. "ignore previous instructions…") and secrets are refused outright —
  never stored, not even redacted.
- **Path boundaries.** `accept` refuses any target outside
  `.metaproject/data/learning/` or `~/.keryx/learning/`; project-skill
  `apply` refuses outside `.metaproject/project-skills/`; reviewer-profile
  `apply` refuses outside `.metaproject/rules/reviewers/`; `promote` refuses
  outside `~/.keryx/learning/`.

See also the skill-lifecycle amendment in
[`.metaproject/rules/core/skill-lifecycle.mdc`](../../.metaproject/rules/core/skill-lifecycle.mdc)
("Passive observation is not mutation"): a hook may append an observation
event, and nothing more — extraction, accept, apply, promote, and graduate
are all agent-loop, human-triggered work, never hook-triggered.

## Reviewer profiles

A `domain: "review-conventions"` candidate, extracted from comments by an
author configured in `.metaproject/review-learning.config.json`'s
`reviewerProfiles` list, carries an opaque `reviewerProfile.reviewerId` —
`"rv-"` plus 16 hex characters of a per-project hash of the login. The login
itself is never stored in the rendered file:

- `reviewerIdFor(projectIdentity, login)` is a one-way hash; the same login
  hashes differently per project, and there is no reverse mapping.
- `generalizeLesson()` strips `@mentions`, every configured login
  (case-insensitive, word-bounded), and first-person/courtesy phrasing before
  a comment becomes trigger/action text.
- `keryx review learn --reviewer <id>` renders `.metaproject/rules/reviewers/
  <id>.mdc` and refuses to write output containing any configured login.
- `reviewerProfiles` in the review-learning config must be a subset of
  `authors` — a login cannot be profiled unless it is already a recognized
  review author.

## Model extractor capability (disabled by default)

`keryx learn extract` can, in principle, run a model-backed extractor
alongside the five deterministic signals (`repeated-correction`,
`reverted-edit`, `failing-to-passing-test`, `reviewer-comment`,
`health-regression`). It refuses to run unless explicitly enabled in
`.metaproject/learning.config.json`:

```json
{
  "schemaVersion": 1,
  "capabilities": { "modelExtractor": false }
}
```

No model-backed extractor implementation ships with this release — the
capability gate exists, but `modelExtractor: true` currently enables a port
with nothing behind it. The deterministic core never depends on this file
existing; an absent or malformed config is equivalent to every capability
disabled.

## File layout

| Path | Scope | Contents |
|---|---|---|
| `.metaproject/data/learning/observations/<YYYY-MM-DD>.jsonl` | project | Append-only observation events (gitignored, 30-day TTL) |
| `.metaproject/data/learning/candidates/<id>.json` | project | Every project-scope record, any status (gitignored) |
| `.metaproject/data/learning/decisions.jsonl` | project | Append-only human decision log |
| `.metaproject/data/learning/graduation/<proposal-id>.json` | project | Graduation proposals |
| `.metaproject/data/learning/learn.lock` | project | File lock for the writers above |
| `.metaproject/learning.config.json` | project | Model-extractor capability gate (optional, absent = disabled) |
| `.metaproject/review-learning.config.json` | project | Reviewer-comment learning config: `skill`, `repo`, `authors`, `reviewerProfiles` |
| `~/.keryx/learning/patterns/<id>.json` | user | Promoted (user-scope) records |
| `~/.keryx/learning/index.json` | user | Cross-project accept-time index, keyed by pattern `id` |
| `~/.keryx/learning/decisions.jsonl` | user | User-scope decision log |
| `~/.keryx/learning/learn.lock` | user | File lock for the user-scope writers above |

See also: [W3 — Self-Learning Loop](../requirements/keryx-agent-platform-expansion/workstreams/W3-self-learning.md)
(the design spec this page tracks) and
[`learned-pattern.schema.json`](../requirements/keryx-agent-platform-expansion/schemas/learned-pattern.schema.json)
(the record schema).
