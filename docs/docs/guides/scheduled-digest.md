# Get a GitHub and board digest on a schedule

A **digest** is a scheduled task that reads GitHub and the flow board on a cadence you
choose and sends you a short message in Telegram: what changed, what is stuck, what needs
your decision, and which merged work was never checked for its effect. You do not start it.
`keryx serve` runs it.

It is a normal schedule from the [schedule](../cli-reference.md#schedule) command, with one
difference: it has no OS timer, so there is nothing to install and nothing to leave behind.
It needs `keryx serve` to be running, because serve owns the Telegram connection the digest
is delivered through. See [Drive keryx from a bot](drive-keryx-remotely.md) for setting serve
up.

## Create one

```
keryx schedule add --digest --name morning --every "daily at 08:00" \
    --provider anthropic --model claude-sonnet-5-5 --rates 3,15 --ceiling 0.2 \
    [--repo owner/name]... [--topic Digest] [--memory-mb 512] [--max-seconds 600] [--yes]
```

or `/schedule --digest …` in `keryx shell`. You get the same confirmation card as for any
schedule, and nothing is stored until you confirm it at a terminal. `--prompt` is not
needed.

| Setting | Flag | Default |
|---|---|---|
| Schedule | `--every` (a cron expression, `daily at HH:MM`, `weekdays at HH:MM`, `every N hours`, …) | none, required |
| Repositories | `--repo owner/name`, repeatable | `MrCipherSmith/keryx` |
| Topic | `--topic <name>` | `Digest` |
| Dollar limit | `--ceiling <usd>` | none, required |
| Time limit | `--max-seconds` | 600 |
| Memory limit | `--memory-mb` | 512 |

Only the repositories you list are ever read. A repository you did not list is refused
before `gh` runs.

## What a run does

1. For each repository it reads open issues, open pull requests, reviews waiting for you and
   failed CI runs, through the read-only `gh` tools.
2. It reads the **product index** of the flow board in `.metaproject/data/product/`. Its
   staleness is noted in the digest. A missing or unreadable index is reported, and the
   GitHub part of the digest is still sent.
3. It compares what it found with the snapshot of the previous run and builds the digest.
4. When there are changes, one short model turn (no tools, the data treated as untrusted)
   summarises them. If the model is unavailable, the digest is sent without a summary and a
   line says so.
5. It sends the digest and writes a report to `.metaproject/data/trigger/reports/<name>/`.

The digest names:

- **what changed** since the last digest: new, updated and gone issues and pull requests,
  and board entries that changed;
- **what is stuck**: open issues and pull requests with no update for seven days, and a CI
  failure that was already failing at the last digest;
- **what needs your decision**: reviews requested from you, and approved pull requests that
  wait for you to merge;
- **every "PR merged, flow closed, effect not checked" chain** in the product index. These are
  listed on every run until the effect is checked, even when nothing else changed.

Each list call reads at most 100 rows. A repository that answers with a full 100 rows may have
more, so the digest says "truncated at 100", keeps what it knew about the older entries from the
last digest, and reports none of them as closed or merged until a shorter answer shows the whole
list.

### The first run is a baseline

The first run has nothing to compare with, so it is marked `baseline`: it records the snapshot
and says so, and reports no changes. The next run reports only what moved after it. A run
with no changes gives a digest with no items ("nothing changed since the last digest").

The snapshot is a list of (id, updatedAt) pairs in `.metaproject/data/digest/<name>/`, which
keryx keeps out of git.

## Where it is delivered

Delivery goes through the Telegram connection of `keryx serve`; the digest never opens a second
bot client.

- When the project has a live remote session, the digest goes into **that session's topic**.
- Otherwise it goes into the service topic **Digest** (or the name you gave with `--topic`),
  which serve creates the first time it is needed.

A run that is refused (the `gh` binary or the confirmed schedule changed, a second run of the same
digest is already going, the scratch directory is not safe) also sends a short status line, so a
missed digest is never silent.

A delivery that fails is written in the report and retried with a growing delay, up to twelve
attempts. A failure to read GitHub, or a model failure, writes an entry in the report and a
status line in the topic, instead of failing silently. A message that serve has already
accepted is retried by serve's own durable queue.

## The read-only guarantee

A digest cannot change anything on GitHub.

- A digest is granted `gh.pr.list`, `gh.issue.list`, `gh.pr.review-requested` and
  `gh.run.failed`. Each has a fixed argv, runs without a shell, and is bound to one listed
  repository. None is `gh api`.
- Every `gh` tool in the catalogue has to be on a read-only allow-list (`pr list|view|checks`,
  `issue list|view`, `run list`), and its argv may contain no writing word (`create`, `edit`,
  `merge`, `close`, `comment`, `review`, `rerun`, `delete`, `api`, `auth`, `switch`, `--body`, …).
  The check runs when a schedule is drafted and in the test suite, so a tool that could write
  cannot be granted to a digest.
- The digest's model turn has no tools at all.
- **Accounts.** `gh` runs as the account the project path selects: `~/work/**` uses the work
  account, everything else the personal one, through the same `gh` wrapper you use yourself.
  A digest never runs `gh auth switch` or `gh auth login`.

## Limits

A run that goes over a limit is stopped and reported, in the report and in the topic.

- **Dollars.** `--ceiling` is reserved before the model turn, under the project-wide spend
  lock, and the turn is stopped when the reservation is reached. A provider that sends no token
  usage is charged the whole reservation and its summary is dropped. The `gh` calls cost
  nothing, so a digest with no changes, or with no model, costs nothing.
- **Time.** `--max-seconds` is the wall-clock timeout for the whole run, including `gh`.
  Each `gh` call also has a 30-second timeout and a 64 KB output cap.
- **Memory.** `--memory-mb` is how much the resident memory of the process running the digest
  (serve) may **grow** during the run. keryx reads the size when the run starts, so a serve that
  is already large does not trip every digest. It checks the growth after each step and every
  second while a call is in flight.

## See it, pause it, run it now

```
keryx schedule list            # the digest, its next run, the last run's status, the last delivery
keryx schedule show morning
keryx schedule pause morning   # serve stops running it; a message already queued is still delivered
keryx schedule resume morning  # runs from the next cron time; a pause does not catch up
keryx schedule run morning     # one pass now
```

In `keryx shell`, `/schedules` lists the digest and opens its detail, where `p` pauses or
resumes it and `r` runs it now. The sidebar's Schedules section shows its next run and the last
outcome.

## When serve was not running

At the cron time a digest needs `keryx serve`. If serve was down, it starts **one** run for the
newest missed time when it comes back, never one per missed time. A time is claimed before the
run starts, so a restart in the middle of a run does not run it a second time; the run record
shows what happened.
