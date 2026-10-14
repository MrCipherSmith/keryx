# Review a pull request with nobody at the keyboard

An **autonomous review** is one review of one pull request that runs to the end without you.
You start it from a terminal, from `keryx shell`, or from a schedule. It opens a review
package, dispatches the reviewers, ingests their findings and closes the package. When it
stops, it leaves a verdict in an exit code, a `summary.json` for a program and a `report.md`
for a person.

It uses the `review-autonomous` profile: `keryx shell --print` in `trust` mode under
`--review-system review-auto`, reading the source only. It has no browser to open and nobody to
answer a question, so every place an interactive review would wait has a fixed rule below.

## Run one

```
keryx review run --autonomous --target pr --ref https://github.com/owner/repo/pull/123 \
    [--budget-minutes 60] [--budget-tokens 2000000] [--stall-minutes 10] \
    [--out <dir>] [--provider p] [--model m] [--no-notify] [--json]
```

`--ref` must be a pull request URL. No terminal is needed on any stream, so this is the form
to put in a script, a cron line or a CI job. `--target pr` is the only target.

| Exit code | Status | Meaning |
|---|---|---|
| 0 | `complete` | The package was closed by `keryx review complete`. |
| 2 | `incomplete` | The run ended, or was stopped, before the package was closed. |
| 3 | `floor` | The run was stopped at a floor: an action that always needs a human was refused. |
| 4 | `budget` | `--budget-minutes` or `--budget-tokens` was spent. |
| 5 | `stalled` | No new event for `--stall-minutes` (default 10). |
| 1 | refused | Bad arguments, or another run of the same pull request holds the lock. |

## What it does where a person would answer

- **A menu (`ask_user`).** A question marked irreversible is refused (the run sees it as
  cancelled). Any other question takes the recommended option, or the first one when none is
  recommended. A question with nothing to choose from is refused. Every automatic answer is
  written to `answers.ndjson` with its basis (`recommended`, `first`, `refused-irreversible`,
  `refused-no-option`), so you can read later what was decided for you. A question the review
  skill tagged as policy (scope, budget, partial coverage, a smaller slice) goes to the
  [review arbiter](review-arbiter.md) instead: it answers from numbered rules, and a `deny` or
  an `escalate` is a refusal, with its basis in `answers.ndjson`.
- **A floor.** The calls that always need a human (destructive, credentials, publishing)
  are refused, not granted. A refused call stays refused: the same call in any spelling is
  declined without a new question, and the run is told to choose another path. A run that can
  only go on through a floor stops with exit code 3.
- **Time and tokens.** `--budget-minutes` and `--budget-tokens` are checked while the run
  goes. When one is spent, the run is stopped at a safe point, the package is kept as it is,
  and the exit code is 4.
- **A hang.** The child process is watched through its events file. If nothing new appears for
  `--stall-minutes`, the run is stopped and the exit code is 5.
- **Silence on the terminal.** While the run goes, stderr gets one line
  `heartbeat: phase <phase>, <n> round(s), <n> tokens` whenever the phase, the rounds or the
  tokens change, at most once a minute. It is printed with `--json` too, and stdout stays pure
  JSON. The line follows the run's progress, so it is not a timer: a stretch with no change in
  phase, rounds or tokens prints nothing, and a wrapper with a short idle timeout still needs the
  run started detached.
- **The commit under review.** The pull request head is resolved once at the start (through
  `gh`) and given to the child, which passes it as `--head <sha>` to `keryx review start`,
  `attach` and `ingest`. Without it keryx would record the commit checked out in the directory,
  and the completion gate would compare the wrong one. When `gh` cannot resolve the head the
  prompt is unchanged and that risk remains.
- **A browser.** A check that needs one is skipped and the report says it was skipped.
- **Rounds.** At most five review rounds, and six reviewers per wave, and no new round when the
  last one found no new blocker or major finding.
- **You stop it.** SIGTERM and SIGINT stop the child and write a summary with status
  `incomplete`; the package stays open and resumes later.

## What it leaves

Everything is under `.metaproject/data/review-autonomous/<owner>-<repo>-pr<N>/` (or `--out`).

| File | What it is |
|---|---|
| `summary.json` | One object, schema version 1: status, exit code, reason, last phase, rounds, tokens, finding counts by severity, the package, floor refusals and automatic answers. |
| `report.md` | The same for a person: the verdict first, then the findings and what was decided for you. |
| `events.ndjson` | The child's event stream. |
| `answers.ndjson` | Every automatic answer, with its basis. |
| `arbiter.log` | One line per policy question the [review arbiter](review-arbiter.md) was asked: verdict, rule, model and cost. Copied into the review package when the run ends. |
| `progress.json` | The phase, rounds and tokens now. `/autoreview list` and the sidebar read this. |
| `lock.json` | The pid and start time of the run that holds the pull request. |
| `child.log` | The child's own output, for a failed run. |

## Resume and re-run

