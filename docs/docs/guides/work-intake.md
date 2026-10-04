# Take work in from GitHub as cards in Telegram

**Work intake** watches the GitHub repositories you list and turns each new event that needs
you into a **card** in a Telegram topic called **Intake**: a title, a link, a short assessment
and the buttons that make sense for that kind of event. You decide with one tap. You do not
start it. `keryx serve` polls, and it sends the cards through its own Telegram connection.

It is **read-only toward GitHub**. Taking a ticket opens a keryx flow on your machine; nothing is
commented, assigned, labelled or merged on GitHub. See [the read-only guarantee](#the-read-only-guarantee).

It needs `keryx serve` to be running with Telegram connected. See
[Drive keryx from a bot](drive-keryx-remotely.md) for setting that up. For a periodic summary
instead of one card per event, see the
[scheduled digest](scheduled-digest.md).

## What is watched

For each repository you list, one poll reads:

| Event | What counts | Card title |
|---|---|---|
| Issue | A ticket assigned to you | New task (Новая задача) |
| Review | A pull request that asks you for a review | Review requested (Просят ревью) |
| CI | A failed run on a branch of one of **your own** open pull requests | CI failed (Упал CI) |
| Comment | A comment somebody else wrote on one of your own pull requests | New comment (Новый комментарий) |
| Board | A change in the flow board index of the project (`.metaproject/data/product/`) | Board change (Изменение на доске) |

A failed CI run on somebody else's branch is not an event. A comment you wrote yourself is not
an event.

## Turn it on

Intake is **off until you opt in**, everywhere. A project takes part only when its intake config
file exists, says `"enabled": true` and lists at least one repository. Without that file nothing
polls: not `keryx serve`, and not `keryx intake poll` either, which refuses with a one-line "how to
enable" instead of reading GitHub. The sidebar line and the `/intake` menu entry are hidden in
such a project, and `keryx intake status` says how to turn it on. A machine with many projects
does not start polling GitHub for all of them.

Create `.metaproject/data/intake/config.json` in the project (keryx keeps the folder out of git):

```json
{
  "enabled": true,
  "repos": ["owner/repo"]
}
```

Every other field is optional and falls back to its default. A field of the wrong type or out of
range also falls back, so a hand-edited file cannot stop the poll. The one exception is
`repos`: it has no default, because intake must never read a repository you did not name.

The cards always go to the one topic named **Intake**. That is not a setting: it is the topic the
bot accepts button presses from. A `topic` key in an old config file is ignored, and
`keryx intake status` warns about it.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | `true` turns intake on for the project; `false` takes it out of the serve tick and refuses a manual poll |
| `repos` | `[]` | `owner/name` of each repository to read; only these are ever read, and an empty list means nothing is read |
| `intervalMinutes` | 10 | Time between automatic polls (1 to 1440) |
| `quietHours` | `{ "startHour": 22, "endHour": 8 }` | Local-time window with no sends; wraps midnight; equal hours turn it off |
| `cardsPerHour` | 6 | Most cards sent in one hour |
| `buttonTtlHours` | 24 | How long a card's buttons work |
| `laterHours` | 4 | Delay of the reminder after Later |
| `budgetUsd` | 0.5 | Dollar limit for the assessments of one poll |
| `maxSeconds` | 300 | Wall-clock limit for one poll |
| `memoryLimitMb` | 512 | How much the process may grow during one poll |
| `rows` | 100 | Rows read per `gh` list call |
| `allowTakeInWork` | `false` | Offer Take on a work repository (see below) |

Serve checks every 30 seconds which projects are due. The model that writes the assessments is the
project's configured provider.

## The cards and their buttons

Every card shows the kind, the repository and number, the title, a link, an **assessment**
("Оценка") of at most 400 characters, and sometimes a **suggestion** ("Совет") naming one of
the card's own buttons. When the model is unavailable or over budget, the assessment says
"недоступна" (unavailable) and the card is still sent.

| Card | Button (as in Telegram) | What it does |
|---|---|---|
| New task | **Взять в работу** (Take) | Creates a flow from the ticket link with `keryx flow init --issue`, and writes an `intake:` line in the flow journal naming where it was taken (`telegram`, `tui` or `cli`, never a user id), the card id and the source. The flow stays in `initializing`: nothing freezes its acceptance criteria. |
| New task | **Отклонить** (Decline) | Records the decision. Nothing happens on GitHub. |
| New task | **Позже** (Later) | Reminds you once, after `laterHours` (4 h by default). A reminder that would fall in quiet hours moves to the end of them. |
| Review requested | **Открыть ревью-flow** (Open a review flow) | Creates a review flow titled "Review owner/repo#N" with the pull request link in its description. |
| Review requested | **Пропустить** (Skip) | Records the decision. |
| CI failed | **Разобрать** (Triage) | Runs a read-only triage of the failed run (120 s limit, 64 KB of log) and posts the redacted result, up to 3000 characters, in the topic. |
| CI failed | **Игнорировать** (Ignore) | Records the decision. |
| New comment, Board change | **Понятно** (Understood) | Acknowledges the card. |

When you press a button the card is edited in place: its buttons are replaced by a status line
such as the time and the flow id, and a short toast confirms. A decision made in the TUI edits the
card in Telegram too, and a press on a card that is already settled (decided, expired) rewrites
its status line, so a card never keeps live buttons that do nothing. If an action takes longer
than a couple of seconds (creating a flow, a CI triage) the button is answered at once with
"Принято, выполняю…" and the result follows as a card edit or a message in the topic; an action
that hangs is cut off after three minutes.

- **Two presses run the action once.** The move out of the open state is one atomic step, so a
  double tap, or a press in Telegram and in the TUI at the same moment, makes one flow.
- **A failed action can be pressed again.** If the flow could not be created (for example no
  project of yours has a clone of that repository), the card goes to a failed state with the
  reason, and its buttons stay.
- **A restart does not repeat a press.** When serve starts, a card left in the middle of an
  action adopts the flow that was already made for it, or is marked failed for you to check.
- **Buttons live 24 hours.** After `buttonTtlHours` a press is refused with "истекло"
  (expired), and the card expires. A card that was delayed in the queue gets its full lifetime
  from the moment it is actually sent.
- **A press from anywhere else is ignored.** The press must come from the Intake topic and from
  an allowed user, and the message must be the card's own. A mismatch is dropped and logged with
  ids and time only, never text.

## What a poll does

1. **The first poll is a baseline.** For each source of each repository it records what exists
   and sends **no cards**. You are not buried under every open ticket you ever had. Only what
   appears after it becomes a card.
2. **Events are deduplicated.** Each event has a stable id and a stamp; the same event never
   makes a second card. The board is the exception: it is reported again when its stamp
   changes.
3. **New events are assessed.** One model turn per event, with no tools, the ticket text treated
   as untrusted data, redacted and cut before it is sent. The turn is stopped when the poll has
   spent `budgetUsd`; the budget ends the model calls, not the poll: every remaining event is still
   turned into a card, without an assessment, and the report notes how many.
4. **Cards are queued and sent.** Queued cards go out with the next serve tick, subject to
   quiet hours and the hourly cap.

### Quiet hours and the hourly cap

- **Quiet hours** (22:00 to 08:00 by default, in the local time of the machine where serve
  runs). Polling continues, but no card is sent; queued cards wait and go out afterwards.
- **At most 6 cards an hour** (`cardsPerHour`). When more are waiting, the rest are collapsed into a
  single **overflow card** ("Ещё N событий", N more events; its count is edited when more events
  collapse into it, and no second overflow card is sent while the first one is waiting), which has no buttons and points to
  `keryx intake status` and the TUI. Collapsed events stay open: they are in the **Ждут**
  tab of the TUI modal and can be decided there.

### Delivery and reporting

A card that Telegram cannot take is retried with a growing delay, up to twelve attempts, then
marked undelivered. Each poll writes a report to `.metaproject/data/intake/reports/<runId>.md`
(the last 50 are kept). A failure to read GitHub, or a model failure, is written in the report and
said once in the topic as a status line (not repeated within an hour), instead of failing
silently. A missing product index is reported in the report, not in the topic.

## Work repositories are read-only

The GitHub account is chosen by the project path, the same rule as the `gh` wrapper:
`~/work/**` uses the work account, everything else the personal one.

When the project's account is the work account, the **Take button is not shown** on issue
cards, and a press that arrives anyway is refused. The check is made again at press time, against
the project the repository really maps to, so it also holds for a card sent before the setting
changed. The same goes for **Открыть ревью-flow** ("Взять в работу" отключено для рабочих
репозиториев). You still see the cards, and Decline and Later still work. To allow Take there,
set `allowTakeInWork` to `true` in the config.

`keryx intake status` shows the account the path selects.

## The read-only guarantee

Intake cannot change anything on GitHub.

- A poll is granted four read-only `gh` tools: `gh.issue.assigned`, `gh.pr.review-requested`,
  `gh.pr.comments` and `gh.run.failed`. Each has a fixed argv, runs without a shell and is bound
  to one listed repository. None is `gh api`.
- Every `gh` tool in the catalogue must be on a read-only allow-list, and its argv may contain
  no writing word (`create`, `edit`, `merge`, `close`, `comment`, `review`, `rerun`, `delete`,
  `api`, `auth`, `switch`, `--body`). The check runs in the test suite.
- The assessment turn has no tools, and its answer is used in two narrow ways: plain text with
  every link removed, and a suggestion that is kept only if it is one of the card's own
  buttons. The model cannot add a button or a link.
- Ticket text never becomes markup in a card: free fields are stripped of formatting
  characters, a link is added only when it is a plain `https` URL, and the button data carries
  only the card id and an action code. What a press does is read from the card registry, not
  from the press.
- **Accounts.** Intake never runs `gh auth switch` or `gh auth login`. It asks for the account
  with `GH_ACCOUNT`, which only the machine's `gh` wrapper honours; the real `gh` binary ignores
  it and uses the active login. A token variable in serve's environment is not passed on to `gh` or to the keryx
  processes intake starts (`GH_TOKEN`, `GITHUB_TOKEN` and any other secret are removed from their
  environment).
- **Where text is kept.** Card texts live only in the card registry,
  `.metaproject/data/intake/cards.json`. The decision ledger holds ids and choices, not texts.

## See it, pause it, poll now

```
keryx intake status           # on or paused, how many wait, the repositories, the account, the last poll
keryx intake list             # the cards, newest first
keryx intake pause            # stop the automatic poll
keryx intake resume
keryx intake poll             # one poll now, even while paused
keryx intake report           # what the cards were worth
```

`status`, `list`, `poll` and `report` accept `--json`. See the
[CLI reference](../cli-reference.md#intake) for each subcommand.

**To pause**, run `keryx intake pause`, or press `p` in the `/intake` modal. Pausing stops only
the automatic poll: cards already queued still go out, and buttons already in Telegram still
work. `keryx intake resume` starts the poll again. To take a project out of serve completely, set
`"enabled": false` in its config or delete the file.

### The report

`keryx intake report` reads the ledger only. It gives the number of cards per kind, the decisions
made, the median time to answer, how often your choice matched the suggestion, and for taken cards
the chain **card, flow, pull request** (the pull request link comes from the flow's record).

## In `keryx shell`

- The **sidebar** has an Intake line, shown only in a project that has an intake config: `Intake: выкл` (off), `Intake: N ждут | пауза` (N waiting,
  paused) or `Intake: N ждут | следующий опрос HH:MM` (next poll at). Clicking it opens the modal.
- **`/intake`** opens the modal with four tabs: **Ждут** (waiting), **Решённые** (decided),
  **Отложенные** (deferred) and **События** (events). Keys: up and down choose a card, left and
  right switch tabs, `t` takes, `d` declines, `l` defers, `p` pauses or resumes, `esc` closes. The
  modal refreshes every 5 seconds. A decision made here goes through the same door as a button
  in Telegram and is recorded as made by `tui`.
- **`/intake status|list|pause|resume|poll`** prints the same as the CLI subcommands, as text.

## Where the data lives

Under `.metaproject/data/intake/`, kept out of git:

| File | Holds |
|---|---|
| `config.json` | The settings above |
| `cards.json` | The cards and their texts |
| `ledger.jsonl` | Each card's decisions, without texts |
| `state.json` | What the poll has already seen (the baseline and the dedupe) |
| `reports/<runId>.md` | One report per poll, the last 50 |
| `rejected-presses.jsonl` | Presses that did not match their card: ids and time only |
