# Changelog

All notable changes to `keryx` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.3.65] — 2026-10-02
### Added
- **Slate as working memory (flow 393).** On a host that keeps the originals (`pruneArchive`) with a live session directory, the model no longer re-reads its own history: each request is a bounded one. The slate gains two shelves, both task-local and never promoted to workspace knowledge. The **Trail** is written by the harness, never by the model: one entry per executed tool call (step, tool, argument digest, outcome, path of the saved full output). **Notes** are the model's own working notes, set, replaced or deleted by key with the new `slate_note` tool, redacted, at most 2000 characters each and 8000 tokens for the shelf; a note never becomes a Seed. Older rounds leave the request in batches and `archive.jsonl` keeps them; one rebuilt slate frame (Anchors, the latest Trail entries, every Note) stands in for them, with the tool-call and result pairing kept valid. The system instruction states the contract (older rounds leave the request, facts belong in Notes), and one notice per batch names the steps before they are dropped.
- **Point recall.** `slate_trail` (filter by file, tool or step range), `recall_step` (the full saved output of a step, paged) and `history_search` (search this session's archive) are read-only and confined to the live session.
- **Notes and Trail digests are data, not instructions.** The frame puts them in a delimited untrusted-data section, and secrets are redacted before they are stored.
- **ObservationPack.** A tool result over 10 KiB stays verbatim for two requests, then becomes a fixed pack (size, head, tail, the reference to read it back), applied in the same batch as the other rewrites.
- **Cache-cost-aware rewrites.** A rewrite of the sent history applies only when its saving exceeds the cost of re-billing the invalidated prefix; plan-step boundaries are preferred, and each decision is logged.
- **`shell_exec` no longer cuts the tail.** Output past the inline cap is saved in full through the spill path (stdout and stderr both). The model sees the head, the tail, the line and byte counts of each stream, the last part of stderr whatever else is dropped, and the path to read the rest with `read_file` or `search_code`. It used to keep the first 20 KB, which dropped stderr first.
- Replay of the flow 394 long-session shape on a bounded request: peak request 40,428 tokens (limit 64,000) and 2,969,506 tokens in total (limit 5,531,077), against 96,783 and 7,374,769 before; the numbers are in the flow journal.

### Changed
- Prune thresholds scale with the window: protect = min(40K, 30% of the window), batch saving = min(20K, 15%), so pruning fires before compaction on 32K to 272K windows.
- Hosts without `pruneArchive` behave exactly as after 0.3.64 and never write a Trail into a slate another holder owns. `slate_read` only gains fields; Seeds are still never injected and `renderAnchorsBlock` is unchanged.

[Changes since 0.3.66](https://github.com/MrCipherSmith/keryx/compare/v0.3.66...v0.3.65)

## [0.3.68] — 2026-10-03
### Changed
- **A Telegram turn now runs like a shell `trust` turn (flow 396).** Before, every tool call from a topic asked, the run was stopped after 30 minutes and an unanswered question lapsed after 5 minutes. Now the default is `permissionMode: trust`: ordinary commands in the project run without a question, and each one is recorded as an `approval` event with the Telegram user id. The floors still ask exactly as in a local trust turn: destructive commands, privilege escalation, downloaders, agent credential files, flow and acceptance confirmations, a git publish lease, a hook that asks, untrusted content, a destructive `apply_patch` and MCP `use_tool`. `/plan` still refuses mutations, and `apply_patch` outside the project root is refused in every mode. There is no Telegram-only floor for network or outside-project commands.
- **No run limit by default, and `/stop`.** `runTimeoutMs` is now optional with no default; `0` or absent means no timer, a positive value still stops the run. `/stop` in the topic ends the run, and the topic is told `Stopped by you.` when the turn has ended.
- **A 15-minute approval wait.** The question in the topic waits 15 minutes by default (`approvalTimeoutMs`, 30000 to 3600000); when it lapses the command is refused and the message says so. This is the Telegram path only: the HTTP serve approval expiry (`approval.expirySeconds` in `serve.json`) is unchanged.
- **One permission mode.** The config's `permissionMode` (`ask` or `trust`, default `trust`) applies until `/mode` changes the shell's mode in that session; after that the shell's mode wins. `/mode ask` from the topic runs directly, `/mode trust` and `/mode auto` keep the Yes / No button (one tap commits them; the shell's own `auto` confirmation is asked only when it is typed in the shell), and `auto` is never taken from the config. The shell shows `trust (Telegram default)` or `ask (shell /mode)`.

### Added
- **An `Always` button on a Telegram approval** (`Allow | Always: <pattern> | Deny`), with the same pattern validators as the shell dock; the topic says `Remembered: <pattern>`. A press from someone who is not allowed, a press after expiry and a replayed press save nothing and approve nothing. Saved and session patterns approve a matching command without a question, with the same exclusions as the dock.
- **`keryx permissions list|remove` and `/permissions`** list and take back the saved rules. `/remote-policy [mode ask|trust] [limit none|<minutes>] [wait <minutes>]` changes the saved defaults and the running shell's copy. The full-screen shell has a Telegram group in `/settings`, a posture line in the sidebar (a click opens `/permissions`) and a `/permissions` modal; the readline shell prints a table. `keryx serve status` and `--json` print the posture with the number of allowed users and no ids or secrets, and say when the shell's `/mode` overrides the default.
- Audit lines for auto-approved calls, Always saves and refused presses carry no secrets. A saved-rule auto-approval names the Telegram user too.
- A Telegram turn's trust follows that turn: the approval channel, mode, auto-approval record and MCP grant rule are handed to the foreground facade of the turn the bridge took as a Telegram turn, not read from a bridge-wide flag, so other work running in the shell at the same time is judged by the shell's mode and asked in the shell. `spawn_subagent` is auto-approved under `trust` in a Telegram turn, as in a shell `trust` turn, and there is no run limit by default (`/stop` ends a run; `runTimeoutMs` brings a limit back); the operator accepted both.
- Review hardening: an MCP `use_tool` always asks in a Telegram turn even with a local trusted-tool grant; Always is never offered for a command over the pattern limit (no fallback to `git *`), a cut prompt, or a pattern redaction would change; a cut prompt says how much was shown; an unknown or malformed approval answer is a deny.

### Rollback
To get the 0.3.64 behaviour back, set these keys in `remote/config.json`: `"permissionMode": "ask"`, `"runTimeoutMs": 1800000` and `"approvalTimeoutMs": 300000`. A config without the new keys now means `trust`, no run limit and a 15-minute wait; a config that already holds `runTimeoutMs` or the other keys is read as it was.

[Changes since 0.3.67](https://github.com/MrCipherSmith/keryx/compare/v0.3.67...v0.3.68)

## [0.3.67] — 2026-10-02
### Fixed
- **Approval answers from Telegram are confirmed by the shell (flow 397).** A press on Allow or Deny used to end the message "Allowed by user N at ..." (or "Denied by ...") as soon as `serve` had written the answer to the shell's stream, whether or not the shell ever got it. The shell now acks each approval frame over the new `POST /v1/remote/approval-ack`, and the ack says whether the decision was applied to a live question in the shell (`applied: true` or `false`), not only that the frame arrived; `serve` waits 5 seconds (`approvalAckMs`) and then ends the message "Allowed by user N at ..." or "Denied by ..." with an applied ack, "Not applied at <time>: the shell was no longer waiting for this question, so the Allow from user N changed nothing." with `applied: false`, or "Sent to the shell at <time>, not confirmed; the shell denies by itself if it did not receive it." without it, with a matching short reply. Not confirmed means serve did not hear back in time, not that the answer was lost: a shell that never received an Allow lets its own question time out as a denial, while one that received it after the 5 seconds still applies it and the topic keeps saying not confirmed. A repeated press during the wait does nothing, a closed stream stops the wait at once, a late ack changes nothing, and an id that is unknown or belongs to another session is a 404. A frame with no question waiting (a stale id, a question the shell already gave up on, a reconnect) is not applied: it is parked for at most 2 seconds, because a frame can beat the response that names its id, and is acked applied only if a question claims it in that time, otherwise as not applied; the transcript says "arrived but nothing here was waiting for it; not applied" and never "allowed from Telegram". An ack without `applied`, from a shell older than this field, is read as received-only and ends the message as before. The shell acks a repeated frame again with the same outcome but applies it once, shows a notice in the transcript when an approval frame is settled, and counts answers whose ack has not gone through as "Approvals not confirmed: N" in `/remote-control` and "<topic> · N unconfirmed" in the sidebar row.
- The shell's wiring between its message queue, session switches, turn stream and the remote-control bridge moved from `tui-shell.ts` into `src/tui/remote-queue-wiring.ts` and is tested against a real bridge: a Telegram line that is edited keeps its source, a removed one is reported to its topic, a session switch leaves no Telegram line in the queue, and narration said before a tool call is never sent as the answer.

[Changes since 0.3.66](https://github.com/MrCipherSmith/keryx/compare/v0.3.66...v0.3.67)

## [0.3.66] — 2026-10-02
### Added
- **Backfilled decisions in the recommendation journal.** `keryx decisions import <file.jsonl> [--dry-run] [--json]` loads historical decisions (one JSON object per line: `id`, `at`, `flow`, `stage`, `question`, `options`, `recommendation`, `source`, `answer`, `reason`) as the "before" arm of a comparison with the live records. Each is written as an open record marked `backfilled` with its `source`, never blind (ordinary mode, the recommendation marked when there is one, options in the given order), then an answer record (first answer, not changed, time to answer 0, stamped with the time the question was asked) and a reason record when one is given. A line that cannot be read (not JSON, a duplicate option id, a recommendation or an answer that is not an option unless `answer.other` is set) is skipped, named with its line number and why, and counted (`, malformed: M` is appended to the summary only when there are any); the rest is imported. An id already in the journal is skipped and reported, so a second import changes nothing, except that a backfilled decision whose answer is missing from the journal (an interrupted write) gets just that answer (`, repaired: R`). A journal whose last line was cut short is ended with a newline before the batch is appended. With `--json` a failure is `{"error": "..."}`. It prints `Imported: N, skipped: S, with recommendation: R, answered: A, deviations: D`.
- **The report keeps them apart.** `keryx decisions report` has a block "до (историческое, дозаполнено задним числом)" with the total, the decisions that had a recommendation, the matches and their share, and every deviation with its reason; the ordinary and blind shares, the stages, the irreversible counts and the new median time to answer count only live decisions, because a backfilled time is unknown. `--json` has a `backfilled` section, and `report --line` prints one line in Russian for the daily message (`Журнал решений: всего N (до: B, после: L). Совпадение с рекомендацией: видимая X% (a/b), скрытая Y% (c/d); до: Z% (e/f).`, `нет данных` for an empty share).
- **Backfilled decisions are not editable through the journal API.** `decisions answer` and `decisions reason` by id refuse a backfilled decision, as `/decisions change` does.
- **Two imports at once cannot duplicate a decision.** `keryx decisions import` reads the known ids and appends under a lock file next to the journal (`journal.jsonl.lock`: pid, time, token). A second run waits; a lock whose process is gone, or that is older than a minute, is broken; it is released when the run ends. A dry run takes no lock.
- **The shell knows the difference.** A bare `/decisions change` or `/decisions reason` never picks a backfilled decision, the `/decisions` modal shows the block, and the sidebar row counts them apart (`10 decisions + 60 before`).

### Fixed
- The CHANGELOG-entry test of the Telegram rendering docs pinned `package.json` to 0.3.64, so it failed on the next release; it now checks the entry itself and that the package is at or past that version.

[Changes since 0.3.64](https://github.com/MrCipherSmith/keryx/compare/v0.3.64...v0.3.66)

## [0.3.64] — 2026-10-02
### Added
- **Telegram rendering through the current Bot API (flow 395).** Replies to a Telegram topic are rendered in one of four modes, the new optional `rendering` key of `remote/config.json`: `auto` (the default), `rich`, `html` and `plain`; any other value is refused with a message naming the valid ones. In `auto` a reply that holds a table is sent as a native rich message (`sendRichMessage`, and `editMessageText` with `rich_message` for an edit; Bot API 10.1 to 10.3, `blocks` input); every other reply stays on the HTML path of 0.3.63. A table is never sent as raw pipes: HTML gets an aligned `<pre>` block with the separator row dropped, rich gets a native table block. Ordered lists keep their numbers, nested bullets keep their indentation, task items show a box or a ticked box, and a rule shows as a line, in HTML and in rich. Text with none of these renders byte for byte as in 0.3.63, with one exception: a link whose visible text reads as a web address for a different host than its target (`[https://mybank.example](https://evil.example)`) shows the target host after it, ` (→ evil.example)`, in HTML and in rich; every other link is unchanged.
- **Fallback chain.** A rich message refused with a 4xx is sent once as HTML, and HTML refused with "can't parse entities" is sent once as plain text; a reply is never dropped for its format. A 403, 404 or 405 pauses rich messages for ten minutes. Network errors, 5xx and 429 are retried by the durable queue as before. Each fallback is recorded with its step, a redacted reason and the time.
- **Splitting** still gives numbered `(i/n)` parts within the limit of the mode in use (32768 characters and 500 blocks for rich); a table is never cut inside a row and its header is repeated at the top of the next part.
- **Surfaces.** `/settings` has a **Telegram rendering** row (with `/rendering [mode]` in the shell), the `/channels` modal shows the mode in effect and the last fallback, and `keryx remote format-sample` prints the fixed sample reply in every mode with no network (`--mode`, `--full`, `--json`).
- The Bot API facts the rich path was built against, each with its source anchor, are in `docs/requirements/keryx-telegram-rendering/spike.md`. The live probe against a real bot is still pending operator acceptance.

[Changes since 0.3.63](https://github.com/MrCipherSmith/keryx/compare/v0.3.63...v0.3.64)

## [0.3.63] — 2026-10-02
### Fixed
- The managed ignore block that `keryx init` and `keryx update` write now covers `.metaproject/data/decisions/`, so the recommendation journal no longer shows up in `git status` of a project that uses keryx (this repository already ignored it by hand).

[Changes since 0.3.62](https://github.com/MrCipherSmith/keryx/compare/v0.3.62...v0.3.63)

## [0.3.62] — 2026-10-02
### Added
- **Recommendation journal.** Every agent question with options now writes one record to `.metaproject/data/decisions/journal.jsonl`: the flow and stage, the question, the options, the recommendation and its reason, the display mode, the option order, the human's choice, the time to answer and an optional reason for deviating. The recommendation is written before the question is shown. One question in three is asked blind (no "recommended" mark, random order) and the recommendation is revealed right after the answer; a blind question is never used for anything on the irreversible list, which has two tiers: strong terms (release, publish, unpublish, deploy, delete, push and their Russian equivalents) always count, weak terms (merge, drop, remove, force and the like) count only next to a risk target such as main, production, a branch or a table in the same question or option, or in the `--action` tag, which agents should pass for anything irreversible; the list is extendable in `.metaproject/decisions.config.json`. A changed answer after the reveal keeps both entries (`/decisions change <option>`); after a deviation the TUI asks the human once for an optional reason and the `ask_user` tool result waits for the answer (no timeout; an empty or skipped answer is recorded as absent and releases the wait), and the reason can be added or changed later with `/decisions reason <why>` or `keryx decisions reason`; `/decisions reason|change` act on the latest decision of this session (or flow), name it, and say that a changed answer may not reach the agent. Free text is collapsed to one capped line. A flow inferred from the single in-progress flow is recorded as `inferred` and marked in the report. `keryx decisions report` prints the match share by mode and stage and the deviations with their reasons, with no model call. Any agent can drive the journal with `keryx decisions open|answer|reason`. The shell has a `/decisions` report modal and a sidebar row. Journaling itself never blocks or delays a question, and a journaling failure never throws into it; the one deliberate wait is the optional reason prompt after a deviation. The flow and stage come from `KERYX_FLOW`, the branch or the only flow in progress, and inside a flow it also adds a line to that flow's `journal.md`. One journal serves every worktree of the repository. An answer must be one of the options; unreadable journal lines are skipped and counted in the report; a blind question hides a `(Recommended)` mark written into a label. The irreversible list also catches the synonyms of releasing (ship, rollout, promote, go live, tag a version, publish to npm, выпустить, залить, отправить в прод, накатить) and destructive commands (`git reset --hard`, `clean -f`, `checkout --`, `rm -rf`); an ambiguous weak verb with no real object ("Merge it now?") counts as irreversible, an identifier in a question about code (rename `deleteUser`) does not. The `ask_user` tool takes an optional `action` tag and `irreversible: true`, which force a non-blind question, and its description tells the agent to set them. `keryx decisions report` counts, per stage, the questions where blind was refused. `/decisions change` and `/decisions reason` with no id only act on a decision of the current session and otherwise name the decision they would have touched. Cutting, bumping or tagging a version ("Cut 0.3.62?", "Bump the version and tag it?", "версию поднять и затегать", зарелизить, релизнуть) counts as a release. A decision whose flow was only inferred is kept in the project-wide journal with the `inferred` flag and is not written into that flow's own `journal.md`; only a flow named by `KERYX_FLOW`, the branch or `--flow` gets the line.

### Fixed
- `keryx flow origin set` no longer carries the old quote and source over when the kind changes, and `/flow origin` with no id prints a bounded summary instead of every flow.

[Changes since 0.3.61](https://github.com/MrCipherSmith/keryx/compare/v0.3.61...v0.3.62)

## [0.3.61] — 2026-10-02
### Fixed
- The orchestrator skills, their input-contract schemas and the `/goal --auto` comment no longer say the three orchestrators share one round bound of three: the review/fix bound of `flow-orchestrator` is five, the self-fix bounds of `job-orchestrator` and `task-implementer` stay at three.

[Changes since 0.3.60](https://github.com/MrCipherSmith/keryx/compare/v0.3.60...v0.3.61)

## [0.3.60] — 2026-10-02
### Changed
- **Review round bound: five.** A review/fix loop may now run five rounds before the orchestrator re-plans (`REVIEW_ROUND_CAP` and the `flow-orchestrator` skill, were three). The bounds of `job-orchestrator` and `task-implementer` self-fix stay at three, the review-gate behaviour is unchanged: the cap only adds a note and only a human can dismiss a finding.

[Changes since 0.3.59](https://github.com/MrCipherSmith/keryx/compare/v0.3.59...v0.3.60)

## [0.3.59] — 2026-10-02
### Added
- **Flow origin.** Every flow can record where it came from: `human-request`, `agent-finding` or `agent-proposal`, set with `keryx flow init --origin <kind> --quote "<verbatim>" --source "<ref>"`. A `human-request` is accepted only with the person's own words and a source; otherwise the origin stays `unknown` and a note says why. The Outcome criteria template carries three lines (the request verbatim, the agent's formalization, how to observe it), `outcomeAuthor` is derived from the origin unless set, `keryx flow origin set <id> <kind> --reason` changes it with a journal line, and `flow status`, `product open`, the flow inspector and the new `/flow` shell command show it. The product's G1a is counted by origin. Nothing is gated on the origin: flows without one still init, freeze and complete.

[Changes since 0.3.58](https://github.com/MrCipherSmith/keryx/compare/v0.3.58...v0.3.59)

## [0.3.58] — 2026-10-02
### Added
- **Scheduled digest.** `keryx serve` can send a periodic digest to a service topic in Telegram: what changed in your pull requests, issues, reviews and CI since the previous digest, plus the product board. The schedule is stored like any other (`keryx schedule`), a slot fires at most once, GitHub is read only through a read-only `gh` allowlist, and the delivery result (sent, queued for retry, or refused) is recorded and shown in `keryx schedule list` and the schedule modal. If the summarizing sub-agent is unavailable the digest goes out as plain facts. See the scheduled-digest guide.

[Changes since 0.3.57](https://github.com/MrCipherSmith/keryx/compare/v0.3.57...v0.3.58)

## [0.3.57] — 2026-10-02
### Added
- **Slash commands and button pickers from the Telegram topic.** A line that starts with `/` in a paired topic now runs through a command gateway with an explicit allowlist instead of being refused. Text commands (`/help`, `/status`, `/doctor`, `/compact`, `/think`, `/goal`, `/queue`, `/plan`, ...) answer in the topic, redacted. `/model` and `/connect` arrive as inline-keyboard pickers (provider, then model); picker buttons are single-use, expire, and are bound to the session and message. `/mode trust|auto`, `/plan off`, `/delegate` and `/external*` run only after a Yes/No button press. `/new` and `/clear` start a fresh conversation in the same topic with a separator line. Commands that handle credentials or end the shell (`/exit`, `/channels`, `/provider`, `/setup`, `/mcp trust`, `/guard`, `/route`, `/editguard`, ...) stay local and the topic says so. The bot's command menu lists exactly the allowed commands. The `/remote-control` modal lists recent remote commands.
- **Message state in the topic.** Each operator message shows its state through a Telegram reaction (received, accepted, working, done, failed) and the topic shows the "typing" action while a turn runs.
### Changed
- **Approval and picker prompts are edited in place.** After a press the buttons are removed and the message shows the result instead of a separate "Approval granted." message.

[Changes since 0.3.56](https://github.com/MrCipherSmith/keryx/compare/v0.3.56...v0.3.57)

## [0.3.56] — 2026-10-01
### Changed
- **Telegram replies are rendered as HTML.** Replies and status texts that `keryx serve` sends to Telegram were plain text, with literal `**` and backticks. They now go out with `parse_mode` `HTML`: bold, italic, strike, inline code, fenced code blocks (with their language), headings, quotes, bullets and `http(s)` links are rendered; text outside those constructs is escaped (`&`, `<`, `>`), unclosed or ambiguous markup (`snake_case_name`, `a*b*c`, a lone `**`) stays literal, and a fenced block that crosses a split is two valid `<pre>` blocks. Telegram counts the 4096-character limit after parsing, so a rendered part is never longer than the plain one. If Telegram answers 400 "can't parse entities", that one message is sent again as plain text and a `format-fallback` event is recorded. Approval prompts are sent as a code block so the operator sees exactly what they approve.

[Changes since 0.3.55](https://github.com/MrCipherSmith/keryx/compare/v0.3.55...v0.3.56)

## [0.3.55] — 2026-10-01
### Fixed
- **A timeout while starting a pairing no longer erases the bot token.** The shell wrote the new token, asked `serve` to open the pairing, and on any failure put the old file back, even when `serve` had simply not answered in time and may have taken the token, or had answered `superseded` because a newer start owns the file. It now puts the previous token back only when `serve` definitely refused (a rejected token, `already-connected`, `serve` not running and the like), and only when the file still holds exactly the token this start wrote: a token another shell wrote in between is left alone.
- **A rejected token no longer cancels a valid start in progress.** A second `/channels` start with a token Telegram refuses used to answer `superseded` to a valid start that was still waiting for Telegram. Only a token Telegram accepted supersedes an earlier start now; of two valid starts the later one still wins.
- **Stopping `serve` while a pairing is starting no longer leaves a poller behind.** A start waiting for Telegram when `serve` stopped could still begin polling afterwards and park a pairing in the stopped controller. It now answers `superseded` and starts nothing.

[Changes since 0.3.54](https://github.com/MrCipherSmith/keryx/compare/v0.3.54...v0.3.55)

## [0.3.54] — 2026-10-01
### Fixed
- **`flow check` no longer fails a clone over stale remote branches.** 0.3.53 judged every remote-tracking ref alike, so a fresh clone of this repository reported about thirty `duplicate-id` failures against old branches cut before earlier renumberings (and `flow list` tagged those flows `dup id`). Only a clash with the default branch (`<remote>/main`, `<remote>/master`, the `<remote>/HEAD` target) fails the check now; a clash with any other remote branch is a warning (`flow id <n> is also used on <ref> by a different flow (...); ignore it if that branch is stale, otherwise renumber one of them before it merges`) and does not change the exit code or the `dup id` tag. `flow init` and `flow renumber --to` still reserve numbers held by every known remote branch.

[Changes since 0.3.53](https://github.com/MrCipherSmith/keryx/compare/v0.3.53...v0.3.54)

## [0.3.53] — 2026-10-01
### Added
- **Flow ids no longer clash with other branches.** Flow ids come from a clone-local ledger, so a second clone or an unfetched branch could hand out a number another branch already used (on 2026-10-01 `origin/main` held 360-365 that differed from the local 360-365). `flow init` now reserves every number held by a known remote branch (the remote-tracking refs this clone has, read without a network, up to 500 refs, `<remote>/main` first; a branch that was never fetched is invisible, and `flow renumber` is the repair), `flow renumber --to` refuses such an id, and `flow check` fails a local folder whose number a remote branch holds under a different folder name as `duplicate-id`, naming the ref and ending with `keryx flow renumber <dir> --to <free id> --reason "<why>"`. No remotes, no refs or no git means nothing is known and nothing changes.
- **`flow check` warns about a flow folder that is not committed.** After the normal output it prints `flow folder <dir> is not committed: commit it in the same PR as the code`. It is a warning: the exit code does not change. `flow list` and the TUI (the `/governance` flow list and the flow detail) tag the same flows `not committed`, and a clash with a remote branch `dup id`.
- **A `folder-committed` completion gate.** `flow complete` and `flow check-complete` fail while the flow folder is not in `HEAD`, with `flow folder <dir> is not committed. Commit it (git add .metaproject/flows/<dir> && git commit) in the PR that carries the code, then run flow complete again`. Opt-in per package (`gates.folderCommitted`, written by `flow init`): flows created from 0.3.53 on carry it, older packages report the gate `skipped`, as does a directory that is not a git repository.
### Changed
- The rule is stated in the docs and the flow skills: the flow folder is committed in the same PR as the code, and the commit at closing is a rule to follow. The `folder-committed` gate does not enforce it; it requires only that the flow's `flow.json` is in `HEAD` before closing.

[Changes since 0.3.52](https://github.com/MrCipherSmith/keryx/compare/v0.3.52...v0.3.53)

## [0.3.52] — 2026-10-01
### Security
- **The shell now checks that the process it talks to is `serve`.** Before, nothing authenticated the listener to the shell: if `serve` died without cleanup and another local user bound its loopback port, the shell sent that listener its token and then wrote whatever "ready" pairing answer came back (an attacker's Telegram id as the operator, an attacker's group) into `config.json`. The shell now sends a nonce-bound HMAC of the shell token instead of the token, and `serve` signs every shell-route answer in `x-keryx-serve-proof`. A missing or wrong proof (another process, a tampered body, a replayed answer, a `serve` from before this version) is refused with "restart `keryx serve`" and nothing is written. This covers the seven `/channels` routes and every remote-control call (register, approval, reply, heartbeat, ack, deregister and the stream, whose fake lines and approval decisions a squatter could otherwise feed to the shell). `serve` still accepts the raw token from an older shell. A restarting `serve` now removes the previous endpoint file before it mints its token, and the shell reads the token before the endpoint, so a new token is never sent to a port left over from an earlier `serve`; the shell no longer follows redirects, so a redirect cannot replay a request at the real `serve`.
### Fixed
- **A pairing that finished while the modal was closed is resumable.** `/channels` offers Resume instead of starting over, and Resume connects it.
- **A mistyped token on a second Connect no longer kills an open pairing.** The new token is checked first; the existing pairing is replaced only once the new one is valid.
- **Turning Topics on no longer strands the pairing.** The group becomes a supergroup with a new id; the pairing follows `migrate_to_chat_id` / `migrate_from_chat_id` and keeps checking the right chat.

[Changes since 0.3.51](https://github.com/MrCipherSmith/keryx/compare/v0.3.51...v0.3.52)

## [0.3.51] — 2026-10-01
### Fixed
- **`/channels` pairing, review fixes.** A pairing that was cancelled or had expired while Telegram was still answering about the group can no longer come back to ready, and its status answers `no-pairing` once it was closed during the check. The bot being added to the group before the code was sent now works: the group event of the paired operator is kept and used when the code is accepted (events from anybody else are still ignored). The group step has its own 10 minutes from the moment the code is accepted, and the modal shows the time left.
- **Disconnect and Test wait for a Telegram start that is still in flight**, so a Disconnect pressed mid-start can no longer leave a running hub with nothing on disk.
- **A reconnect to another group no longer reuses topics recorded for the old one.** Records whose group differs from the configured one are forgotten when the hub starts.
- **`/channels` in the "configured, but not running" state has a Retry button** next to Disconnect, which starts Telegram again from the saved token and config and shows the result. Esc is ignored while the modal is working, so its outcome is seen.
### Notes
- Docs: `remote control is off: <reason>` is printed only for an invalid config or a refused start; with no files `serve` prints `channels ready: connect Telegram from the shell with /channels`.

[Changes since 0.3.50](https://github.com/MrCipherSmith/keryx/compare/v0.3.50...v0.3.51)

## [0.3.50] — 2026-10-01
### Added
- **`/governance` opens on a list of flows you can act on.** The modal has a Flows tab before the report: the current project's flows, open ones first, each with a summary (its expected outcome, tasks done, the tasks still open) and its stated effect — the bullets of `## Outcome criteria` in `description.md`, or `effect: not stated` with the reason. On an open flow, `c` checks whether it can be completed; once a check passed and the PR is merged, `d` asks for the flow id typed back (Escape or any other key cancels), checks again against the live flow, and only if nothing changed runs the real `flow complete`, then re-runs the report so the list shows the result. A flow created with `--require-confirmation` is pointed at `keryx flow confirm` in a terminal instead; the modal never mints a token. The report itself is the second tab, unchanged.
- **`keryx flow check-complete <id> [--merged <commit>] [--confirm-token <token>] [--json]`** — every gate `flow complete` would evaluate, through the same code, plus the PR's merge state (`merged`, `open`, `closed`, `not-found`, `no-pr`, `unknown`) and, under each failing gate, the command that fixes it where one is known. It writes nothing: no status change, no completion attempt, no signature, no lock, no spent token. Exits 0 when `flow complete` would pass, 1 when it would not, 2 when the check could not run (with `--json`, an `{"error":{"message"}}` object).
- **`keryx governance report` prints `summary:` and `effect:` under every flow**, and `latest.json` carries them as `summary` and `effect`. A report stored before this version still loads and reads `not recorded` for both.
### Changed
- The GitHub tracker returns the PR's `state` (`OPEN`, `MERGED`, `CLOSED`), which it already fetched. The pull-request gate is unchanged: it still asks for green checks, not a merge.
- The product index and the governance report read `## Outcome criteria` bullets through one parser; the governance report also reads a section written as prose or a numbered list, which the product index still does not count as a criterion.

[Changes since 0.3.49](https://github.com/MrCipherSmith/keryx/compare/v0.3.49...v0.3.50)

## [0.3.49] — 2026-10-01
### Added
- **`/channels`: connect Telegram to a machine from the shell.** The modal lists Telegram; when it is not connected there is one button, Connect, and when it is, Test and Disconnect. Connect asks for the bot token only (hidden, paste works, never in the transcript, history or logs). Your Telegram user id comes from a one-time pairing code (10 minutes, single use) sent to the bot in a private chat, and the group id from adding the bot to the group as an administrator; the modal says when the group has no topics or the bot lacks the manage topics right. No id, path or timeout is typed, and nothing is hard-coded. Test sends one message naming the machine to the General topic; Disconnect deletes every topic, stops polling and erases the token and the config (with `serve` down it erases the files and says the topics stay in the group). A sidebar row shows the state, a menu entry opens the modal, and the readline shell prints the state and how to connect. Use one bot per machine; the group can be shared. Sessions still opt in one by one with `/remote-control`.
- **`keryx serve` offers the connecting routes even when Telegram is not configured, and reloads without a restart.** Seven `/v1/remote/channels-*` routes take the local shell token and carry no secret: the shell writes `remote/bot-token` and `remote/config.json` itself (mode 600, atomic) and asks `serve` to reload. Pairing runs inside the single poller.
### Notes
- Pairing takes a message that is only the code (or `/start <code>`), never a forwarded one. A timeout is reported as "no answer" and erases nothing; topics Telegram refuses to delete (for example a 403) stay recorded and are counted as remaining.
- Tested against the in-process fake Bot API only; no run against real Telegram.
- Docs: [Connect from the shell](docs/docs/guides/drive-keryx-remotely.md#connect-from-the-shell-recommended), [`/channels` in the CLI reference](docs/docs/cli-reference.md#shell-behavior).

[Changes since 0.3.48](https://github.com/MrCipherSmith/keryx/compare/v0.3.48...v0.3.49)

## [0.3.48] — 2026-10-01
### Added
- **Remote control from Telegram: `/remote-control [name|off|status]`.** In the full-screen shell, `/remote-control <name>` mirrors the session into its own topic of a Telegram supergroup. A line sent in the topic runs as if typed in the shell (shown as `tg ❯` in the transcript and `[tg]` in the queue panel); the reply and any approval question, with Allow and Deny buttons, come back to the topic. `status` shows the state (`off`, `on`, `offline`), the topic, the last heartbeat and recent events; `off` deletes the topic. The sidebar has a remote row and a `/remote-control` modal. The readline shell prints that it is off. **Off by default**: it needs a separate BotFather bot whose token is in `remote/bot-token` in the global keryx directory (mode 600), `remote/config.json` with the supergroup `chatId` and the `allowedUserIds` allowlist, and a supergroup with topics where the bot is an admin with manage topics. Without those files `keryx serve` starts as before and says `remote control is off`.
- **One Telegram poller, in `keryx serve`.** Shells never talk to Telegram: they reach seven `/v1/remote/*` routes with a local shell token, from loopback. The serve bearer token does not reach those routes and the shell token reaches nothing else. A second `serve` on the same bot token stops on Telegram's conflict answer. A sender outside the allowlist is ignored; only the id and the time go to `rejected.jsonl`.
- **Long replies are split for Telegram.** A reply over 4096 UTF-16 units goes out as numbered messages `(1/3)`, cut at a line break or a space, with a fenced code block closed and reopened across the cut; emoji are not cut and an empty reply sends nothing. No parse mode is sent, so the text is plain. `bun run src/remote/format-sample.ts` prints samples without a network.
- **Timeouts.** A topic whose session stops heartbeating is deleted after `orphanMs` (default 10 minutes); a run started from Telegram is interrupted after `runTimeoutMs` (default 30 minutes). Both are optional keys in `remote/config.json`.
- **Session history records it.** A session driven from a topic keeps the topic and each on/off span: `keryx sessions list` prints a `⇄ remote <topic>` line, `--json` carries a `remote` field, and the `keryx shell -r` picker marks the row `⇄ remote`.
### Security and delivery
- **The shell token is minted fresh on every `serve` start, and a shell no longer sends it to a dead endpoint.** The shell re-reads the token on each request and refuses an `endpoint.json` whose recorded `serve` process is gone, so a stale file (or a process that reused its port) never receives it. A `serve` refused the poller lock mints no token and answers `401` on the remote routes. The poller lock and the token file are created whole (no reader sees a half-written one).
- **Telegram updates are deduplicated by exact id, with no persisted offset.** An id above the highest seen is not a monotonic key: Telegram can restart its numbering, and a stored offset would then swallow every new message. After a restart the poller asks for what is unconfirmed; a batch below the highest seen id is delivered as a numbering reset and logged as a poller-status event.
- **At most 500 undelivered lines per topic**, with one status line in the topic saying how many were dropped. Button presses are acknowledged in the background with a 5 s bound, so a slow Telegram no longer holds up the next update.
- **An ack or `Last-Event-ID` is honoured only for an id that was actually sent**; "Approval granted." is posted only if the decision reached the shell's stream; rebinding a topic forgets the finished ids.
- **Turning remote control off from the shell is honest about what it drops.** A second `/remote-control off` waits for the first one's close instead of answering "already off", and `/new` and `/resume` report that the topic is being deleted. Queued Telegram lines are removed from the shell queue with a notice naming them, and the topic is told before it is deleted. Removing one queued Telegram line with `/queue` tells its topic. `/queue edit` keeps a line's Telegram origin, so its answer still goes to the topic.
- **The topic gets the final answer, not the narration.** Text written before a tool call stays in the shell; a run that ends without final text sends "Done. There was no text to show." (or "The run failed." on failure).
### Notes
- Tested against an in-process fake Bot API. It has not been run against real Telegram: topic creation, the supergroup permissions, button callbacks and the single-poller conflict are as the Bot API documents them, not as observed. Try it with a throwaway bot and group first.
- Docs: [Remote control from Telegram](docs/docs/guides/drive-keryx-remotely.md#remote-control-from-telegram), [serve in the CLI reference](docs/docs/cli-reference.md#remote-control-from-telegram).

[Changes since 0.3.47](https://github.com/MrCipherSmith/keryx/compare/v0.3.47...v0.3.48)

## [0.3.47] — 2026-10-01
### Changed
- **The opt-in `rules-export` block no longer edits `CLAUDE.md` or `AGENTS.md` by default.** `keryx integrations install --runtime claude|codex --surface rules` and `keryx bundle import --render-for` used to write the `<!-- keryx:rules -->` block into the tracked `CLAUDE.md` and `AGENTS.md` — the one keryx writer 0.3.45 left behind. It now goes where the `keryx:index` block goes, by `agentEntrypoints.root`: `CLAUDE.local.md` and the keryx-generated `AGENTS.override.md` under scope local (the default), `CLAUDE.md` and `AGENTS.md` only under scope `shared`. After installing it for both runtimes with the default scopes, `git status` lists neither `CLAUDE.md` nor `AGENTS.md`. A local file git does not ignore yet (a fresh clone before `keryx update`) is added to `.git/info/exclude` first, through the same writer `update` uses.
- **Codex keeps the block across regenerations.** It sits in `AGENTS.override.md` right after the index block, and `keryx update`, `keryx rules sync` and `keryx rules distill` carry it into every regenerated override; the override's staleness hash is still `AGENTS.md`'s alone. With `mode: "skip"`, no `AGENTS.md`, no override generated yet in the checkout, or an `AGENTS.override.md` keryx did not generate, nothing is written for Codex and the install succeeds with a warning that says which.
- **One resolved file for every entry point**: install, uninstall, `keryx integrations doctor`, `--dry-run`, install-state and `bundle import --render-for` name the same file, and the block is never in both the team file and the local file. A team file that already carries the block keeps receiving it until `keryx update` settles it; switching a runtime to `shared` and installing again takes the block out of its local file.
- **The block follows a scope switch.** Switching a runtime between `local` and `shared` and running `keryx update` (or `keryx init`, `keryx rules sync`, `keryx rules distill`) moves an installed block to the runtime's new file in either direction, re-renders it there, records that file in install-state, and leaves it in exactly one file. A `CLAUDE.local.md` that held nothing but keryx's blocks is removed.
- **Only keryx's own block in `AGENTS.override.md` is touched.** It sits in a slot right after the index block; a block inside the override's copy of `AGENTS.md` is the team's text, so installing, refreshing or uninstalling never edits it, and a block the team removed from `AGENTS.md` no longer comes back on the next regeneration.
- **A `CLAUDE.local.md` tracked in git gets no `rules-export` block**, as it gets no `keryx:index` block: the install writes nothing and says how to untrack it or set the claude entry to `"shared"`.
- **`keryx integrations install` reports `skipped`** (human and `--json`, real run and `--dry-run`) when the rules-export surface writes nothing for a runtime, instead of `installed`. `keryx integrations uninstall --dry-run` names a block the real run would also take out of the runtime's other file.
- `docs/integrations/harness-capability-matrix.json` lists `CLAUDE.local.md` and `AGENTS.override.md` as the Claude and Codex `rules` files.
### Security
- **A manifest can no longer point keryx's blocks at an arbitrary file.** A shared `agentEntrypoints.root` entry is only ever its runtime's team file (`CLAUDE.md`, `AGENTS.md`, in any case), and a Codex `source` only `AGENTS.md`. Before, a cloned `metaproject.json` stating `{ "runtime": "claude", "scope": "shared", "path": ".env" }` made `keryx update` write the `keryx:index` block into `.env` (since 0.3.45) and the rules-export install write its block there too; `.metaproject/metaproject.json` itself or `package.json` as a Codex `source` worked the same way. Such an entry is now ignored, and the runtime's scope is decided from `HEAD` as for a manifest that never stated it. The rules-export resolver also refuses, on its own, any file but the runtime's four standard ones.
### Migration
- **`keryx update` (and `keryx init` over an existing project) moves a `rules-export` block** that a keryx before 0.3.47 left as an uncommitted edit in `CLAUDE.md` or `AGENTS.md` whose scope is local. The block is re-rendered at the local target from the current `.metaproject/rules/`, and the team file goes back to its `HEAD` bytes, or loses only the block when it has other uncommitted edits (CRLF kept). A block committed in `HEAD` is the team's shared choice: it is left alone and no local copy is written. Notices: `CLAUDE.md: moved the <!-- keryx:rules --> block to the local target; the file is back at HEAD.` and `CLAUDE.local.md: holds the keryx:rules block now, rendered from the current rules library.`
- **`keryx doctor`'s `entrypoints` check** warns about an uncommitted `rules-export` block in a tracked file whose scope is local, naming that runtime's own local file; `update --preview` says whether it would move. The fix is `keryx update` where update moves it; where it does not — `CLAUDE.local.md` is tracked, or `AGENTS.override.md` was not generated by keryx — the warning says so and names the step that clears it (`git rm --cached CLAUDE.local.md`, removing the override, or scope `"shared"`).
### Notes
- `GEMINI.md`, `.github/copilot-instructions.md` and the keryx-owned `.cursor/rules/`, `.kiro/steering/` and `.windsurf/rules/` files have no per-developer counterpart their tool reads, so `rules-export` still writes them where they are.
- Switching Codex to `mode: "skip"` removes the keryx-generated `AGENTS.override.md` with any `rules-export` block in it: with `skip` there is no Codex file to carry it to.
- A manifest that named a non-standard shared path or Codex `source` now has that entry rewritten by the next `keryx update` to the standard entry `HEAD` decides.
- Docs: [rules-export surface](docs/docs/integrations.md#rules-export-surface), [where the block goes](docs/docs/workspace-and-lifecycle.md#where-the-block-goes-local-and-shared-scope).

[Changes since 0.3.46](https://github.com/MrCipherSmith/keryx/compare/v0.3.46...v0.3.47)

## [0.3.46] — 2026-10-01
### Added
- **`/settings` in the shell** — one screen for the settings that used to live in separate slash commands, grouped Safety, Routing, Display and External: permission mode, plan, turn guard, edit guard, classifier routing, reasoning effort, reasoning display, theme, external providers, external agents, and a read-only line for the Jev review profile. Each row shows its effective value and where it lives: `session` (gone when the shell exits: permission mode and plan), `saved` (kept on disk). In the TUI it is a modal styled like `/connect`: `↑/↓` between settings, `←/→` between the On/Off or value buttons, `Enter` or a click to apply, `Esc` to close. Every button runs the existing command's own handler, so `/settings` and the slash command cannot disagree. Switching permission mode to `auto` asks for a second `Enter`, as Disconnect does in `/connect`. In the readline shell `/settings` prints the same rows as a table, with the settings that need the TUI marked. The sidebar's mode line points at it and opens it on a click.
### Changed
- `/reasoning`, `/think` and `/theme <name>` share their handler with the `/settings` buttons; behaviour is unchanged.

[Changes since 0.3.45](https://github.com/MrCipherSmith/keryx/compare/v0.3.45...v0.3.46)

## [0.3.45] — 2026-10-01
### Changed
- **keryx no longer edits the files your team tracks.** `keryx init` and `keryx update` used to write the `<!-- keryx:index -->` block into `AGENTS.md` and `CLAUDE.md`, the `# keryx:begin` block into `.gitignore`, and `_keryxManaged` hooks into `.claude/settings.json`. Those edits sat uncommitted in every clone and made `git pull` refuse upstream changes to the same files. By default the block now goes to `CLAUDE.local.md`, Claude hooks to `.claude/settings.local.json`, and the ignore rules to `.git/info/exclude`; after `init` or `update`, `git status` lists none of `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.claude/settings.json`.
- **Codex gets `AGENTS.override.md`** (`mode: "override"`, the default): the block plus the full content of `AGENTS.md`, because Codex reads the override instead of `AGENTS.md`, never both. A bare block is never written there. `mode: "skip"` writes nothing for Codex and says so; the one change it makes is removing an `AGENTS.override.md` keryx generated earlier (it carries keryx's provenance line), so a leftover cannot keep hiding `AGENTS.md`. With no `AGENTS.md`, Codex is skipped with a message, and no tracked `AGENTS.md` or `CLAUDE.md` is created.
- **`agentEntrypoints.root` holds one entry per runtime**: `{ runtime, path, scope: "local" | "shared" }`, with `mode` and `source` on a local Codex entry, plus a `claudeSettings` entry. The old string array is still read. `scope: "shared"` is the explicit opt-in that keeps the block or the hooks in the committed team file.
- **The ignore block in `info/exclude` holds every entry**, including ones this checkout's `.gitignore` or your global excludes file already covers: `info/exclude` is shared by every worktree of the clone while `.gitignore` belongs to one branch, so the block is the same whichever worktree runs `update`. That includes `.metaproject/` ignored as a whole: a blanket `.metaproject/` line is one branch's rule too, so the full set is still written, and a worktree whose branch lacks the line keeps `.metaproject/runtime/` and `.metaproject/data/security/raw/` ignored. A `CLAUDE.local.md` left over after Claude went back to shared is listed whether or not the checkout has one. keryx never writes a line into `info/exclude` that starts with `!` or holds a line break.
- **A local entry always uses its runtime's standard file** (`CLAUDE.local.md`, `AGENTS.override.md`, `.claude/settings.local.json`), whatever `path` the manifest states; a path or Codex `source` with a control character or a leading `!` or `#` is rejected. A Codex `source` reached through a symlink leaving the project is never read, so no override is generated from it.
- **A new `CLAUDE.local.md` imports `@AGENTS.md`** when the repository has `AGENTS.md` but no `CLAUDE.md`, because Claude Code stops falling back to `AGENTS.md` once a `CLAUDE.local.md` exists.
### Migration
- **One `keryx update` migrates a project.** It rewrites the legacy `root` array to the entry form, and a block or hook groups keryx left as uncommitted edits move to the local targets, with each tracked file restored to its `HEAD` bytes. A file with other uncommitted edits keeps them; only keryx's part is removed. A second `update` changes nothing. The block and the hooks never end up in both places, since Claude Code would run a hook present in both settings files twice.
- **A block or hooks committed in `HEAD` stay shared**: the file is left alone, that target is recorded as `scope: "shared"`, and the output says how to switch it to local.
- **`.gitignore` goes back to `HEAD` even where the older keryx deleted team lines**: the pre-0.3.45 writer also removed lines outside its block that repeated its own (and a blanket `.metaproject/` line where `.metaproject` was tracked); those deletions count as keryx's, not yours. Line endings are kept: a CRLF file stays CRLF when only the block is taken out.
- **Tracked per-developer files are left to the team**: keryx does not write its block into a tracked `CLAUDE.local.md` (the output says to untrack it or set the claude entry to `"shared"`), and a tracked `.claude/settings.local.json` loses keryx's hooks but is not deleted when they move back to shared. When only the block is stripped and the index still holds a copy with it, the output gives the `git restore --staged` / `git add` fix.
- **Notices you will see**, one line per file, for example: `CLAUDE.md: moved the managed keryx block to the local target; the file is back at HEAD.`, `.gitignore: moved the managed keryx ignore block to info/exclude; the file is back at HEAD.`, `.claude/settings.json: moved the keryx-managed hooks to .claude/settings.local.json; the file is back at HEAD.`, `AGENTS.md: removed the managed keryx block; your other uncommitted edits in AGENTS.md are kept as they were.`, `CLAUDE.md: the managed keryx block is committed in HEAD, so it stays there (scope "shared"). …`, `Codex: skipped — AGENTS.md does not exist, …`, `CLAUDE.local.md: created with the keryx block (gitignored, per checkout).` and `AGENTS.override.md: generated from AGENTS.md with the keryx block (gitignored, per checkout); Codex reads it instead of AGENTS.md.` (only on the run that creates the file), and `Ignore rules: .git/info/exclude now holds keryx's managed block (N entries); .gitignore is not modified.` — or `…; no keryx lines remain in .gitignore.` on the run that moved the old block out of it.
### Doctor and readers
- **`keryx doctor` has an `entrypoints` check.** It warns, with `keryx update` as the fix, when a managed block, keryx's ignore block or keryx-managed hooks are left as uncommitted edits in a tracked file whose scope is local; when hooks sit in both Claude settings files; when `AGENTS.override.md` is stale against `AGENTS.md`, larger than the 32 KiB Codex reads, reached through a symlink leaving the project, or not generated by keryx; and when a local target is missing in this checkout (a linked worktree that has not run `keryx update`) or git does not ignore it. Content committed in `HEAD` is the team's shared choice and is not warned about. The check only reads.
- **`keryx standard doctor` and the `agent`/`full` profiles** look for the index link in the file the manifest names for each runtime, local or shared, so a migrated repository raises no `entrypoint-missing-index-link`. A fresh clone or linked worktree shows the profiles as not yet satisfied until `keryx update` has run there.
- **`init --preview` and `update --preview`** list what a real run would move (the index block, the `.gitignore` block, Claude hooks), what it would create or remove in the local files, and what `info/exclude` would hold — and still write nothing.
- **Other readers follow the local files:** the stale-worktree prune no longer counts keryx's own generated `CLAUDE.local.md`, `AGENTS.override.md` or `.claude/settings.local.json` as work to keep; the security audit scans `CLAUDE.local.md` and `AGENTS.override.md` as agent instructions; an external agent's write run flags them like the team files; the Zed probe says when the block lives in `AGENTS.override.md`, which Zed does not read.
### Notes
- Local files exist per checkout: a linked worktree has no block and no keryx hooks until `keryx update` runs in it. Cloud and remote Claude sessions have no `CLAUDE.local.md` and do not read `.claude/settings.local.json`; use `scope: "shared"` there.
- `AGENTS.override.md` is refreshed by `keryx update` or `keryx rules sync`, not when `AGENTS.md` changes, and Codex reads at most 32 KiB of it by default (`project_doc_max_bytes`). When `AGENTS.md` is removed, the next run removes a keryx-generated override too.
- `metaproject.json` is tracked, so the scopes and the Codex mode are a team setting. A blank-line-only edit to a tracked entrypoint is reverted during migration. Switching a target back to shared (or Codex to `mode: "skip"`) cleans up the old local file on the next `update` or `rules sync`: keryx's block (and the `@AGENTS.md` import it added) leaves `CLAUDE.local.md`, which is removed when nothing of yours is left in it, and a keryx-generated `AGENTS.override.md` is removed; an override keryx did not generate is left alone. The opt-in `rules-export` block (`<!-- keryx:rules -->`) still writes tracked files.
- Docs: [where the block goes](docs/docs/workspace-and-lifecycle.md#where-the-block-goes-local-and-shared-scope).

[Changes since 0.3.44](https://github.com/MrCipherSmith/keryx/compare/v0.3.44...v0.3.45)

## [0.3.44] — 2026-09-30
### Added
- **`keryx agents external enable` and `disable`** — one command turns the external agent runtime on (or off) for this machine and this project: `externalAgents.enabled` in the user config and, when the project has a manifest, `enabled` on its `gdskills.external-agents` entry. No other key or file changes, and a manifest that is not valid JSON is refused. Before this, the project half needed `keryx init --external-agents`, which rewrites many unrelated tracked files, and the user half had no command at all.
- **`/external-agents on|off` in the shell** — the same action from the composer; bare `/external-agents` shows the state and why. It is not `/external` (the privacy switch for external providers).
- **Short agent names** — `claude`, `codex` and `agy` (also `antigravity`, any case) work for `claude-cli`, `codex-cli` and `antigravity-cli` in `/delegate`, in every `keryx agents external <subcommand> <id>` and in a `spawn_subagent` `runtime.agent`. Names are resolved once at each entry point, so a short name never bypasses `externalAgents.agents[<id>].enabled`, the consent record or the vendor gates.
### Changed
- Every refusal of the external agent capability, and the `/delegate` refusal in the shell, now names `keryx agents external enable` (`/external-agents on` in the shell) as the fix.
### Fixed
- After a refusal, enabling the capability took effect only after a restart of the shell; an unavailable answer is no longer cached.
### Notes
- `enable` does not change `externalAgents.spawnDecision`: a model-initiated `spawn_subagent` call still asks for approval, and is denied where no approver is wired.

## [0.3.43] — 2026-09-30
### Fixed
- **Every `codex-cli` run failed with `invalid_json_schema`** (0.3.42, read-only and `--write`). `codex exec --output-schema` forwards to OpenAI structured output, which refuses the subagent-result schema as written (objects must list every property in `required`, and `allOf`, `if`/`then`, `pattern`, bounds and `default` are rejected). `codex` now receives a strict copy of that schema; keryx removes the nulls the copy forces on optional fields and validates the answer against the full, unchanged contract, so a null on a required field still fails.
- **A `codex` write run was reported as `exited with code 143`.** `codex` needs about 2 s to exit after its final event in write mode, longer than the 2 s settle window, so keryx killed it mid-teardown and trusted the signal exit code. For `codex` the window is now 10 s (other agents keep 2 s), and a run ended by keryx's own kill after its terminal event takes its exit code from the child if it had already reported one, otherwise from its events, never from the signal the kill produced.
- **The `codex` result is now its final message only.** Narration in earlier messages ("I'll edit a.txt") was joined in front of the JSON answer and failed the structured validation.
### Notes
- A `codex` result that reports a `blocker` or `major` finding must carry `class_scope` (the full contract requires it); the strict copy cannot express that conditional, so a result that leaves it null fails validation as an Error instead of being accepted. Validation stays fail-closed.

## [0.3.42] — 2026-09-30
### Added
- **Write mode for the external agent `codex-cli`** — `keryx agents external run codex-cli --task "..." --write` works the same way as for `claude-cli`: a throwaway git worktree at the base commit, a secret-redacted, hashed patch that is never applied automatically, human review, and landing only as a NEW local branch `external/<run-id>` after you type the first 12 hex digits of the patch hash. The same flagged-path gate applies, there is no auto-approve, and nothing is pushed and no pull request is opened from the landed branch.
- **A different kind of confinement** — `claude` has a tool allow-list (`Read Grep Glob Edit Write`; no shell, no network, no MCP). `codex` has no allow-list, so keryx runs it with `-s workspace-write -c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true -c sandbox_workspace_write.network_access=false --ignore-rules`. Measured live on 2026-09-30 with `codex` 0.159.2 in a scratch git repository: writes outside the worktree (`/tmp`, `/var/tmp`, `$HOME`, a sibling directory) fail with "read-only file system", a DNS lookup fails, and `.git` is read-only (no commit, no hook write). Without the two `exclude_*` flags the default `workspace-write` sandbox lets `codex` write to `/tmp`, which is why keryx always passes them. `--ignore-rules` is equally mandatory: without it, the exec-policy rules in the user's own `codex` configuration can let shell commands run outside the sandbox (writes to `/tmp` and `$HOME` succeeded in the test); with it they were refused.
- **A version window** — keryx refuses a `codex` write run before it starts unless the installed `codex` is 0.159.2 or newer but older than 0.160.0; older, newer, pre-release and unreadable versions are all refused, and the message names the version found and the range required. The ceiling exists because `codex` silently ignores a `-c` key it does not know, so a release that renamed a confinement key would otherwise run unconfined unnoticed. A follow-up turn of a write run re-asserts the same flags.
### Notes
- `codex` keeps a sandboxed shell, so it can READ any file your user account can read (for example keys under `$HOME`). The network is closed as far as was measured, but their content can appear in the run's output. Review the diff and the run output before applying, and do not run a `codex` write task in a checkout or environment where that matters.
- `antigravity-cli` (`agy`) still refuses `--write`: a live test showed its file-edit tool writes outside the working directory (to `/tmp` and into `.git/hooks`), and its headless shell is auto-denied only for commands, not for file edits. Write for Gemini is not planned; `gemini-acp --write` is unchanged (its patch is still never applied by keryx).
- Neither `claude-cli` nor `codex-cli` write mode has a long live history; the `codex` confinement was verified in a scratch repository on `codex` 0.159.2.
- A read-only `codex` child is still launched without `--ignore-rules`, so an exec-policy rule of yours that allows a command can run it outside the sandbox there; left for a follow-up because the flag is unmeasured on the oldest supported `codex`.

### Docs
- [Let an external agent write](docs/docs/guides/external-agent-write.md), the harness page, the architecture and modules pages and the README now cover `codex-cli` write mode and how its confinement differs from `claude-cli`.

## [0.3.41] — 2026-09-30

### Fixed

- **ChatGPT / Codex model discovery** now discovers the current stable Codex
  client version from official npm metadata instead of pinning a compatibility
  version in Keryx. Newly available models can appear without a Keryx release
  or a local Codex installation. ([#806](https://github.com/MrCipherSmith/keryx/pull/806))
- **Connection tests refresh discovery**: **Test** in `/connect` and
  `keryx providers test openai-codex` check npm for the current version before
  fetching the live subscription model catalog. Normal discovery reuses the
  version cache for one day; there is no background polling.

### Notes

- If npm is unavailable, discovery reuses a previously discovered version.
  Without a cached version, it reports the lookup failure instead of guessing.
  Credentials are sent only to the subscription service, never to npm.

### Docs

- Documented catalog refresh, caching, and outage behavior in the CLI reference
  and onboarding guide.

[Changes since 0.3.40](https://github.com/MrCipherSmith/keryx/compare/v0.3.40...v0.3.41)

## [0.3.40] — 2026-09-30
### Added
- **Write mode for the external agent `claude-cli`** — `keryx agents external run claude-cli --task "..." --write` runs `claude` in a throwaway git worktree cut from the current commit with only the tools `Read Grep Glob Edit Write`: no shell, no network, no MCP server (`--tools Read Grep Glob Edit Write --permission-mode acceptEdits --permission-prompts none`). The worktree's diff is captured, secret-redacted, hashed (sha256 of the redacted patch) and stored as a pending review; nothing reaches your checkout. Nothing is stored when the run changed nothing, and a changed symlink that points outside the worktree refuses the run at capture (it can only be discarded).
- **`keryx agents external review <run-id>`** shows one stored run: flagged paths first, the file list, then the redacted patch. **`apply <run-id> [--allow-flagged]`** needs a real terminal on both ends, shows the diff and asks you to type the first 12 characters of the patch hash; only an exact match creates a NEW local branch `external/<run-id>` with one commit cut from the recorded base commit in a second throwaway worktree. Your current branch, index and working tree are never touched, a run lands at most once, and nothing is pushed and no pull request is opened. **`discard <run-id>`** drops the run and deletes its patch.
- **Landing is refused** for a patch that redaction altered, for binary files (their content is not in the patch), for flagged paths (`.git`, `.github`, `.claude`, `.metaproject`, hooks, CI) unless `--allow-flagged`, when the branch already exists, and when the patch on disk no longer matches its recorded hash. There is no flag or environment variable that skips the confirmation, and a caller without a terminal lands nothing.
- **`/external-diff`** — a TUI modal over the pending runs (up/down select, `j`/`k` and PageUp/PageDown scroll, `a` then the 12-character hash prefix, `f` allows flagged paths, `d` then `y` discards, Esc closes) and a one-row sidebar entry `External diffs: N pending`, shown only while a diff awaits review. In the readline shell `/external-diff` lists the pending runs and points at the CLI; it never lands anything.
- **Guide** — [Let an external agent write](docs/docs/guides/external-agent-write.md).
### Notes
- Only `claude-cli` can write. `codex-cli` and `antigravity-cli` still refuse `--write` with "write mode is claude-only in this release"; `gemini-acp --write` is unchanged (its patch is still never applied by keryx).
- The mandatory review is a human reading the shown diff. A model review is not built, there is no auto-approve, and keryx never pushes or opens a pull request.
- Verified against the `claude` 2.1.280 narrow-permission probe (the write roster with `acceptEdits` edits inside the worktree, a write outside it is auto-denied, `--permission-prompts none` turns any other question into a refusal). A full write run through the installed CLI has NOT been recorded yet.

## [0.3.39] — 2026-09-29
### Added
- **Asynchronous remote approvals (R4d)** — an `ask` in a `keryx serve` turn becomes a durable pending approval and the turn detaches (`202`) instead of ending in a denial. `GET /v1/approvals` lists (`?state=all` adds recently resolved); `POST /v1/approvals/{id}` with `{"decision":"allow"|"deny"}` applies the first valid answer once and returns the original outcome on a replay. An expired approval answers `410`, an answer from the raising turn (declared in `x-keryx-turn`) `403`, an unknown or unseen id an indistinguishable `404`, and a malformed or extended body `400` before any state changes. `/v1/status` `pendingApprovals` is real.
- **An answer is one call** — bound to a fingerprint of that call, consumed once (restart included), never a session grant, and a destructive, credential or hook-ask call asks again the next time. Unanswered means denied at expiry; with no consumer attached the approval is `undeliverable` at once (`approval.requireConsumer`, default on).
- **`keryx approvals list|allow|deny <id>`, `/approvals`** — a modal in the TUI (summary, scope, consequence, expires in, state; `a`/`d` then `y`), a one-row sidebar count shown only while something is pending, and a text form in the readline shell.
- **Client contract page** — [Answer a remote approval](docs/docs/guides/answer-remote-approvals.md).
### Notes
- The production `keryx serve` registers no tools, so a stock listener raises no approvals; they are reachable through an injected tool registry. The self-grant rule rests on a declared header, so it stops an honest turn, not a lying caller. The chat card, remote session-wide grants and approvals for unattended trigger runs are not built.

## [0.3.38] — 2026-09-29
### Added
- **Review as a pull request bot** — `keryx review bot run --pr <n> --repo <owner/repo>` reviews the pull request diff (one reviewer turn, one verifier turn per finding), drops findings the verifier refutes, and records the rest as a managed review; `keryx review bot post` builds ONE pull request review (event `COMMENT`, `commit_id` = the head) with an inline comment per finding inside the diff and the rest in the body. A dry run unless `--post` is given; refused when the pull request is closed, merged or from a fork, when `--sha` is not the head, or when the review was made at an older commit. The GitHub allow-list gains exactly this one write (`POST repos/{owner}/{repo}/pulls/{n}/reviews`). A comment body that would carry a secret-shaped string is withheld and counted, never masked and posted. The diff is cut at `--max-diff-bytes` (default 200,000) and the cut is stated in the run output, in `report.md` and in the posted review. The review body ends with a hidden `keryx-review-bot` marker for the head commit and the post step refuses when a review with that marker is already on the pull request.
- **`keryx review metrics [--json] [--refresh]`** — findings raised, acted on, dismissed by kind, answered, still open; precision (acted on over acted on plus dismissed as incorrect) and resolved-before-merge. A ratio with nothing behind it prints `n/a`. Resolved-before-merge is a proxy: a package's `updatedAt` stands in for when a disposition was recorded. Metrics need the managed review packages on the machine where `keryx review complete` is run; the Action's runner keeps them only for the job and nothing uploads them.
- **A root `action.yml` and `docs/examples/review-bot.yml`** — a composite action that skips fork pull requests, takes the provider key as one input and never puts it on a command line, and needs only `contents: read` and `pull-requests: write`. A test fails on `pull_request_target`, a missing fork guard or wider permissions.
- **`/reviews`** — a TUI modal and a sidebar row (open-findings count) over the managed pull request reviews, and a text equivalent in the readline agent shell. `/review` is unchanged.
### Fixed
- **`keryx review bot post --help` and `keryx review metrics --help` print their own usage** instead of the generic `review` group usage.
### Docs
- New guide `review-as-a-pr-bot.md` (setup, secrets, the same-repository rule, dry run, cost and diff cap, metrics and the resolved-before-merge proxy) and a README section; the guide has not been exercised against a real GitHub repository or model provider.

## [0.3.37] — 2026-09-29
### Added
- **`/rewind` — per-turn file snapshots with rollback of files and conversation.** Immediately before the first write, shell, destructive or delegate tool call of a turn (after approval), keryx snapshots the project work tree into a per-session shadow git repository under the session directory; a read-only turn snapshots nothing, and the project's own `.git` is never read or written. `/rewind` restores files, history or both to before a chosen turn: modified files come back, created files are removed, deleted files are recreated; `.git`, `node_modules`, `.metaproject/data` and gitignored paths are never touched, and files over 5 MB are skipped and named. A `pre-rewind` snapshot is taken first, so the restore can be undone (files only). History is cut by archive index, so it survives compaction, and persists through the session store; `/rewind` refuses when the session lease is held elsewhere. In the TUI it is a modal picker (time, prompt excerpt, files changed; files / history / both; confirmation) plus a sidebar section with the snapshot count; the readline shell has `/rewind`, `/rewind N [files|history|both]` and `/rewind confirm`.
- **`keryx setup [init|refresh|repair]` and `/setup`** — a read-only guide for preparing a Metaproject from scratch, after a pull, or when something is stale. Each step shows the CLI line and a prompt to paste to an agent; the same guide opens in `keryx shell` as `/setup` (tabs in the TUI, plain text in the readline shell). It runs nothing: no init, update, sync or wiki enrichment. Merged as #802 in the same release without its own version bump, so this entry was added afterwards.
- **Limits and retention** — 50 snapshots per session, oldest pruned; the shadow repository is removed with its session; `KERYX_REWIND=off` disables it. Unattended runs (triggers, `keryx serve`, external agents) create no shadow repository and refuse `/rewind`. Side effects of `shell_exec` outside the work tree are not undone. Documented in `docs/docs/guides/rewind.md`.


## [0.3.36] — 2026-09-29
### Added
- **External agents verified against real vendor processes** — `claude` 2.1.280 (2026-09-29) and `agy` 1.2.12 (2026-09-28, run again 2026-09-29) ran end to end through `keryx agents external run` and ended `Completed`; the raw transcripts, each with its vendor version, are in `fixtures/external/live/` and replay offline (claude and codex in `live-fixtures.test.ts`, agy in `antigravity-cli.runtime.test.ts`). A fixture-scan test fails on a known set of private-data patterns (home path, e-mail, token, vendor credential-store reference). With `KERYX_LIVE_EXTERNAL=1` and `KERYX_LIVE_EXTERNAL_CWD` set to a clean scratch repo, live tests assert against real vendor processes; they record nothing.
- **The first real codex-cli failure is recorded** — a subscription usage limit on codex 0.159.0, replacing the hand-authored stand-in as the reference for the limit classifier. No successful codex run exists yet; the subscription was at its limit until 2026-10-03.
### Fixed
- **codex-cli 0.159.0's expired-login wording is classified as an authentication failure** — "Your access token could not be refreshed. Please log out and sign in again." now yields the `codex login` hint instead of an unclassified failure.
### Docs
- `harness.md` and the shell/TUI test catalog no longer say the external runtime was never run against a real vendor process; they name the verified versions and keep Gemini and a successful codex run marked unverified.

## [0.3.35] — 2026-09-29

### Added
- **MCP session trust is inspectable and revocable** — `/mcp trust list` prints every tool trusted for the session with its full name and server, and says `(will ask again: changed|destructive|gone)` instead of `[trusted]` for a grant the next call would not honour; `/mcp trust revoke <server__tool>` removes one and `/mcp trust revoke all` removes everything. An unknown name is reported and changes nothing, and revoke takes the full name only. Works in the TUI (also while the agent is busy) and in the readline shell, where `/mcp` was previously unhandled (plain `/mcp` there now points at `keryx mcp list`). `/mcp trust` is documented in the `/mcp` entry of the slash registry, dropdown, `/help` and the help modal.
- **A `[trusted]` marker** on the approval transcript lines of a trusted tool, in the `/mcp` view (a per-server count), in `/mcp trust list`, and on the auto-approve line, which now also names the tool (`use_tool <server__tool>`).

### Changed
- **A tool marked `destructiveHint: true` is never offered session trust** — neither in the TUI dock nor in the readline prompt, and the approval carries a withheld reason saying it is destructive (`mcpTrustWithheldReason`). The annotation is read from the live catalog on every call, so a grant held for a tool that later reports `destructiveHint: true` is dropped and the call asks again. An absent or `false` annotation behaves exactly as in 0.3.27, because the MCP default for a missing hint is "destructive" and would withhold trust from nearly every server.

### Fixed
- **`/new` and `/clear` in the TUI now clear the session's MCP trust grants.** Only resume did, though the docs said `/new` cleared them.

## [0.3.34] — 2026-09-29

### Fixed
- **`keryx flow outcome author` was unreachable from the command line in 0.3.33** — the router in `cli.ts` refuses a subcommand that `src/lib/group-subcommands.ts` does not list, and `outcome` was missing from the `flow` list, so the command answered `Unknown command: outcome` before the handler ran. The 0.3.33 tests called `flowCommand` directly and never went through the router. A new test compares every `case` in the `flow` switch with the router's list and runs the command through the real `cli.ts`.

## [0.3.33] — 2026-09-29

### Added
- **Who wrote the outcome criterion** — a flow's `flow.json` gains an optional `outcomeAuthor`, `agent` or `human`; a flow without it reads `unknown`, and reading never rewrites a file. `keryx flow init --outcome-author agent|human` records it: `agent` when the flag is absent, `human` only when the flag says so (never inferred from a git identity, an owner or the environment), and any other value is refused before the flow is created. With `human`, the `## Outcome criteria` section of `description.md` is the template's own text, byte for byte. `keryx flow schema` lists the field.
- **`keryx flow outcome author <id> agent|human --reason "<why>"`** — changes it. A missing reason or an unknown value is refused; the field and one `journal.md` line (old value or `unknown`, new value, reason) are written together; setting the value already held writes nothing. It is a `flow` command, so the product module keeps its four commands.
- **The author is shown** — `keryx flow status` prints an `outcome author:` line; `keryx product index` carries it on each flow intent (optional in `index.json`, so an older index stays valid; covered by the fingerprint); `keryx product open` and the TUI `/product` print it per entry, and the `/flows` detail tab shows it. The flag gates nothing: no completion, freeze, creation or index result depends on it.

### Changed
- **G1a is counted in four cells and G1b split by author** (`docs/requirements/keryx-product-module/implementation-plan.md`, `metrics-and-validation.md`): `human` or `agent` crossed with a real criterion or `not measured — <reason>`. Agent flows measure compliance with the instruction; human flows measure acceptance, and conclusions about acceptance come only from human flows. This replaces the 0.3.32 passage that said authorship is classified by hand; the author is now read from flow.json.

## [0.3.32] — 2026-09-29

### Added
- **Uncommitted closing-state note** — `keryx flow complete` writes flow.json, journal.md and reviews/ into the working copy after the pull request has merged, and nothing commits that afterwards, so a tracked flow directory commonly stayed dirty against HEAD. After a successful completion, and in `keryx flow status` for a `done` flow, keryx now prints one `note:` saying the flow directory has uncommitted changes, naming up to five changed entries (`+N more` beyond that), when git tracks the directory and it has changes; it does not claim to know what wrote them. Each git call is read-only (`--no-optional-locks`) and time-bounded. A directory git tracks nothing in, a clean one, no repository and any git failure print nothing. Read-only git, no model call, informational: it never changes an exit code or a completion result. The TUI `/flows` detail tab shows the same note.

### Changed
- **G1a is read separately by who created the flow** (`docs/requirements/keryx-product-module/implementation-plan.md`, `metrics-and-validation.md`): flows created by a person and flows created by an agent are counted apart, and an agent-created flow is a compliance check, not acceptance — the agent has just read the instruction to fill the slot. Authorship is classified by hand when the ten flows are read (flow.json does not record it), and the split between a real criterion and `not measured — <reason>` stays as a second axis.

## [0.3.31] — 2026-09-29

### Added
- **Outcome verdicts** (product module, G1) — an observation is now `outcome-observed: <verdict> — <note>` at column 0 of a flow's `journal.md`, with the verdict exactly one of `helped`, `no-effect`, `harmed`, `inconclusive`. A line inside a fenced code block is ignored. The index stores the verdict and the note, `IntentCounts` splits the observed count by verdict, and the split appears in the `product index` summary, the `product open` header and the TUI `/product` view.
- **Malformed observations are failures** — a line that starts `outcome-observed:` without a recognized verdict is listed by `product index`, naming the flow, and `index` exits non-zero. The flow stays in the `open` list (it was never validly observed) and is counted once by the staleness check; the header shows the failure count when it is non-zero.
- **`## Outcome criteria` slot** in the description template `keryx flow init` writes, after Expected Outcome. An untouched hint is not a declared criterion; `not measured — <reason>` states there is no instrument.
- **Docpack observations** — a requirements package may hold an `## Outcome observations` section in its README.md, one `- <verdict> — <note>` per line Fenced code blocks and HTML comments in the section are stripped first, and a section empty after that is no observation, not a failure. It is stored and parsed only: the package stays `open`. A malformed line is a failure naming the package.
- **`flow init` note** — when the new description states no intent statement the product index could extract, `flow init` prints exactly one informational line saying so. It uses the same extraction as the index, never changes the exit code and never blocks.

### Changed
- **Decision gate G1 split into G1a and G1b** (`docs/requirements/keryx-product-module/implementation-plan.md`): G1a over the next 10 flows created after this release, the share that declared an outcome criterion or `not measured — <reason>`, reported as two separate shares; G1b, 2–4 weeks after the release of those flows, the share of them that got a verdict. `map` is built only if both pass. The historical "310 of 310 never checked" number is recorded as the before arm in `metrics-and-validation.md`, not as evidence for the premise.

### Notes
- Nothing gates: no flow transition, freeze, confirm or complete reads a verdict, criterion or note. No existing flow or requirements package was edited, and the free-text `outcome-observed:` form of 0.3.30 is no longer a valid observation.

## [0.3.30] — 2026-09-29

### Added
- **`keryx product index [--json]`** (flow 362, product module P1) — reads every flow directory and every `docs/requirements/*/` package into one intent index at `.metaproject/data/product/index.json`. An intent is the Problem or Expected Outcome sentence, the criteria as `AcKindRecord`, the status, the close date and, for a requirements package, its outcome criteria. Deterministic: stable ordering, byte-identical on a second run, no timestamp in the body. The summary reports how many entries state no intent; a flow whose description holds only scaffold placeholders counts there and is not an error. The directory is disposable: delete it and the next `index` rebuilds an equivalent one, and nothing reads product data from anywhere else.
- **`keryx product open [--json]`** — lists intents closed in code with no recorded observation. Each row names the flow and its outcome criterion, or the literal text `not measured — no instrument stated`. The header splits the never-checked count three ways: no outcome criterion stated, criterion stated but never observed, observed. The index carries a sha256 fingerprint of the flow and requirements files it was read from, plus the package names; when the index is missing or unreadable, or the fingerprint no longer matches the tree, it exits non-zero and names `keryx product index` instead of answering from stale data. Content, not modification time, decides: a restored or renamed directory is caught and a bare `touch` is not.
- **Observations** — a line beginning `outcome-observed:` in a flow's `journal.md` is read by `index`, and that flow leaves the `open` list. Nothing writes the line.
- **TUI** — `/product` opens the same header and rows in a scrollable modal, and opens while a turn is running because it only reads.

### Notes
- The module is one directory, two commands, no skill, no subagent and no gate. It makes no model call, and no other command calls it: no flow transition, freeze, confirm or complete waits on it.

## [0.3.29] — 2026-09-28

### Added
- **Verification kinds on acceptance criteria** (flow 361, W0) — a criterion may end with one trailing marker: `[verify: exec `cmd`]`, `[verify: invariant `cmd`]`, `[verify: judged]` or `[verify: none — reason]`. The marker is part of the criterion line, so the freeze checksum covers it. A marker quoted in backticks is prose; two markers outside code, or a marker that is not last or does not close with `]`, is an error. An unmarked criterion is `unclassified`, never `none`. Nothing gates on a kind: freeze, `ac update`, confirm and complete behave exactly as before, and no existing criterion is migrated.
- **`keryx flow ac kinds <id> [--json]`** — reads the criteria file and reports each criterion's kind, the distribution and the runnable coverage. Read-only, no model call; exits `1` naming the criterion when a marker is malformed (that criterion reads `unclassified`).
- **`flow freeze` prints the distribution** and records a derived `acKinds` map on `flow.json`; `flow ac update` re-parses it in the same write as the new checksum. The file stays the source of truth; a malformed marker warns but never refuses.
- **Governance coverage** — `keryx governance report` shows an `acceptance coverage` line per flow. A flow with no `acKinds` reads as fully unclassified, not as zero criteria.
- **TUI** — the AC tab of `/flows` lists each criterion's kind under the same distribution block (`PgUp`/`PgDn` scroll it); a flow frozen before kinds existed says "not recorded".
- **Requirements standard** — `requirements-package-standard` requires a `Verification:` field on every specification requirement and splits the PRD's success criteria into release criteria and outcome criteria (an outcome criterion names its observation or declares `not measured — <reason>`). The `docpack-orchestrator` Verify phase fails a package that omits either, and accepts an outcome list whose entries are all `not measured`.

### Changed
- `flow check-ac` strips a trailing verification marker before it extracts a criterion's tokens or decides it is not checkable, so a marker's command text is never read as the criterion's wording. Unmarked criteria are byte-identical.

## [0.3.28] — 2026-09-28

### Added
- **Model-tier resolution is generation-aware** (flow 358) — within one family and vendor, a newer version now outranks an older one (`sonnet 5` over `5`, `opus 5.5` over `4.8`). A session on a newer model with an older, pricier model discovered never resolves `deep` to the older model: it keeps the session model, and `tier_resolution` / `tier_reasons` record why (`resolve:kept-older-generation-pricier`). `tier_reasons` now ends with a `resolve:<reason>` entry on every decision.
- **`light` is the next size step below the session model** — an Opus session with Sonnet and Haiku discovered gets Sonnet; Haiku is taken only when nothing sits between.
- **An agent fallback ranks candidate models when the deterministic ranking is refused or ambiguous** — one short call on the light tier of the session's own provider, shown discovered model ids and profile prices only (never a task), validated (foreign ids dropped, session model must be placed, standard/deep never below the session), cached by a catalogue hash in `tier-rank-cache.json`, and recorded as the new `tier_resolution: agent-ranked` (added to the dispatch and reviewer-input schemas). A failure, timeout or malformed answer keeps the session model. The rule states that it compares candidate models and never rates a task's own difficulty.
- **`keryx review tier` and the shell's `spawn_subagent` row show the resolution source** — including `agent-ranked` and, for the agent, its trigger, the model it ran on and whether the answer came from cache.
- The curated Anthropic lineup and seed profiles gain Opus 5.5 and Sonnet 5.5.

### Changed
- The Claude Code subagent alias map (`deep` → `opus`, `standard` → `sonnet`, `light` → `haiku`) is unchanged and now has a regression test.

## [0.3.27] — 2026-09-28

### Added
- **Trust a single MCP tool for the rest of a shell session** (flow 359 hardens it) — in `trust` mode the `use_tool` approval prompt offers `T` (readline) / "Trust this tool (this session)" (TUI dock). The grant is the exact qualified tool name, lives only in memory for that interactive session, is cleared by `/new` and by resuming another session, and only a validated operator answer can add to it: the model cannot. A `PreToolUse` hook that asks still asks.

### Security
- **A trust grant never lifts the untrusted-content floor.** In a turn that holds external content (a web result, or any MCP tool result, the trusted tool's own included) a trusted tool asks like any other, the prompt does not offer `T`, and it says why. The grant applies again in the next turn.
- **A trust grant is bound to the tool's definition, not only its name.** The session grant stores a fingerprint of the tool's name, description and input schema; if the server changes any of them, or the tool disappears, the grant is dropped and the call asks again.

## [0.3.26] — 2026-09-28

### Added
- **Google's Antigravity CLI (`agy`) ships as a third external agent, read-only** (flow 357) — a new registry row (`antigravity-cli`, label "Antigravity"), a line-stream codec (`src/harness/external/codec/antigravity-cli.ts`) parsing `agy -p --output-format stream-json`'s `init`/`step_update`/`result` events against a recorded live transcript, and an empty `EXTERNAL_RUNTIME_CREDENTIAL_ALLOW` entry (it has no API-key auth path — only its own subscription login under `HOME`). `worktree-write` is declared (the CLI supports it) and refused with `not-implemented`, same as every other line-stream agent today.
- **`antigravity-cli` sits on the `/external` block-list by default and needs one-time consent before its first dispatch** — Google collects prompts and agent actions ("Interactions") by default, so `/external off` refuses a dispatch before anything spawns (the same `ExternalBlockedError` a blocked LLM provider already gets), and a TTY-only consent prompt, recorded once at `externalAgents.consent["antigravity-cli"]`, is required before the first run; a non-TTY dispatch with no recorded consent is refused with `consent-required` rather than assuming "yes". Both gates hold for a model-initiated dispatch (`/delegate`, `spawn_subagent`) as well as for `run`.
- **A tool `agy` auto-denies in headless mode is reported as `Denied`, not as success** — measured live: `agy` reports `status: SUCCESS` with an empty answer and lists the refusal in `result.denied_actions`. keryx names each denied action and points at a `permissions.allow` rule in `agy`'s own settings; it never passes `--dangerously-skip-permissions`. Tool calls show up as tool events instead of unrecognised lines.
- **`keryx agents external run` now drives line-stream (codec) agents, not only ACP ones** — `codex-cli`, `claude-cli` and `antigravity-cli` can all be run directly (`keryx agents external run <id> --task "…"`), not only delegated to from the interactive shell; `runExternalChild` already supported both transports, only this command's own early refusal did not.
- **A real, recorded live run proves the `antigravity-cli` path end to end** — `fixtures/external/live/antigravity-cli/2026-09-28/keryx-run-ok.{outcome,versions}.json`, produced through `keryx agents external run antigravity-cli` itself (agy 1.2.12), completed with a schema-valid structured result and zero unrecognised transcript lines.

## [0.3.25] — 2026-09-28

### Fixed
- **The idle-wake shell test no longer flakes on slow runners.** It fired background completions until the model was called, which left a gap after the shell took the first one where a second completion queued a second notification turn ahead of the operator's line. It now stops firing once the shell has taken one completion. This flake stopped the v0.3.24 release run once.
- **Pull-request CI now runs the `scripts/` tests.** They ran only in the release workflow, so the retired-spelling check that stopped 0.3.23 could not fail a pull request. `test:core` includes `scripts/` (about 50 s).

## [0.3.24] — 2026-09-28

### Fixed
- **Release 0.3.23 did not reach npm.** Its release workflow stopped on the retired-spelling check: the help text moved from `cli.ts` to `cli-registry.ts` (flow 356) without the file-level declaration `cli.ts` carried, and two new texts spelled `keryx mcp serve`. 0.3.24 carries the declaration and the current spelling; it contains everything listed under 0.3.23.

## [0.3.23] — 2026-09-28

### Fixed
- **Four architecture import cycles cut** (A-1, A-2, A-3, A-5): `security/service.ts` no longer re-exports the impact-evidence module — it moved to its own `src/impact-evidence/` core zone; `CLI_ROUTES`/`printCommandHelp` moved out of `cli.ts` into a new `src/cli-registry.ts` (the `help` route resolves through a dynamic import so the module can't recreate the cycle with `commands/help.ts`); `keyFilesForPage` moved to `src/wiki/key-files.ts`; `parseJsonTolerant` moved to `src/mcp-servers/json-utils.ts`. `keryx gdgraph query cycles` now lists only the two already-accepted facade loops (A-4).
- **`retryableFor` deduplicated across all four provider adapters** (A-6) — one copy, exported from `harness/provider/provider-port.ts`, replaces four byte-identical local copies; every adapter's retry-taxonomy tests pass unchanged. `mergeUsage` stays per-adapter: the four bodies map genuinely different provider-specific usage fields, so a shared helper would only add indirection.
- **`keryx gdgraph query orphans` no longer reports a `bunfig.toml` `preload` file as dead code** (A-8) — `src/lib/test-preload.ts` and any other declared preload entry are now treated as graph roots instead of unreferenced files.
- **`keryx security scan` respects the repository's own ignore rules and stopped running out of budget on its own tree** (G-2) — ignored paths (`.gitignore`, plus the hardcoded `.claude/worktrees`, `.git`, and `node_modules`) are skipped before they are opened and listed under the scan report's `coverage.skipped`; `--no-ignore` restores the previous behaviour. The default `maxFiles`/`maxBytes` scan ceiling was also raised (1,000 files / 8 MiB → 20,000 files / 128 MiB) to match this repository's own real, versioned size (measured at 9,556 files / 92.4 MiB after every ignore rule). `keryx security scan . --json` on this repository now reports `coverage.status: "complete"`.
- **`keryx update` now lists, and on confirmation prunes, stale agent worktrees under `.claude/worktrees/`** (G-5) — only a worktree at least 7 days old with zero commits ahead of `main` and no uncommitted changes is ever offered; `--yes` skips the confirmation prompt for unattended/CI runs.
- **`keryx doctor` run outside a keryx project no longer reads as a failure** — a directory with no `.metaproject/` now gets one `warn` line ("not a keryx project — run `keryx init`") in place of every project-scoped check, and the command exits 0 instead of failing on checks that were never going to pass.
- **`keryx doctor`'s stale-worktree check, and `keryx update`'s new pruning, resolve `.claude/worktrees` beside the main checkout** (via `git rev-parse --git-common-dir`), not beside the current working directory — run from inside a linked agent worktree, both used to report no `.claude/worktrees` directory at all while the main checkout had many.
- **An OpenAI-compatible-gateway stream carrying an in-band `{"error":…}` envelope with no pending tool call now ends the turn with a classified `provider_error`**, the same way a pre-2xx HTTP error from the same gateway would, instead of silently ending the stream with no terminal event at all.
- **`parseGrokToml` no longer echoes a raw config value, or a whole raw config line, into its problem message** — a Bearer token in an unsupported inline-table `headers` field (or any other value/line this reader cannot parse) no longer prints in `mcp list --json` warnings, `mcp doctor`, or the `/mcp` panel; the message now names the key and the unsupported form only, never the value.
- fix(harness): an unrecognized non-numeric in-band `error.code` from an OpenAI-compat gateway no longer defaults to a retryable "unavailable" server outage — known-transient codes (`rate_limit_exceeded`, `server_error`, `overloaded`, `overloaded_error`, `timeout`, `timeout_error`, `service_unavailable`) still classify as retryable, `context_length_exceeded` and numeric codes are unchanged, and every other (including unrecognized) code now classifies as non-retryable `invalid_request` (review round 1, L1).
- fix(doctor): `isKeryxProject`'s upward `.metaproject` search is now bounded — inside a git repository it stops at the repo's own toplevel, outside one it stops at (and excludes) `$HOME`'s parent, and it never considers `/tmp` or the filesystem root as a candidate — so a stray `.metaproject`/`.git` anywhere above a bare temp directory can no longer make `keryx doctor` misreport a non-project as a keryx project (review round 1, L2/TEST-1).
- fix(gdgraph): `bunfigPreloadRoots` now strips `#` comments before matching `preload = […]`, so a commented-out preload line no longer suppresses its file from `gdgraph query orphans` (review round 1, L3).
- fix(core): BREAKING (core API): `core.security.{appendLogRecord, computeImpactEvidence, createImpactEvidenceProvider, hostDeliveryStatus, normalizeRequestFiles, readLogRecords, renderEvidenceBlock}` moved to `core.impactEvidence.*` — flow 356's A-1 cycle-cut had silently dropped these from the published npm package surface with no compile-time warning; `core.ts` now re-exports `impact-evidence`'s own public door as an eleventh facade, and `core-package.test.ts` pins both namespaces' member names (review round 1, REG-1).
- fix(update): `keryx update`'s stale-worktree prune now also checks for gitignored-but-present files (`git status --porcelain --ignored=matching`) — a worktree with an uncommitted, gitignored secret file (e.g. `.env`) is no longer silently deleted; `node_modules`, `.metaproject/data`, and `dist` stay allowlisted carry-overs, and the confirmation prompt states exactly what was checked instead of overstating "clean" (review round 1, REG-2).
- fix(security): `keryx security scan` now still opens secret-bearing filenames (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`, `*.tfvars`, `.git-credentials`, `secrets.*`, `service-account*.json`) even when `.gitignore` covers them, peeking up to 3 levels into an otherwise-skipped ignored directory to find one; the CLI summary now names up to 5 skipped paths and how to see the rest (`--json`) or include them (`--no-ignore`) (review round 1, SEC-356-01).
- fix(mcp-servers): `parseGrokToml`'s two remaining raw-line-echo sites (an `[[mcp_servers…]]` array-of-tables header, and the generic unrecognized-bracket-line catch-all) no longer interpolate the raw config line into problem messages that reach `mcp list --json`/`mcp doctor`/the `/mcp` panel — both now report a shape-only description instead (review round 1, SEC-356-02).
- fix(impact-evidence): `provider.ts` now imports `loadSecurityConfig`/`resolveImpactEvidenceConfigTrusted` through the `security/service.ts` facade instead of reaching past it into `security/config` directly, matching the module's own facade discipline (review round 1, ARCH-R1-F1).
- fix(tests): `src/commands/bundle.test.ts`'s temp-dir helper now stamps an empty `.git` into every fresh test root the moment it is created — `bundleCommand`'s own unbounded upward `.metaproject`/`.git` walk (`resolveBundleProjectRoot`) could otherwise escape a fresh mkdtemp'd root into the OS temp directory itself and, if `/tmp` already carried a stray `.metaproject`, silently write a test's fixture there instead — reproduced directly (with a simulated `/tmp/.metaproject`, 9 of 16 tests failed and `acme-widget` landed under `/tmp/.metaproject/skills/`) and confirmed fixed.

## [0.3.22] — 2026-09-28

### Fixed
- **Public review reports no longer attribute a run to the operator's GitHub
  account.** `How this review was run` lists the workflow, models, tools,
  skills and subagents that actually participated; missing facts are marked
  `not recorded`, never guessed from the active `gh` login. The bundled and
  installed review-orchestrator templates have the same privacy rule.
- **A message queued through the busy-turn recipient selector now runs when
  the selector resolves after the turn has already settled.** A guarded idle
  drain takes the forced item first or the FIFO head; it never dispatches while
  the main turn, pause lease or cancellation handoff is active.

## [0.3.21] — 2026-09-28

### Fixed
- **A secret dressed as a word slug with a hex tail (`<word>-<word>-<hex>`) is now redacted when labelled** — the LABELLED path (`redactSensitiveText`, `security/detect/entropy.ts`) no longer consults any word-slug exemption at all; only an allow-shape, a hex blob, or separator-stripped entropy reaching the floor can qualify a labelled value. An UNLABELLED secret in the same shape, with a 10-16 character hex tail, remains an accepted, documented residual (see `findings.md` row S-8).
- **A labelled secret preceded by an ordinary filler word ("password is: …") or split across an explicit shell-style line continuation (`export API_KEY=\` then the value on the next line) is now redacted** — `ADJACENT_LABEL` tolerates up to two closed-set filler words between the label and the connector, and a new `isAdjacentLabel` check recognises an explicit continuation marker (`=\`, `:\`, `= \`, or a bare `\`) at the end of the previous line.
- **`web_fetch`/`web_search` no longer refuse an ordinary public Gist, GitHub commit/blob, or GitLab commit URL** — a small, documented host+path-shape allowlist in `harness/web/outbound-secret.ts` exempts `gist.github.com/<user>/<hex32>` (and the anonymous `/<hex32>` form), `github.com/…/commit/<sha40>` and `/…/blob/<sha40>/…`, and `gitlab.com/…/-/commit/<sha40>` from the outbound secret-shape check only; redaction of the same value in tool output is unchanged.
- Fixed a stale header comment in `entropy.ts` that claimed `token=abcdefghijklmnopqrstuvwx12345678` was deliberately missed as "low-entropy" — the value is in fact maximal-entropy (all 32 characters distinct) and has always been caught; the comment now says so.
- Fixed a flaky redaction test: `redact.test.ts`'s labelled/unlabelled UUID coverage now uses 20 fixed UUIDs (committed in the test, individually confirmed not to trip the unrelated `pii.credit-card` detector) instead of unseeded `crypto.randomUUID()` values, and asserts on the entropy redaction marker specifically rather than a looser "value is gone" check.
- Also shipped in 0.3.19–0.3.20: `LABEL=VALUE` assignment shapes (`api_key=…`, `--token=…`) and camelCase labels (`apiKey: "…"`) are now recognised and redacted, closing a gap where `=` inside the token character class fused the label into the candidate and where camelCase had no non-alphanumeric boundary character at all.

## [0.3.20] — 2026-09-28

### Fixed
- **A secret re-chunked into hyphenated pieces no longer bypasses redaction
  or the outbound-egress check.** `security/detect/entropy.ts`'s `isWordSlug`
  exempted a hyphen/underscore-segmented run from the entropy gate whenever
  every segment was pure-alpha, pure-digit, or a short letter-then-digit
  "tag" — with no check on the RECONSTITUTED value's own randomness. A real
  secret formatted as `aK-9-dQ-2-rN-…` or word-wrapped as
  `log-<scrambled-case letters+digits>-id` sailed through `looksSecretShaped`,
  `redactSensitiveText` (S-6), and `containsOutboundSecret` (S-8)
  untouched. Fixed: a segment now only counts as a real word or version tag
  if its letters are plainly cased (all-lowercase, all-uppercase, or
  Capitalised) — language never scrambles case letter-by-letter, but a
  hyphen-chunked secret often does.
- **An ordinary Medium or GitHub Gist URL no longer gets refused by
  `web_fetch`.** Those sites' common `<slug>-<hex-id>` URL convention (one is
  already linked from this repo's own
  `docs/requirements/keryx-wiki-graph-next/README.md`) interleaves letters
  and digits in its trailing id many times, which failed every existing
  slug-segment shape and fell through to the entropy gate. A slug's LAST
  segment is now recognised as a public post/gist id when it is a 10-16
  character pure-hex run.
- **The generic (non-URL) redaction scan no longer flags ordinary paths and
  comments that merely mention a sensitive word nearby.** `TOKEN` still
  compounded any `/`-bearing run (a relative doc link, a filesystem path)
  into one candidate, and the label look-back was same-line PROXIMITY (40
  characters), not true adjacency — a "Credential Masking" heading two
  sentences before an unrelated ADR link, a GitHub noreply email's local
  part near an unrelated "key", a Python `from_attributes=True` near "the
  API.", and a `passlib/bcrypt/argon2` comment near "password" were all
  false positives on this repository's own real `git log`/docs content.
  Fixed: a match now requires the label to be genuinely ADJACENT (the label
  word, its continuation, then only quotes/`:`/`=`/whitespace before the
  value), and a `/`-bearing candidate is decomposed into its pieces and
  scored separately, the same principle a URL's own path segments already
  get.
- **A labelled UUID is now redacted reliably, not about 75% of the time.**
  `bareShapeQualifies`'s own 3.6-bit entropy floor ran BEFORE the label was
  ever consulted, so whether a UUID explicitly called out as leaked
  (`"leaked credential: <uuid>"`) was redacted depended on how its own hex
  digits happened to repeat — the canonical RFC 4122 example UUID (entropy
  3.39) was not. An allow-shape (UUID, full git commit SHA, npm/yarn
  integrity string) now qualifies regardless of its own entropy once a label
  is confirmed adjacent to it.
- Real-file sweep over `bun.lock`, `CHANGELOG.md`, `git log -p -30 --stat`,
  and every `docs/**/*.md`: 48 `[REDACTED:entropy]` matches before this fix
  (6 false positives — the 5 label-proximity shapes above plus the Medium
  URL), 41 after (0 false positives remaining).

## [0.3.19] — 2026-09-28

### Fixed
- **Browser and other MCP tools no longer ask twice for the same call.**
  One approval now covers both the tool's risk and untrusted external
  content seen earlier in the turn, including ACP clients. `trust` still
  asks for each destructive MCP call, and `auto` still asks after external
  content; an approval cannot be reused for another call.
- **`redactSensitiveText` now catches opaque high-entropy secrets, not just
  named patterns.** The one scrubber every tool output and web-fetched page
  goes through (`src/security/redact.ts`) ran only the pattern detectors; a
  bearer token or raw key with no recognized prefix reached the model
  unredacted. It now also runs `security/detect/entropy.ts` — the same
  thresholds `keryx security scan` uses — masking a qualifying match as
  `[REDACTED:entropy]`. The entropy detector gained allow-shapes (a 40-hex
  git commit SHA, a 7–12-hex short SHA, a UUID, an npm/yarn `sha256-`/
  `sha512-` integrity string) so ordinary `git`/`bun`/`npm` output is never a
  false positive — measured at zero across a 200-sample fixture of realistic
  command output (`git log --oneline`, `git show --stat`, `bun test`
  summaries, `npm`/`bun install` with integrity hashes, `ls -la`, `docker
  ps`, stack traces with hex addresses).
- **The prompt-injection phrase detectors now survive a line break or a
  Cyrillic/Greek homoglyph.** `security/detect/injection.ts`'s phrase gaps
  excluded newlines (`[^.\n]{0,N}`), so a trigger phrase wrapped across a
  line — "Ignore all previous\ninstructions" — was not detected though
  nothing about the attack changed at the line break; a period still ends a
  gap. Matching now also runs on a length-preserving confusables fold
  (Cyrillic/Greek look-alikes, plus NFKC when it does not change length), so
  "Ignіre all previous instructions" (a Cyrillic і substituted for the
  Latin 'o') is caught too.
- **`web_fetch`/`web_search` now refuse to send secret-shaped content off
  the machine.** Both tools checked the target host was public but never
  whether the model-supplied URL or query itself carried a credential.
  `harness/web/outbound-secret.ts` runs the same pattern-and-entropy floor
  `redactSensitiveText` uses on the URL/query BEFORE any network connection,
  refusing with `"outbound secret-shaped content"` and recording an
  `egress.outbound-secret` incident (`.metaproject/data/security/
  incidents/`) when it fires.
- **`keryx mcp list`, `mcp doctor --json`, and the trust prompt no longer
  print a credential that lives in a URL PATH segment.** `displayUrl`
  (`mcp-servers/http-headers.ts`) elided query strings and userinfo but kept
  the path verbatim — `https://host/v1/<token>/mcp` showed the token in
  full, which is exactly how a live credential was once seen in `mcp list`
  output. Any path segment of 16 or more characters that matches a secret
  pattern or the entropy detector's shape is now replaced with `…`; a short
  or ordinary segment (`v1`, `mcp`, `users`) is untouched.
- **The win32 device-code verification URL no longer opens through a
  shell.** `lib/oauth/open-url.ts` ran `cmd /c start "" <url>`, and `cmd.exe`
  re-tokenises its own command line — a `verification_uri` containing `&`
  could run a second command. The win32 plan now validates the scheme
  (`https`, or `http` to loopback only) and a strict RFC-3986-based
  character allowlist before spawning `rundll32 url.dll,FileProtocolHandler
  <url>` with the url as a single, unparsed argv entry.
- **The third-party-child credential filter moved to a shared, better-named
  home, is now fully case-insensitive, and no longer over-matches a glued
  compound.** `isDeniedForMcpChild` — the shape check that decides what a
  spawned MCP server or an external agent CLI's environment may keep — moved
  from `mcp-servers/spawn-env.ts` to `src/security/credential-shape.ts`,
  the single home both callers now import through the security facade.
  `harness/external/env.ts`'s own by-name denial list is now compared
  case-insensitively rather than relying on the shape check behind it to
  catch a lower-case spelling. The glued-compound regex (`PRIVATEKEY`,
  `REFRESHTOKEN`, `DBPASS`, …) is now anchored to the variable name's own
  boundaries, so it no longer matches inside an unrelated longer name (e.g.
  `APITOKENIZER`).
- A URL's own host or path no longer defeats the entropy redactor or the
  outbound-secret check. The entropy detector's token pattern included `/`,
  so a URL's `host/path/…/<sha>` was scored as ONE joined run — that escaped
  the allow-shapes (the joined string is not a bare SHA) and could pick up a
  false "sensitive label" from a hostname substring like `api.github.com`.
  `security/detect/entropy.ts` now decomposes a recognised URL into its path
  segments, query values and fragment and evaluates each separately and
  label-free; `harness/web/outbound-secret.ts`'s pre-flight check calls the
  SAME shared function (not a second, independent copy) so a secret hiding
  behind an anonymous query param name, or a percent-encoded param name, is
  still caught before anything is fetched.
- A `+`-joined multi-word search query (`q=bun+test+timeout+flaky` — exactly
  what `web_search` sends on the wire) was scored as one high-entropy run and
  refused/redacted. `+` is now swapped for a literal space before
  re-tokenising a URL component, matching the space convention
  `application/x-www-form-urlencoded` already uses.
- A versioned package tarball URL (`typescript-5.6.3.tgz`, and similar
  npm/PyPI/crates shapes) was evaluated as one whole path segment in the
  outbound check instead of being re-tokenised the way the redaction path
  already was, and refused `web_fetch`. Both surfaces now call the identical
  shared re-tokenising function, so they cannot answer differently for the
  same bytes again.
- A Python wheel filename's platform/version tags (`cp311`, `manylinux_2_17`,
  `x86_64`) broke the word-slug exemption entirely, since a single
  letter+digit segment used to reject the whole slug. A segment that
  transitions at most once between a letter-run and a digit-run (either
  direction) is now treated as structured, not random — same as a pure word
  or a pure number — while a segment that alternates more than once still is
  not and still blocks the exemption.
- A sensitive label next to a value now overrides an allow-shape instead of
  losing to it. `'leaked token: <40-hex sha>'` used to stay unredacted
  because the SHA "looked like" an ordinary git commit hash; an explicit
  adjacent label (`token`, `key`, `secret`, `credential`, `auth`, `bearer`,
  word/segment-bounded) now wins, and the allow-shape only still applies when
  nothing labels the value at all.
- A purely numeric value is never treated as a "hex blob" any more. A
  24-or-more-digit order id, phone number or timestamp could be masked by
  `redactSensitiveText` and by `displayUrl`'s path-segment masking; both now
  require at least one a–f letter before accepting a value as hex-shaped —
  closing the gap rather than narrowing it, since a base-10 alphabet's
  Shannon entropy can never reach the redaction floor at any length.
- The environment-variable credential filter's "glued compound" rule is
  anchored on the correct side. `PRODDBPASS`, `MYPRIVATEKEY`,
  `USERREFRESHTOKEN`, `LEGACYACCESSTOKEN`, `V2APITOKEN`, `OAUTHACCESSTOKEN`
  and `SNOWFLAKEDBPASS` all evaded the previous (prefix-anchored) fix; the
  glued shape is now anchored at the SUFFIX end instead, which catches all
  seven while still allowing `APITOKENIZER`/`TOKENIZERS_PARALLELISM`/
  `KEYBOARD_LAYOUT`/`APPCONFIG`.
- Disabling the entropy backend in `security.config.json` now actually
  disables it everywhere, including the outbound check's per-component scan,
  not just the whole-string pass.
- An avoidable import-policy bypass introduced while moving the
  credential-shape classifier has been removed, and the ratchet in
  `import-policy.live.test.ts` is back at its previous ceiling.
- Removed dead code (`SHORT_GIT_SHA_RE`): no value under 13 characters can
  ever satisfy the entropy-or-hex-blob floor, allow-shape or not.

Documented (not fixed — deliberate, recorded rather than papered over):
- The outbound-secret check cannot see a credential deliberately split across
  two or more params/segments, each individually below the shape threshold —
  there is no single value for a per-value check to test.
- A presigned URL's signature (AWS `X-Amz-Signature`, GCS `X-Goog-Signature`,
  an Azure SAS `sig=`) is refused by `web_fetch`'s outbound check exactly
  like any other secret-shaped query value; fetching a presigned URL is out
  of scope for that tool by design. The SAME value arriving in tool output is
  correctly redacted, not refused, by `redactSensitiveText`.
- A Google Docs/Drive file id is capability-like (whoever holds it can open
  the file) and is treated the same way: refused outbound, redacted in tool
  output.

Found, not fixed (pre-existing, unrelated subsystem, flagged for a separate
decision): `detect/pii.ts`'s `pii.phone` pattern matches an arXiv paper id's
`YYMM.NNNNN` shape (e.g. `2103.00020`) as a phone number and redacts it. Not
touched here — it is not an entropy or outbound-check defect.
- **A package name no longer counts as a secret label.** The camelCase
  label boundary matched lowercase letters too, and any label word only had
  to appear somewhere nearby, so lockfile lines for `keyv`,
  `eslint-visitor-keys` or `path-key` had their public integrity hashes
  redacted. A label now overrides an allow-listed shape (SHA, UUID,
  integrity) only when it sits directly before the value.

## [0.3.18] — 2026-09-28

### Fixed
- **The four provider adapters now agree on a truncated stream, an
  in-stream error, and a missing tool-call id.** A shared contract test
  (`src/harness/provider/stream-contract.test.ts`) runs the same three rows
  against `anthropic`, `openai`, `gemini`, and the OpenAI-compatible engine:
  (a) a stream that ends while a tool call is still accumulating now yields
  exactly one `provider_error` (`kind: "malformed"`, naming the pending call
  in `detail.pendingToolCallId`) instead of the compat adapter silently
  synthesizing a `tool_call_end` from truncated JSON; (b) Gemini's streaming
  loop now classifies an in-band `{"error":{…}}` envelope through the same
  taxonomy a pre-2xx failure gets (a 503 envelope mid-stream is now
  `retryable: true`, not a generic non-retryable `malformed`); (c) a Gemini
  tool call sent with no id now gets a synthetic id unique within the
  response (`${name}#${index}`), so two same-named calls in one response no
  longer collide onto one id and have a result attributed to the wrong call.
- **The ChatGPT-subscription branch's missing `max_output_tokens` is now
  documented as required, not accidental.** A probe against the subscription
  Responses endpoint returns HTTP 400 `Unsupported parameter:
  max_output_tokens`; the comment beside the omission and a test now say so.
- **OpenAI cache-read tokens are no longer silently dropped from cost
  accounting.** `usage.input_tokens_details.cached_tokens` now populates the
  normalized usage's `cacheReadTokens` (mirroring the field Anthropic's own
  usage carries); `keryx shell`'s per-turn cost estimate applies OpenAI's
  documented 50% cached-input discount to those tokens instead of billing
  every input token at full price.
- **A throwing tool no longer crashes an agent turn and skips the `Stop`
  hook.** The sequential tool-call loop (`src/commands/agent.ts`) now wraps
  each call in the same defensive try/catch the concurrent subagent-spawn
  path already had: a `tool.invoke`/`requestApproval` callback that throws
  degrades to an `isError: true` tool result, the turn finishes normally, and
  the `Stop` hook still fires.
- **`/new` and `/clear` in `keryx shell` no longer leave `/expand` pointing
  at the abandoned session.** Both now reset the collapsed tool-output cache
  `/expand` reads, so running it right after prints "Nothing to expand"
  instead of the previous session's last tool result.
- **`keryx shell`'s idle-completion waiter no longer leaks one closure per
  operator line.** A waiter from an earlier, already-settled read/completion
  race is now dropped before a new one is registered — bounded at roughly one
  live entry instead of growing for the life of the session when background
  completions rarely fire.
- **`provisionWorktrees` no longer leaks a partially-provisioned batch.** If
  a later `git worktree add` throws, every worktree the same call already
  created is now removed (best-effort, never masking the original error)
  before the failure is rethrown.
- **Two audit-ledger findings closed as documentation-accuracy fixes.** The
  `credential-boundary.test.ts` header no longer implies live AC1 coverage it
  doesn't have — it now states plainly that the guarded functions have no
  production caller today. A duplicate source-text audit in
  `shell-bus.test.ts` (already covered by a stronger runtime test in
  `shell-agent-repl.test.ts`) is removed.

Audit ledger: `docs/requirements/keryx-audit-remediation/findings.md` rows
L-1, L-2, L-3, L-10, L-11, L-12, L-13, L-14, L-15, R-M3, R-I3 closed; L-9
stays open pending a Gemini credential to probe against.
- **A tool crash during an unattended trigger run ("keryx trigger") is
  recorded as a failed run again, not a silent completion.** AC4/L-12's
  sequential-loop error boundary (0.3.18) stopped a throwing tool from
  crashing the whole turn — but the two unattended trigger dispatchers
  (`trigger-dispatch.ts`'s `dispatchLocked`, `trigger-agent-task.ts`'s
  `runLocked`) used exactly that crash (the turn's promise rejecting) as
  their only signal that something went wrong. `RunAgentTurnResult` now
  carries `caughtToolErrors` — populated by both the sequential loop and the
  concurrent spawn-batch's own defensive floor — and both trigger callers
  fold a non-empty list into their existing crash/outcome classification, so
  the run is recorded failed with the tool name and message, same as before
  AC4/L-12.
- **The OpenAI cached-input cost discount no longer applies to every
  provider.** `estimateTaskCostUsd`'s 50% cached-token discount (0.3.18,
  L-11) is OpenAI's own documented rate — it now applies only for
  `providerId` `"openai"`/`"openai-codex"`; every other provider's
  `cacheReadTokens` are billed at the full input rate until that provider's
  own rate is researched and named, never a fabricated discount.
- **The OpenAI-compatible engine (OpenRouter, DeepSeek, Z.AI, x.ai, …) now
  reports cache-read tokens too.** `usage.prompt_tokens_details.cached_tokens`
  (confirmed against x.ai) now populates the normalized usage's
  `cacheReadTokens`, the same field the native OpenAI adapter fills.
- **The runtime test that replaced the deleted "leaves the bus before
  releasing the lease" source-text audit (R-I3) now actually checks that
  ordering.** It previously proved both cleanup steps ran on a crashing turn
  but not their order; it now wraps the real `BusClient.leave()` to confirm
  the session lease is still held at the moment the bus is left.

- `docs/requirements/keryx-audit-remediation/findings.md`: version 0.2.0 →
  0.2.1. New row **L-16** (open, low): the OpenAI-compatible adapter's
  streaming loop silently drops an in-band `{"error":…}` envelope that
  touches no tool call — no `model_end`, no `provider_error` — a narrower,
  deliberately-deferred gap distinct from L-1. Pinned by
  `stream-contract.test.ts`, not fixed in this round.

## [0.3.17] — 2026-09-27

### Added
- **`keryx doctor [--json]`.** One page, one pass: keryx's own version and
  update availability, the running Bun version against `package.json`'s
  documented floor, whether `ripgrep` is on `PATH`, the OS sandbox launcher,
  which providers have a credential configured (names only, never values),
  MCP servers' config validity and trust/approval state, drift in any
  installed editor/agent integration, Metaproject Standard warnings, stale
  `.claude/worktrees` entries, and graph/wiki freshness (read from the last
  report, never recomputed). Every line is `ok`, `warn` or `fail` with a fix
  hint; exits `0` unless something is `fail`; `--json` emits
  `{checks:[{id,status,detail,fix?}]}`. Runs in well under a second on a
  normal checkout. `/doctor` in `keryx shell` (readline and the TUI) prints
  the identical report inside the session.

### Fixed
- **An unknown command or subcommand no longer dumps the full usage block.**
  `keryx docto` (and an unknown `keryx mcp <sub>`, which points at `keryx mcp --help`)
  now print exactly one line to stderr — `Unknown command: docto. Did you mean: doctor? Run
  \`keryx --help\` for the list.` — with up to three "did you mean"
  suggestions by edit distance, and exit `1`. Previously the diagnostic went
  to stderr but the entire ~9.5 KB usage block followed it to **stdout**.
- **`keryx mcp list` no longer exits non-zero over someone else's config.** A
  malformed foreign file it merely reads for compatibility (Cursor's
  `~/.cursor/mcp.json`, Claude Desktop's `~/.claude.json`, a project's own
  `.mcp.json`, Grok's TOML config) now prints under a `warnings:` block
  (`warnings` in `--json`) and exits `0`; only a problem in keryx's own
  native config (`.keryx/mcp-servers.json`) still exits `1`.
- **`keryx memory search` matches inflected forms.** Lexical mode now stems
  both the query and each entry's title/body with a small English suffix
  stemmer, so `release` also finds an entry that only ever wrote
  `released`/`releases`/`releasing`. A zero-hit lexical search now also
  prints a hint: `--semantic` when an embeddings index already exists for
  the project, otherwise how to build one (`keryx memory index
  --embeddings`) — `semanticHint` in `--json`.
- **`keryx health run` no longer reports `tests: missing` on a tree where
  tests are actually available.** Root cause: in the default "auto" mode,
  when no persisted `.metaproject/data/testing` report existed to import,
  `runAdapter` (`src/health/run.ts`) hardcoded the `tests` source's status to
  `"missing"` regardless of what `detect()` had already established (`bun`
  on `PATH` and test files present) — contradicting `keryx health sources`'
  own `detect()`-only view, which had always correctly called the same tree
  `available`. It now reports what `detect()` found instead of overriding
  it; `bun test` is still never run as a silent side effect of `auto` mode
  (unlike ESLint/TypeScript, `bun test` has no narrower default scope) — the
  source is `available`, execution `not-run`, findings `0`. A genuinely
  `missing` optional source (e.g. no `bun` binary at all) now also names
  which check failed in the gate's report line.
- **Bare `keryx providers` prints the status summary, not usage.** Matches
  `keryx providers status`; `keryx providers --help` is unchanged.
- **An unknown SUBCOMMAND of a known group now gets the same one-line
  treatment, for ~38 groups, not just the top level and `keryx mcp`.**
  Review round 1 of this flow found that `keryx health rn`, `keryx wiki
  serach` and every other group with real subcommands still dumped that
  group's full usage on a typo — only the top-level dispatch and `keryx mcp
  <sub>` had been fixed. `keryx <group> <bad-subcommand>` now prints one
  line to stderr — `Unknown command: rn. Did you mean: run? Run \`keryx
  health --help\` for the list.` — naming that GROUP's own `--help`, not the
  top-level one, and exits `1` with empty stdout. Implemented centrally in
  `cli.ts`'s dispatch, driven by a hand-verified per-group subcommand table
  (`src/lib/group-subcommands.ts`) — deliberately not derived from the
  agent-callable command registry or the flat top-level usage block, both of
  which are incomplete for several groups (e.g. `health` and `wiki`) and
  would have produced false "unknown command" reports for real subcommands.
  Covers: modules, projects, providers, routing, external, auth, version,
  gdgraph, ctx, wiki, stack, health, metrics, test, memory, flow, job,
  review, rules, standard, security, sandbox, integrate, integrations, mcp,
  workspace, retention, forgetting, trigger, schedule, governance, hooks,
  bundle, learn, sessions/session, serve, bus, dashboard, skills. Left out,
  deliberately, wherever the first argument is a genuine positional (a path,
  a free-text prompt, an id, an optional runtime name) rather than a closed
  subcommand vocabulary, or where the group already manages its own
  `--help`/error surface (`agents`, `shell`).

## [0.3.16] — 2026-09-27

### Fixed
- **Chat-mode `keryx shell` releases its session lease and leaves the bus on
  every exit**, including a thrown slash command or line source — 0.3.15 fixed
  this for agent mode only.
- **Ctrl-C during the budget wrap-up round is reported as an interruption**,
  and the text cut mid-stream no longer enters history as a finished turn.
- **`wiki enrich --deep` no longer leaks an abort listener per failed page**
  onto the batch's shared cancellation signal.

## [0.3.15] — 2026-09-27

### Security
- **External agents no longer inherit the operator's credentials.** A Codex,
  Gemini or Claude Code child now gets the same shape-based credential strip an
  MCP server gets: `SSH_AUTH_SOCK`, `GIT_ASKPASS`, cloud credential files,
  `GITHUB_TOKEN` and other providers' keys stay behind. Only the key the target
  CLI itself signs in with passes (`OPENAI_API_KEY` for Codex,
  `GEMINI_API_KEY`/`GOOGLE_API_KEY` for Gemini).
- **Web search keeps its API key on its own host.** A redirect to another origin
  is still followed, but without the credential.
- **A timed-out sub-agent's partial output is quarantined** like every other
  sub-agent result.
- **MCP servers stop receiving glued credential names** such as `REFRESHTOKEN`,
  `PRIVATEKEY` or `DBPASS`.
- **Changing an MCP server's `oauth` block (client id, scopes, callback port)
  needs re-approval.** Servers without an `oauth` block keep their approval.

### Fixed
- **Ctrl-C reaches sub-agents.** Aborting a turn now stops an in-flight
  `spawn_subagent` child, a parallel batch of them, and the budget wrap-up round.
- **`keryx shell` releases its session lease when a turn fails**, so the next
  `-r` does not need `--take-over`, and Ctrl-C stops background jobs as `/exit`
  does.

## [0.3.14] — 2026-09-27

### Fixed
- **A session on the ChatGPT subscription (`openai-codex`) or Gemini can spawn
  sub-agents again.** Every `spawn_subagent`, including the review
  orchestrator's reviewers, was refused with `provider "openai-codex" is not
  classifiable`: the child-model gate only knew Anthropic, Ollama and the
  OpenAI-compatible providers, not the native adapters.

## [0.3.13] — 2026-09-26

### Fixed
- **`wiki enrich` and other one-shot model calls can run on the ChatGPT
  subscription (`--provider openai-codex`).** They treated it as "no
  credential" because it signs in with an OAuth grant, not an API key. OAuth
  access tokens of subscription providers are also loaded before `wiki enrich`,
  as `keryx shell` does.

## [0.3.12] — 2026-09-26

### Fixed
- **`keryx shell` no longer demands another tool call after a completed answer.**
  The continuation guard treated words such as «проверки», «проверял» and
  «сделано» as a promise to act, then emitted a misleading warning that the
  model could not call tools. It now matches explicit first-person action
  words instead. An unexecuted «Проверю…» still requests a tool call.

## [0.3.11] — 2026-09-26

### Added
- **The EXTERNAL switch — `/external on|off` and `keryx external
  on|off|status|list`.** One general control that stops keryx from sending
  private work (code, diffs, CI-log excerpts, prompts, rule text) to
  Jev/TypeSafe and to other model vendors/tiers the operator has not
  chosen to trust. A per-user default (`"on"`, unchanged pre-existing
  behavior) with an optional per-project override
  (`.metaproject/tasks.config.json`'s `external` key, which always wins).
  Enforced at the Jev client (`callJevSystemOne` — covers the edit guard,
  every `review-jev-*` command, `conform`, `ci-triage`, `jev-select`, the
  routing classifier and the turn guard) and at the routing/model-selection
  choke point (`resolveCategoryDetailed`'s connected predicate), before any
  network I/O. The block list is an editable JSON file
  (`<keryx config dir>/external-providers.json`), created with built-in
  defaults on first use: Jev/TypeSafe, `deepseek`/`zai`/`zai-coding`/
  `moonshot` (keryx's own direct provider ids) and the equivalent OpenRouter
  vendor-prefix patterns (also covering `minimax`, `qwen`/`alibaba`,
  `baidu`, `tencent`, `bytedance`, `01-ai`, which have no direct keryx
  provider), OpenRouter's free tier (`*:free`), and any model id containing
  `muse`. The mainstream paid US providers connected directly (Anthropic,
  OpenAI, Google, GitHub Copilot, xAI, Groq) stay off the default list.
- **Jev's recommended review profile is now on by default wherever Jev is
  reachable.** `review.jev.ci_triage`, `.select`, and `.edit_guard` default
  to `true` (through one shared resolver every reader goes through) as
  soon as `/external` is on and a Jev/OpenRouter credential resolves — no
  per-project opt-in required. An explicit `true`/`false` in
  `.metaproject/tasks.config.json` always wins. `keryx review jev-profile
  show` now names each key's effective source (`explicit`/
  `default-because-jev-available`/`off-by-external`). A one-time notice —
  "Jev is on here: redacted code/CI snippets go to OpenRouter/TypeSafe.
  Turn off: `/external off`" — is shown once per project, on CLI stderr,
  the first time a step runs because of the default rather than an
  explicit opt-in, and never repeats after that.
- TUI: a `/external` slash command (bare prints the effective state,
  source, Jev credential availability and block list; `on`/`off` toggles
  the per-user setting) and a sidebar indicator that appears when
  external is `off` (the default `on` state costs no permanent sidebar
  space).

## [0.3.10] — 2026-09-26

### Fixed
- **`keryx update` no longer deletes a project's own `.metaproject/` ignore.**
  It treated the blanket line as a leftover and removed it, so on a project
  that keeps its keryx workspace out of git the whole folder suddenly showed
  up as untracked and could be committed by accident. The line is now kept
  when nothing under `.metaproject/` is tracked, and dropped only where the
  project already commits `.metaproject/`.

## [0.3.9] — 2026-09-26

### Changed
- **`review jev-rules` and the Jev edit guard now find a Claude Code project's
  own rules.** Auto-discovery adds `.claude/rules/**` and the root `CLAUDE.md`
  (or `AGENTS.md` when there is no `CLAUDE.md`), with keryx's managed routing
  block stripped. They pass the same filter that drops process-only rules.
  Before this, a project that keeps its rules there got no rule checks unless
  every path was passed with `--rules`.

## [0.3.8] — 2026-09-26

### Fixed
- **The Jev edit guard now finds the OpenRouter key saved in keryx's config.**
  It looked for `auth.json` in the project folder instead of keryx's own data
  folder, so with no `OPENROUTER_API_KEY` in the environment it silently
  skipped every edit. The key it finds is also passed to its Jev calls. A
  regression test covers a saved key with an empty environment.

## [0.3.7] — 2026-09-26

### Added
- **Jev EDIT GUARD**: a Claude Code `PostToolUse` hook that checks every
  `Edit`/`Write`/`MultiEdit` a coding agent makes against the project's own
  written rules, using Jev, and feeds violations straight back to the agent
  before the code ever reaches a human reviewer. Opt-in
  (`review.jev.edit_guard: true` in `.metaproject/tasks.config.json`,
  threshold `review.jev.edit_guard_threshold`, default `0.5`; per-run budget
  `review.jev.edit_guard_max_calls`). Fails open on any error, timeout
  (~4s hard cap) or missing credential, and always exits `0`. New:
  `keryx review jev-edit-guard install|uninstall|status`, the TUI's
  `/editguard` (modal + sidebar indicator). Measured on a real project (10
  tasks × 2 runs, a large production React/MobX frontend): real rule
  violations reaching the first review round fell 27 → 10 (−63%) and review
  rounds 31 → 24, at the same total cost (Jev cost $0.04 for 40 runs); the
  agent acted on 79% of the flags at threshold 0.5.
- **`keryx review jev-select`** (flow 344): an advisory, opt-in (`review.jev.select`), fail-open
  pre-dispatch filter over the candidate reviewer set `review-orchestrator` is about to dispatch.
  Asks Jev one `noul` per reviewer against a compact diff summary and skips a candidate only when
  its probability is below `review.jev.select_skip_below` (default `0.15`) — never the Wave A core
  safety set (`review-logic`/`review-architecture`/`review-security-code`/`review-highload`), and
  never on its own opt-in being off, a missing credential, or any Jev error, all of which keep every
  candidate instead. `review-orchestrator` (Step 5c) records every decision, including the skips, in
  the report's scope section for later measurement.
- **`keryx review jev-profile [show] [--apply recommended]`**: the recommended-profile helper for
  every `review.jev.*` key, next to its measured verdict. `--apply recommended` merge-writes
  `ci_triage`/`select`/`edit_guard: true` and `risk`/`contract`/`rules`/`scenarios`/`docs`/
  `comments: false` into `.metaproject/tasks.config.json`, preserving every other key untouched.
- **`review-orchestrator`** now runs `keryx review ci-triage` (Step 0b) on a PR whose checks are red
  and `review.jev.ci_triage` is on, folding each failed run's verdict into the report, and documents
  the measured verdicts for every CLI-engine reviewer (`review-jev-risk`/`review-jev-contract`:
  measured weaker than a strong model, keep off by default; `review-jev-rules`: not useful on top of
  a strong reviewer; `review-jev-scenarios`/`review-jev-docs`/`review-jev-comments`: experimental).
  Also notes that the Jev edit guard (`keryx review jev-edit-guard`) is the recommended Jev step
  during the FIX phase — landed separately (below) in the delivery orchestrators.
- **`docs/docs/jev-in-review.md`**: what we measured putting Jev in the review domain, with the full
  numbers behind every verdict above, from a live benchmark on a large production React/MobX
  frontend.
- A `/jevprofile` TUI modal: every `review.jev.*` key next to its measured verdict, with enter/space
  to toggle one key and `a` to apply the recommended profile.
- **The two proven Jev wins are wired into the delivery orchestrators.**
  `job-orchestrator` and `flow-orchestrator` confirm the edit-guard hook is
  installed (`review.jev.edit_guard`) before the first `task-implementer`
  dispatch, and triage a red CI check (`review.jev.ci_triage`) before treating
  it as a fix task — rerun once on `flaky`, investigate `real-regression` as
  usual, report `infra` without touching code. `task-implementer` reacts to
  the edit guard's `Rule check flagged: ...` tool results, and `code-verifier`
  runs the same CI triage before filing a red check as a defect. Guidance only;
  both features are opt-in and pre-existing (`keryx review jev-edit-guard`,
  `keryx review ci-triage`). See [Jev in the delivery loop](docs/docs/guides/jev-in-the-delivery-loop.md).

## [0.3.6] — 2026-09-25

### Fixed
- **A single transient Jev/OpenRouter blip no longer kills a whole review run.**
  Every Jev caller (`review jev-rules`, `jev-risk`, `jev-scenarios`, `jev-docs`,
  `jev-comments`, `jev-contract`, `conform`, CI triage, the routing classifier)
  now retries a `429`/`500`/`502`/`503`/`504` response, or a network error like
  a refused connection, up to twice with a short pause before giving up — a
  `HTTP 503` that used to fail the run outright now recovers on its own if the
  vendor was only down for a moment.
- **`keryx auth login` keeps its Ctrl-C handler for a second press.** It was
  registered once, so a second Ctrl-C during the login took Node's default
  exit instead of the cancel path.

## [0.3.5] — 2026-09-25

Fixes from a live review of a real PR with every Jev reviewer. (0.3.4 was
not published: its tag landed on the wrong commit and the release job refused it.)

### Fixed
- **`review-jev-docs` no longer crashes on a large diff.** A batch that
  exceeded Jev's input limit used to fail the whole run with HTTP 400. Batches
  are now smaller. A batch that still overflows is split in half and retried
  once, and if that fails too it keeps its deterministic facts and reports
  the Jev error.
- **`review-jev-risk` stops scoring keryx's own bookkeeping.** Flow records,
  data and review packages under `.metaproject/` are reported as not code.
  A test file no longer produces a finding or a routing hint by itself; the
  hint goes to the production file.
- **`review-jev-rules` applies API rules only to API code.** A rule whose
  scope is HTTP/API endpoints is paired only with hunks that look like an
  API surface: paths under api/, routes/, controllers/, handlers/ or
  server/, or code that imports an HTTP framework. The rule about endpoint
  fields no longer fires on a CLI command registry.

## [0.3.3] — 2026-09-25

A sixth Jev reviewer, Jev inside the review orchestrator, Jev-routed requests
in the shell, routing by real task cost, model guidance for Claude Code and
Codex, and a precision fix for the rules reviewer.

### Added
- **`keryx review jev-contract`: does the PR do what it says?** The
  reviewer splits the PR description into claims ("adds", "fixes", "does not
  change", "tests …"). keryx first checks each claim's named files, symbols
  and flags against the diff, and checks "tests added" and "no API change"
  claims deterministically. Jev then scores each claim.
  - An unsupported claim is a `minor` finding. A claim the facts contradict
    is `major`.
  - `--flow <id>` also checks the flow's frozen acceptance criteria.
  - Retrospective sections of the description ("Live", "Follow-ups",
    "Notes", …) are not treated as promises.
  - Batches are small, and an oversized batch is split in half and retried
    once.
  - In the review orchestrator it replaces the by-eye description-versus-diff
    check. The model's check stays as the fallback.
  - Shell: `/contract`. Opt-in: `review.jev.contract`.
- **Routing classifier in `keryx shell`** (`/route on|off`, off by default).
  Each request is sorted into a routing category and runs on that
  category's model. The routing table decides the model, including the
  automatic table: with nothing configured, quick tasks go to the smallest
  model, subagents to one step down, and review and planning to the
  strongest.
  - Classification order: deterministic shortcuts first, then Jev
    (`choice`), then the main model.
  - Each stage has its own 3-second timeout, and the prompt never waits
    longer.
  - The turn shows the choice, e.g. `[quick → claude-haiku-4.5] (jev 92%)`.
  - An explicit `/model` switch turns routing off for the session.
  - The request text sent to Jev has secrets redacted.
  - Measured on 20 held-out requests: 19/20. On the 20 used to tune the
    confidence threshold: 20/20.
- **Model choice for Claude Code and Codex.** The managed block in
  `AGENTS.md` / `CLAUDE.md` now says which kind of model to use for which
  work:
  - the flagship tier for planning and review;
  - one tier down for subagents, docs and unattended work;
  - the smallest tier only for trivial work.

  It names concrete models only where the project's trusted
  `routing.config.json` resolves them. Personal settings never reach
  committed files. Opt out with `modelGuidance.enabled: false`.

- **`keryx review jev-triage` — Jev inside the review orchestrator.** The
  orchestrator runs it on the consolidated findings, before Wave C. It is
  annotate-only: it never drops, demotes or merges a finding. Three passes:
  - a severity check on every blocker and major: does the finding name a
    trigger and an observable outcome?
  - duplicate-merge candidates among findings that share a file or overlap.
    A pair at or above 0.5 flags the run for a closer look. It is a prompt to
    check, never a merge: on this repository, pairs from the same file that
    were not duplicates scored about 0.6.
  - a verifier queue, with the least plausible evidence first.

  Shell: `/triage`. Opt-in: `review.jev.triage`.
- **Routing by real task cost.** A lighter model can burn more tokens, so
  its per-token price is not what a task costs.
  - Every `keryx shell` turn records tokens, cost and success under its
    routing category.
  - `keryx routing stats` shows the per-task median, and `/routing` shows
    it next to each derived choice.
  - Once both candidates have at least 20 measured tasks in a category, the
    automatic table keeps the stronger model unless the lighter one is
    actually cheaper per task.
- **Claude Code subagents run on their tier.** keryx writes the Claude Code
  subagent files it generates with `model: opus`, `sonnet` or `haiku`, from
  the agent's tier (deep, standard, light), instead of `inherit`. Other
  hosts are unchanged. Opt out with `modelGuidance.claudeSubagentAliases:
  false`. Already exported files pick the alias up on the next
  `keryx agents export` or integrations sync.

### Changed
- **`review-jev-rules` no longer checks process steps against code.**
  - A deterministic pre-check marks steps like "Review the contract for
    breaking changes" as not checkable before Jev is asked. It looks only at
    the clause's own heading, requires a process verb, and rescues
    code-property clauses such as "files MUST …".
  - Tags it assigns are labelled `pre-classified`, not `explicit`.
  - Across this repository's rules it drops 11 of 703 clauses, all genuine
    process steps.
  - The tag cache schema was bumped, so old tags are re-resolved.

### Fixed
- The `/connect` button tests wait for the model-profile refresh instead of
  a fixed number of frames. They had failed intermittently on macOS since
  the profile refresh was added.
- `keryx review` help lists `jev-risk`, `jev-scenarios` and `jev-contract`.

## [0.3.2] — 2026-09-25

Four more review reviewers on Jev, and the flow records for the Jev work in
0.3.1 and this release. Every new reviewer is additional: it replaces none of
the existing ones. Each is opt-in and advisory, computes its facts first,
writes its own findings, and is dispatched by the review orchestrator as a
CLI-engine reviewer (`engine: jev`).

### Added
- **`keryx review jev-risk` — a risk map of the diff.**
  - What keryx computes first, per code hunk: the kind of path it touches,
    the exported symbols it touches, and whether a test in the same diff
    actually exercises the change.
  - Jev then scores each code hunk on five risks: security, data or
    migration, public API, concurrency, and error handling.
  - A high-risk hunk that no test exercises becomes an `info` or `minor`
    finding. Security and concurrency hits are routed to the security and
    highload reviewers as hints.
  - Docs hunks are never scored. A test counts as nearby only when it
    mentions a changed symbol or imports the module; a mention in a comment
    does not count.
  - Shell: `/risk`. Opt-in: `review.jev.risk`.
- **`keryx review jev-scenarios` — which user scenarios a PR probably
  changes.**
  - Scenarios come from the wiki, the PRDs and the how-to docs, each linked
    to the code it describes. Jev asks one question for each scenario whose
    code the diff touches.
  - The output is a list of what to check by hand. A scenario with no
    covering test becomes a `minor` finding.
  - A file that many scenarios link to (more than five) counts only when
    the scenario names a changed symbol.
  - Shell: `/scenarios`. Opt-in: `review.jev.scenarios`.
- **`keryx review jev-docs` — docs the diff made wrong.**
  - It looks at user-facing docs sections: `docs/`, the README and the
    wiki; `--include` widens the set. A section qualifies when it is linked
    to changed code by a path, symbol or CLI verb but is not itself edited
    by the diff.
  - Sections are ranked by how strong the link is, at most 8 per file,
    before Jev is asked.
  - A removed CLI flag that the docs still mention is flagged without Jev.
  - Shell: `/staledocs`. Opt-in: `review.jev.docs`.
- **`keryx review jev-comments` — PR review comments still open.**
  - Jev sorts each open comment in the PR comment ledger into one of four
    labels: resolved-by-fix, still-open, not-actionable or
    needs-escalation. It judges from later commits at the commented place
    and from the thread state, read-only.
  - `keryx review comments reply` shows the label and never acts on it.
    Nothing is written to GitHub.
  - Shell: `/opencomments`. Opt-in: `review.jev.comments`.
- **Flow records for flows 326–333.** Acceptance criteria, journals, review
  packages and PR comment ledgers.

## [0.3.1] — 2026-09-25

More of the Jev plan: Jev now helps in review, in `keryx flow`, and in the
shell after every turn. Routing works out a model for each kind of task from
the models your provider actually serves. A benchmark measures whether any of
this helps. Every Jev feature is opt-in and advisory. Each one computes the
facts itself first and asks Jev only yes/no questions.

### Added
- **`keryx review jev-rules` — an additional reviewer that checks every
  changed hunk against every applicable project rule.**
  - Rules come from `.metaproject/rules`, `rules/`, convention skills and
    `--rules`, and are split into clauses. The clauses are filtered before
    any code is checked:
    - only clauses tagged as code-checkable are kept (the tagging is
      cached per rule file);
    - process rules (commits, TDD, workflow, prompting and similar) are
      dropped;
    - unfilled template lines are dropped;
    - docs hunks are checked only against docs rules.
  - The call budget is spread round-robin over every hunk, code first, and
    the output reports how many hunks were reached.
  - keryx writes schema-valid findings, capped at `minor` unless a rule
    says otherwise.
  - It runs in the orchestrator's Wave B as a CLI-engine reviewer
    (`engine: jev`) and replaces no existing reviewer. In the shell it is
    `/jevrules`. Opt-in: `review.jev.rules`.
  - Measured on one real PR: 121 findings at $0.127 before the filters,
    2 findings at $0.0034 after, with every applicable hunk reached. Both
    remaining findings were wrong, so treat it as quiet and cheap, not yet
    precise.
- **`keryx flow check-ac <id> [--diff|--pr] [--refresh] [--json]` — Jev checks
  a change against the flow's frozen acceptance criteria.** Each criterion
  comes back likely-met, not-evident, or not-checkable.
  - Criteria about live checks, CI, health or publishing are
    not-checkable, decided without a model. For the rest, keryx first finds
    which named files, symbols and flags appear in the diff, then asks Jev.
  - An advisory note is printed at `flow implemented` and `flow complete`,
    capped at 20 s.
  - `review ingest` attaches the result only when it was computed for the
    diff under review.
  - In the shell: an AC tab in `/flows`, and `/ac`. The cache key is the
    criteria plus the diff, and a stale result is never shown as current.
    Opt-in: `review.jev.ac_check`.
- **A turn guard in `keryx shell`** (`/guard on|off`, `keryx shell --guard`).
  After an agent turn, keryx collects what the tools actually did and flags
  two things in one line: a reply that says it is done when it is not, and a
  reply that contradicts a failed test or command. `/guard` shows the
  details.
  - A real tool failure, or a failed build/test/install/typecheck command
    the reply never mentions, is flagged without Jev.
  - Ordinary nonzero exits (grep, test, diff) are passed to Jev as facts,
    not flagged.
  - It runs after the turn and never delays the next prompt. Off by
    default.
- **Model profiles and a derived default routing table.**
  - Every model gets a strength tier, price, context size and priority,
    each with its source: curated for Anthropic, OpenAI and Gemini;
    reported by any provider's `/models`; or guessed from the name. The
    profiles live in `model-profiles.json`, mode 0600.
  - With no routing configured, `/routing` derives a table anchored on the
    session model:
    - review and planning get the strongest model not weaker than the
      session model;
    - subagents, docs and unattended get one step down;
    - quick gets the smallest class;
    - default and coding keep the session model.
  - Ranking goes by family, then by version within the family, both dotted
    and hyphenated. Parameter sizes such as `7b` are never read as
    versions. Non-chat and `:free` models are never derived.
  - `keryx routing profile list|set`.
- **`bench/jev-review` — a benchmark of Jev with and without it.** The
  dataset is this repository's own review history, 1,638 findings with
  their dispositions. Each component runs through a common adapter.
  - Every rate is printed with n and a 95% interval, and a rate is marked
    anecdotal below n=10.
  - It runs offline by default; `--live` spends under a cost cap.
  - The results page says plainly where Jev did not beat a naive baseline.

### Changed
- **`keryx review conform` reports one verdict per clause**, with the
  worst hunks, instead of one row per hunk. On a real PR the text report
  went from 297 lines to 60.
  - `--max-hunk-calls` caps the Jev calls. A clause judged on only some of
    its hunks says "judged on K of N", and a clause that got no hunks reads
    "not evaluated" with the reason. `--detail` and `--json` keep the
    per-hunk rows.

### Fixed
- `keryx review ci-triage`: a rejected cached lookup no longer poisons later
  jobs, and the pagination gap is documented.

## [0.3.0] — 2026-09-25

The agent platform release. keryx now detects a project's stack and installs
stack packs and agents for it. It learns from how you work, carries that
knowledge between machines and coding agents, and runs its own lifecycle
hooks inside `keryx shell`.

### Added
- **Stack packs, promoted only through a strict eval with an LLM judge.**
  `keryx stack detect` reads a project's manifests offline, and `keryx skills
  install --profile` installs the matching pack. `skills doctor`,
  `uninstall`, `scout`, `eval` and `stocktake` keep the catalog honest. A
  pack becomes stable only after a behavioural eval graded by a rubric-based
  LLM judge with anti-gaming checks. The Python and Go packs are stable and
  ship with their agents. TypeScript/Node and React packs are included too.
- **Agent definitions and exporters.** An agent is defined once, compiled
  into a dispatch contract, and exported to each supported coding agent's
  own format with `keryx agents list/show/export/verify/generate`. The ten
  bundled agents carry keryx's own names.
- **A self-learning loop.** `keryx learn` records redacted, bounded session
  observations and extracts candidate patterns from them. Nothing is applied
  until you accept it on a terminal. An accepted pattern can feed a reviewer
  profile, be promoted to your user scope, or graduate into a skill, and
  `learn prune` retires stale ones.
- **Portability.** `keryx bundle export/import/inspect/verify/uninstall`
  moves skills, rules, agents, memory and hooks between a project, a team and
  your user scope in `~/.keryx`, rendered for the coding agent you name.
  Memory can be handed off from one agent to another, and rules export as
  the instruction files each agent reads.
- **One harness adapter registry and `keryx integrations`.** Every supported
  coding agent is described in one registry, now including Gemini CLI, Kiro,
  GitHub Copilot and Zed over ACP. `keryx integrations install`,
  `uninstall` and `doctor` manage keryx's hooks and instructions in each one,
  and `integrations matrix` generates the capability matrix from the
  registry.
- **Lifecycle hooks in `keryx shell`.** Built-in, user and project hooks run
  on session, prompt and tool events, and they can only tighten the policy
  engine. `keryx hooks list/validate/test/enable/disable` manage them.
  Project hooks run only after `keryx hooks trust` (see Changed).
- **Harness security audit and impact evidence.** `keryx security
  audit-harness` scores a project's instruction files, permission settings,
  MCP launchers, hook commands, agent definitions and skill scripts, with a
  CI mode and fix proposals you apply separately. On a session's first edit
  of a file, keryx injects impact evidence: the file's importers, related
  tests and memory caveats.

### Fixed
- **gdgraph and gdctx correctness.** Several `keryx ctx` defects are fixed,
  read-only git commands pass through an allowlist, a correctness benchmark
  guards the graph, and the routing index is slimmer.

### Changed
- **`/integrations` is now `/integrate`** in the shell, so it no longer sits
  one letter from the `keryx integrations` CLI verb.
- **Project hooks need trust.** Command hooks in `.metaproject/hooks.json`
  run only after `keryx hooks trust` shows every command and records that
  exact version. Any edit to the file voids the trust, and `keryx hooks
  untrust` withdraws it. Non-interactive surfaces never trust on their own.
- **A project file cannot disable a built-in gate.** The ctx guard, the input
  and output security checks and impact evidence can be turned off only from
  your own `~/.keryx/hooks.json`, with an explicit acknowledgement
  (`keryx hooks disable <id> --user --acknowledge-gate-risk`).
- **keryx refuses to start on an oversized or unreadable `.env*` file** when
  launched as `bun <file>` (`bun src/cli.ts`, `bun dist/cli.js`), because it
  cannot check which variables Bun would load from it. The installed
  launcher never reads `.env` files and is unaffected.

### Security
- **Bun no longer loads a project's `.env` or `bunfig.toml` into keryx.** The
  CLI now runs with `--no-env-file --config=/dev/null`, and so does every
  interpreter keryx starts itself: triggers, schedules, and installed
  cron/systemd/launchd units. Earlier versions loaded both files from the
  current directory, so a cloned repository could inject environment
  variables or a preload script, for example by pointing `KERYX_HOME` at a
  directory it controls. This affects every earlier version. The `bun
  <file>` guard now re-executes whenever those flags are missing and strips
  variables by name. If you relied on a project `.env` for provider keys,
  see "Environment isolation" in the onboarding guide. A schedule installed
  before this release is rewritten with the flags the next time it is
  confirmed or reinstalled.
- **Contained writes.** `keryx init`, `keryx update` (the testing service
  and `.gitignore`), the learning observer and impact evidence write only
  inside the project, and refuse a symlink that points outside it.
- **Terminal-safe hook display.** `keryx hooks` output and the trust prompt
  neutralise control characters, so a hook's command cannot rewrite the
  terminal to hide what it runs.

## [0.2.164] — 2026-09-25

Two more pieces of the Jev plan, and a routing picker that lists the models
your providers actually serve today.

### Added
- **`keryx review conform`: check a PR, a review or a diff against a
  reference document.** `keryx review conform --ref <doc> (--pr <n> |
  --report <dir> | --diff <ref>) [--explain] [--threshold] [--json]` splits a
  rules file, skill or project skill into clauses without a model (heading +
  item, stable ids), tags each as about the PR, a review report, code hunks,
  or not checkable, and computes the checkable facts first: which PR-body
  sections are present and filled, the hand-written line count, a report's
  section order, which fields each finding records. Jev then scores each
  clause (`satisfied` / `likely-violated`); `not-checkable` clauses are always
  listed, never guessed. `--explain` asks the model routed to the `review`
  category for a short advisory explanation of each violated clause and never
  writes to GitHub. `/conform` in the shell picks a recent document and a
  target and shows the clauses grouped by kind with their evidence.
  - Opt-in per project (`review.jev.conform` in
    `.metaproject/tasks.config.json`): the document's clauses, the PR text,
    the report and the diff are sent to Jev after secret redaction; nothing
    leaves the machine otherwise. Only the document's file name reaches the
    `--explain` model. The clause-tag cache and the recent-documents list live
    under `.metaproject/data/review-conform/`, which is gitignored, mode 0600.
  - Measured live against a real process document: Jev answers cautiously
    (none of 115 scores reached 0.8), so treat a `likely-violated` as a
    prompt for a human look, not a verdict.
- **`keryx providers status [--json] [--refresh]`** prints every connected
  provider's catalog: status (ok, auth failed, unreachable, timeout, not
  supported), model count, balance where the provider documents one, and when
  it was fetched.

### Changed
- **CI triage v2.** `keryx review ci-triage` now computes deterministic
  signals before asking Jev — whether a rerun of the job passed, whether the
  same test failed on other branches and later passed there, whether the
  failing test is near the diff, and log markers for a lost runner, network,
  out-of-memory, timeout and a broken dependency install — and puts them
  above the log. A rerun that passed, or the same job passing later on the
  same commit, decides the verdict by itself (`DETERMINISTIC:`), with Jev's
  probabilities still printed beside it; an ambiguous job name or a run that
  falls outside the fetched history withholds that and shows an advisory line
  instead. Every failed job is triaged (at most 10; `--job` narrows), and
  `--json` prints `{results, notTriaged}`. `--eval <manifest> [--live]` runs a
  committed set of 8 labelled real runs; measured live, top-1 accuracy was 4/8
  before and after the signals — the docs say so. `/ci` shows the same
  evidence.
- **`/routing` lists the models your connected providers serve now.** The
  picker read hardcoded model lists and offered providers you had not
  connected. At shell startup keryx now fetches every connected provider's
  model list in parallel ("checking providers…", 8 s per provider, never
  blocking the prompt), which doubles as an availability check; the result is
  cached for 5 minutes (mode 0600, no credentials) and `providers test`
  refreshes it. A provider whose fetch failed shows its curated list marked
  `(offline list)`; one whose key was rejected is left out. `/connect` rows
  show status, balance and age, and a provider that fails at startup gets one
  notice line.

### Fixed
- **The OpenRouter balance was never shown.** The request went to
  `/api/api/v1/credits` and the parser expected a shape neither endpoint
  returns. It now reads what is left of the key's limit from `/api/v1/key`, and
  falls back to `/api/v1/credits` for a key without a limit.
- **A rejected Jev key says where it came from.** A 401 names whether the
  `OPENROUTER_API_KEY` environment variable or the saved key was used, and
  flags a key that does not look like an OpenRouter key. Error bodies are
  redacted.
- **Jev `choice` questions** send their options as an object; the live
  endpoint rejected an array.
- `gh` and `git` calls made by CI triage and `review conform` have a timeout
  and an output cap.

## [0.2.163] — 2026-09-25

### Added
- **A prompting rule for Claude Opus 5.5, loaded only by Claude.** Opus 5.5
  reasons before every reply, so an instruction telling it to think is spent
  context that buys nothing and can over-constrain how it breaks the work up.
  `rules/core/opus-5-5-prompting.mdc` says to delete those instructions and
  state a completion criterion instead, to give a task its finish line rather
  than hand-written steps, to name the patterns to avoid instead of directing
  in the abstract, to keep stopping rules and destructive-command prompts in
  the entrypoint, to keep long-run state in a file because the early context is
  summarized away, to verify a subagent's evidence rather than its claim, to
  read blockers before the summary, and to attach finished artifacts instead of
  paraphrasing them.
  - **The rule is Claude-scoped by construction.** It is cited from `CLAUDE.md`
    only, in a section outside the managed `keryx:index` block, so
    `keryx rules sync` carries it into `.metaproject/rules/claude-md.md` at
    high priority and leaves `agents-md.md` untouched — an agent that reads
    only `AGENTS.md` never loads it. `agent_requires: ["claude"]` records the
    same restriction in frontmatter, alongside the existing `stack_requires`
    convention. It is deliberately absent from `.metaproject/index.md`, which
    every agent reads.
  - Its Output Contract puts output-format instructions, safety and permission
    rules, and anything written for non-Claude agents out of scope, so a
    cleanup pass driven by the rule cannot strip them.

## [0.2.162] — 2026-09-25

The first two pieces of the Jev plan: keryx can send each kind of task to a
model the operator chose, and it can tell a flaky CI failure from a real
one. Both designs are in `docs/requirements/keryx-jev-router/` and
`docs/requirements/keryx-jev-review/`.

### Added
- **A routing table: each kind of task goes to the model you chose.** The
  categories are default, review, subagents, quick, coding, planning, docs
  and unattended; each points at a specific model, a provider's default
  model, or the session's model. `/routing` edits it from one searchable
  list of every connected provider's models, with no provider step first,
  and `keryx routing list|set|unset|trust` does the same from the CLI.
  A project's `routing.config.json` overrides the user's table, and an
  explicit choice overrides both. Review and subagents read it now; the
  other categories can be set and are wired in later releases.
  - **A project's table takes effect only once you approve it.** A
    checked-in `routing.config.json` could otherwise decide which model
    reviews that project's own changes. `keryx routing trust`, or `t` then
    `y` in `/routing`, shows every entry before recording approval, and any
    edit to the file voids it. An unapproved table is ignored with a notice,
    even when part of it fails validation.
  - **An entry naming a provider or model you have not connected falls
    through** to the next layer and says so.
  - A subagent's routed model still passes every existing allowlist, trust
    and classification gate; a routed review model is labelled routed.
- **CI failure triage: flaky, infrastructure, or a real regression.**
  `keryx review ci-triage --run <id>` and `/ci` in the shell read a failed
  job's log and ask Jev, TypeSafe's structured-decision model, for the
  probability of each, through OpenRouter. It only advises - it cannot
  rerun, cancel or write a status. It is off until a project enables
  `review.jev.ci_triage`, because the log leaves the machine; the excerpt,
  the test name and the job name are redacted first, a request ends after
  30 seconds, and a malformed answer is an error rather than a silent zero.

### Notes
- Jev's accuracy figures are the vendor's own. Its answers to a multi-option
  question carry no documented per-option probabilities, so triage asks one
  yes/no question per outcome.

## [0.2.161] — 2026-09-23

A provider can be tested and disconnected from where it was connected.

### Added
- **`/connect` rows carry `[Test]` and `[Disconnect]` buttons**, built like
  the queue's Force/Edit/Delete and reachable from the keyboard the same way
  (up and down pick a row, left and right pick the action, Enter fires). Test
  asks the provider for its model list and shows `ok - N models` or the
  reason it failed on that row. Disconnect asks for confirmation, then removes
  exactly what keryx saved: an API key, an OAuth grant, or a custom provider
  with its base URL and model parameters. Selecting a provider works as
  before; `/provider` is unchanged.
- **`keryx providers test <name> [--json]` and `keryx providers remove <name>
  [--yes]`** do the same from the CLI. `remove` asks on a terminal, refuses
  without one unless `--yes`, and refuses a name it does not know.

### Notes
- **Disconnecting is local.** keryx deletes its own copy of the credential;
  nothing is revoked at the vendor, OAuth grants included.
- **A key the operator exported is left alone**, and Disconnect names the
  variable to unset.
- **Providers that share one key are named before they go.** The built-in
  `zai` and `zai-coding` both read `ZAI_API_KEY`; disconnecting either says
  that the other loses its credential too, before confirmation and after.
- **Disconnecting the session's own provider switches nothing and interrupts
  nothing**; the running session keeps the credential it loaded until
  `/connect` or a restart.

### Fixed
- **`auth.json` and `llm-providers.json` are written atomically**, so a
  crash mid-write can no longer leave either truncated.

## [0.2.160] — 2026-09-23

A patch to `keryx help`, found by the 0.2.159 smoke run.

### Fixed
- **`keryx help` in the terminal shows the shell's slash commands too.** It
  listed only CLI verbs, so a group made of slash commands alone — Look and
  feel, with `/theme` — never appeared, and `keryx help connect` left out
  `/connect`. Each group now lists its CLI verbs, then its commands under
  "in keryx shell:", and every group appears.
- **`keryx help /<command>` stays within 80 columns**; its explanation
  line ran to 94. A test holds every group and every command's help to 80.
- **The `/help` modal's tabs read as words.** Nine full group names did not
  fit the tab bar and were cut mid-phrase. The tabs now read Start, Connect,
  Look, Shell, Knowledge, Work, Automate, Agents, Maintain, fall back to
  short forms only when the modal is too narrow for them, and each tab
  opens with its group's full name.

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