A run on a pull request whose head commit was already reviewed to the end does not start a new
review. It reuses the finished one, prints `reused`, and exits 0. A run on the same head whose
earlier run did not finish resumes the open package from where it stopped, and counts as the next
attempt. A run on a new head starts a fresh review and keeps the old summary beside it as
`summary.<head>.json`. A run that finds the first still alive refuses with exit code 1; a lock
whose process has died is taken over.

## From keryx shell

```
/autoreview start https://github.com/owner/repo/pull/123 [--budget-minutes N] [--budget-tokens N]
/autoreview list
/autoreview stop 123
/autoreview arbiter [123]
```

`arbiter` lists what the run's [arbiter](review-arbiter.md) was asked and what it answered.

`start` runs the command above in a detached process and returns at once. `stop` sends it
SIGTERM, so the run writes its partial summary; with one live run the argument can be left out.
While a run is going, the sidebar shows an autonomous-review section with one line per run: the
pull request, the phase, rounds, tokens, and the last automatic answer. A run that finished stays
for a day. A run whose process died is marked `died`. The section is hidden when there is none.
`/autoreview` is in `/help` and in the command menu.

## Telegram

When a bot is paired with `keryx serve`, a run sends one line when it starts and one when it
ends. The end line has the verdict, finding counts, tokens and time:

```
Autonomous review incomplete (exit 2): owner/repo PR #123, 0 blocker, 2 major, 5 minor, 412000 tokens, 1840 s. stopped by the operator; last phase: ingest; package rev-… kept at ingested
```

A run that stopped because the arbiter escalated sends one more line naming the question and
the reason; the log is in the package as `arbiter.log`.

The note is best effort. With no serve, no paired bot or a slow network, the run is neither
held up nor failed. `--no-notify` turns it off.

## Put it on a schedule

```
keryx schedule add --review-pr https://github.com/owner/repo/pull/123 \
    --name pr-123 --every "every 4 hours" \
    --provider anthropic --model claude-sonnet-5 --rates 3,15 --ceiling 5 \
    [--budget-minutes 60] [--budget-tokens 2000000] [--stall-minutes 10] [--max-seconds 3600] [--yes]
```

You get the usual confirmation card, and nothing is stored until you confirm it at a terminal.
`--prompt` is not needed. `--digest` and `--review-pr` cannot be combined, and the three budget
flags belong to a review only.

A scheduled review is a normal schedule with an OS timer, and it is covered by the same
confirmation as any other: the pull request, the profile and the budgets are part of what you
confirmed, so changing one needs a new `add`. Each fire runs `keryx trigger run --schedule
pr-123`, which starts `keryx review run --autonomous` for that pull request. Then:

- a fire on a head that was already reviewed to the end reuses the finished review;
- a fire that finds the previous run still going refuses, so two runs never share a pull
  request;
- the run's `report.md` is copied to `.metaproject/data/trigger/reports/pr-123/<runId>.md`, and
  `keryx schedule show pr-123` and `/schedules` list it with the verdict.

### cron and systemd timers

`keryx schedule add` installs the OS timer after you confirm the card. To read exactly what it
would install, or to carry it into a crontab or a unit directory you manage yourself, print it;
nothing is installed by this:

```
keryx trigger schedule pr-123
```

It prints the cron line and the systemd service and timer pair, with a real `OnCalendar=`
translated from your cadence and a unit name that is unique to the project. Every form changes
into the project root and runs the same thing: `keryx trigger run --schedule pr-123`.

| Backend | Where it lives | A missed run |
|---|---|---|
| systemd `--user` (Linux) | `~/.config/systemd/user/keryx-<projecthash>-pr-123.{service,timer}`, `Persistent=true` | made up once at the next boot or wake |
| launchd (macOS) | `~/Library/LaunchAgents/ai.keryx.<projecthash>.pr-123.plist` | made up once on wake |
| cron (elsewhere) | a block marked `# keryx-managed <projecthash> pr-123` in your crontab | not made up |

Choose one with `--backend systemd|launchd|cron`. For systemd:

```
systemctl --user list-timers 'keryx-*'
systemctl --user status keryx-<projecthash>-pr-123.service
journalctl --user -u keryx-<projecthash>-pr-123.service
```

Without linger a user timer does not run while you are logged out. keryx never enables linger
for you; run `loginctl enable-linger $USER` yourself if you want the review to run then. The
machine must be on at the time of a fire.

Manage the schedule with `keryx schedule pause pr-123`, `resume pr-123` and `remove pr-123`.
When the pull request is merged, remove it.

## Limits worth knowing

- It reviews the source only. A change that is visible only in a running app is not checked.
- A run that stops at a floor, a budget or a stall leaves a partial result. The report says
  which, and what remains. It never reports a verdict it did not reach.
- The profile cannot be loosened from the command line. To let a run do something a floor
  refuses, do it yourself and run the review again.

See [`review`](../cli-reference.md#review) and [`schedule`](../cli-reference.md#schedule) in the
CLI reference, [Permission modes](permission-modes.md) for `trust` and `review-auto`, and
[Review with a durable record](review-with-a-record.md) for the package the run creates.
