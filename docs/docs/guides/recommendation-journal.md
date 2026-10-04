# Keep a record of what an agent recommended and what you chose

When an agent asks you a question with options, it usually also has a favourite.
The recommendation journal records that favourite next to your answer, so you can
see over time how often you follow it, at which stage of a flow, and why you
sometimes do not. The report is plain counting: no model is involved.

## What is recorded

Every question with options writes one record:

- the flow and the stage it was asked in (or no flow);
- the question and the options, with the order they were shown in;
- the recommendation and its reason, **written before the question is shown**;
- the arm the question was asked in (`A`, `B`, `C` or `D`), the seed it was drawn from, whether the recommended option was preselected, where it was asked (`channel`, `tui` when absent) and the display mode (`ordinary`, `partial` or `blind`, derived from the arm);
- your choice and the time it took you to answer;
- a reason for deviating, when you give one.

The journal is `.metaproject/data/decisions/journal.jsonl` (append-only, mode
0600, git-ignored in this repository). There is one journal per repository, under
the main checkout: every git worktree reads and writes the same file. Inside a
flow, the answer also adds one line to that flow's `journal.md`; outside a flow
only the project-wide journal is written. The flow is `KERYX_FLOW` when it is set,
else the flow named by the git branch (`flow-392`, or the flow's slug), else the
only flow in progress. The last one is a guess: it is recorded as `inferred`
(`flowSource` on the record is `env`, `branch` or `inferred`), the report marks
those flows `(inferred)` and counts them, and nothing is written into that flow's
own `journal.md`, because attribution that is a guess must not write into a flow. The stage is the kind of the task in progress, or the
flow's status.

## Blind questions

A question with a recommendation is asked in one of four **arms**, drawn from a
seeded generator on the repository's salt (kept outside the repository, in
`~/.config/keryx/decisions`, mode 0600) and the position in the journal, so an
assignment can be replayed:

| Arm | Order | "Recommended" mark | Recommended option preselected | Default weight |
| --- | --- | --- | --- | --- |
| A | the agent's | shown | yes | 0.4 |
| B | the agent's | shown | no | 0.2 |
| C | shuffled | shown | no | 0.2 |
| D (blind) | shuffled | hidden | no | 0.2 |

Change the weights under `arms` in `.metaproject/decisions.config.json`, for example
`{ "arms": { "A": 0.4, "B": 0.2, "C": 0.2, "D": 0.2 } }`. A weight is any
non-negative number (they are normalised), and the draw stays a pure function of the
salt and the position, so an assignment can still be replayed. A weights block that
cannot be used (a negative or non-numeric weight, all zeros, not an object) is
ignored: the defaults are used and the report says so in a `Config:` line. In arm D the recommended
option carries no "recommended" mark and the options come in random order. Your
answer is recorded, and then the recommendation is revealed. After a deviation in any
arm the transcript names the recommended option and its reason; in arm D it does so
after any answer. The agent gives the reason as the top-level `recommendationReason`
of `ask_user`, and may mark at most one option recommended. This is what lets the match share mean
something: if you only ever saw the recommendation marked, you would match it
because it was marked. A question that carries no recommendation is always asked the ordinary way and is left out of every arm and channel cell of the report (it is still counted in the total and under "without a recommendation"), so it cannot skew the A count or its median time.

### What the arm assignment protects against

The salt is outside the repository (`$XDG_CONFIG_HOME/keryx/decisions`, or
`~/.config/keryx/decisions`; one file per repository, shared by all its worktrees), so
the agent cannot read it from the tree it works in, and asking the same unanswered
question again returns the arm already drawn instead of drawing a new one. The
`ask_user` description tells the agent what `irreversible` and `action` mean and
nothing about how a question is shown. That protects against accident and casual
steering. It does not protect against a hostile agent running as your own user: such
an agent can read your config directory and the journal.

A question about something on the **irreversible list** is never blind: it is always
arm A, and the record says `forced: true` (every other A says `forced: false`). The list has
two tiers, so that ordinary coding questions ("merge these two helpers", "drop an
unused import", "remove dead code", "force a type") are not mistaken for a release:

- **Strong terms always count**: `release`, `ship`, `publish`, `unpublish`,
  `deploy`, `rollout` / `roll out`, `promote`, `go live`, `delete`, `push`,
  `destroy`, `wipe`, `purge`, with the Russian roots `релиз`, `выпуск` / `выпуст`,
  `залить` / `залей`, `накат`, `удал`, `пуш`, `опублик`, `деплой`, `выкат` (a
  Russian root matches inside a word, so `запушить` counts). Strong patterns
  count too: `git reset --hard`, `clean -f`, `checkout --`, `rm -rf`,
  `branch -D`, `--force`, tagging a version (`tag v1.4.0`, `тег версии`),
  cutting or bumping a version (`cut 0.3.62`, `bump the version`, `tag it`,
  `поднять версию`, `затегать`, `зарелизить`), publishing to a registry (`to npm`,
  `в npm`) and going to production (`в прод`,
  `на продакшн`). Add your own words in
  `.metaproject/decisions.config.json`; they are strong too, and the file extends
  the built-in list and cannot shorten it:

  ```json
  { "irreversible": ["migrate"] }
  ```

- **Weak terms count only next to a risk target**: `merge`, `drop`, `remove`,
  `force`, `reset`, `overwrite`, `truncate`, `send` (and `слить`, `мерж`, `сброс`,
  `отправ`, ...) make a question irreversible only when the same question, or the
  same option, also names `main`, `master`, `prod`/`production`, `remote`,
  `origin`, a `database`, `table`, `branch`, `tag`, `repository`, a pull request,
  a commit or a release, or when the `--action` tag itself is one of them. A weak
  term whose object is only a pronoun, or nothing ("Merge it now?", "Drop it?",
  "Слить это?"), counts as irreversible too: when the question is ambiguous it
  fails towards the ordinary way of asking, because a false positive only costs
  one measurement and a false negative could cost a release.

An identifier in a question about code is not read as an action: "Rename
`deleteUser` to `removeUser`?" and "Extract `publishEvent` into a function?" can
be blind, while "Delete the user?" and "Run `deployToProd` now?" cannot.

**Agents should pass `--action` for anything irreversible** (`--action release`,
`--action merge`, `--action drop-table`, `--action force-push`); any non-empty tag
makes the question non-blind. Through the `ask_user` tool the same is the optional
`action` string and the optional `irreversible: true` flag, and the tool
description tells the agent it **must** set one of them for a release, publish,
deploy, delete, push, merge into a shared branch, drop, force, reset or version
tag. That is the reliable path: the text match is only a safety net, and it looks
at the question, the options and the tag, case-insensitively. A weak term with no
risk target and a real object, such as "Merge the two date
helpers?", is asked normally and can be blind. A question with no recommendation
is never blind. In a blind question a mark written into a label, such as
`(Recommended)`, `[recommended]`, `- recommended`, `Recommended:` or a star, is
removed from what is shown, and in arm D so is every other use of the words
recommend, рекоменд, preferred and suggested in a label, a description or the reason.

## Changing your mind, and giving a reason

After you answer, the transcript shows the reveal and tells you what you can still
do. The one thing the journal waits for is the reason: when you
chose something other than the recommendation, and on a deterministic third of the
other questions (next section), keryx asks you **once** why, and the
tool result waits for your answer (there is no timeout). The reason is optional: an
empty answer, "No reason" or "Not now" is recorded as absent and releases the wait,
and you are not asked again for that decision. Nothing else waits.

- `/decisions change <option id or label>` changes the answer of the latest
  question **asked in this session**. The journal records the session on every
  question, and with no id the command only ever touches a decision of this
  session. If the only candidate is another session's (found through the current
  flow), it changes nothing and names the decision it would have changed, with
  the `keryx decisions answer <id> --choice <option>` command to do it on purpose.
  It prints which decision it changed. Both answers are kept and
  the record says it was changed. The agent already received your first answer,
  so the change is recorded in the journal but may not reach the agent.
- `/decisions reason <why>` adds a reason, or changes the one you gave, when your
  answer differed from the recommendation, to the same decision. The latest reason
  wins in the report. Leaving the reason out costs nothing (the report shows
  `(none given)`).

The same two steps from a shell are `keryx decisions answer <id> --choice <id>`
again and `keryx decisions reason <id> --text "<why>"`. An answer must be one of
the options (a free-form `ask_user` answer is recorded as such). Journal lines
that cannot be read are skipped and the report says how many. Free text you type
is collapsed to one line when it is written and again when it is shown, so it
cannot add lines to a flow's `journal.md` or to the report. The short display form
of a choice stays at 300 characters; your own answer and your reason are kept
longer, as the next section says.

## Your own answer and a typed reason

A question with options always has a way out of the options. In the keryx shell
the dock's **last row is `Свой ответ…`** (own answer): Enter opens a text input,
Enter sends it, Esc goes back to the list. An empty or whitespace-only text is
refused and the input stays open. The text goes to the agent as **your own answer**,
not as one of the options, and the transcript shows it after the question.

To say why you picked an option, highlight it and press **Tab** instead of Enter
(the dock's hint line says `Tab = pick + reason`). The same input opens with the
option fixed, and what you type is stored as the reason for that choice. The
deviation question ("why did you not take the recommendation?") also takes typed
text. In Telegram the question has a **`✍ Свой ответ`** button: press it, then
reply to the message it posts (see
[Drive keryx remotely](drive-keryx-remotely.md)). Approvals (Allow, Deny, modes,
grants) have none of this: typed text never approves anything.

What is stored:

- the own text and the reason are kept up to **2000 characters**; a longer one ends
  with a visible `[truncated: N more characters]` marker;
- both are redacted when they are written, so a token-shaped string never reaches
  the journal, a flow's `journal.md` or the report;
- a reason is appended to the flow's `journal.md` as one line with the question id;
- `keryx decisions report` (text and `--json`, under `annotated`) lists every
  own answer and every reason **in full** in a section "Own answers and reasons";
- the `/decisions` modal shows the same lines, and the sidebar row marks how many
  decisions carry an own answer or a reason with `✍N`.

An own answer is never counted as following the recommendation, even when its
words happen to equal an option's id.

## A reason on one question in three

Asking only after a deviation would show who explains a disagreement and never who
explains an agreement. So a **deterministic one-third of the eligible questions**
also asks for a reason when you *did* follow the recommendation. The subsample is a
hash of the repository's seed and the position of the question, independent of the
arm: it is chosen and written on the record (`reasonRequested`) **before the
question is shown**, so the agent and you cannot tell which questions it will be:
`keryx decisions open` does not print it either, and `keryx decisions answer` says it
only once the choice is recorded. The prompt comes after the answer, whether or not
the choice matched.

- It is the **same prompt** as the one after a deviation: the dock's free-text row
  from the section above (in Telegram, the same reply-to-the-message step), not a
  second kind of prompt. Only the wording differs ("Why this choice?" instead of
  "You chose differently from the recommendation. Why?"). A reason you already typed
  with the pick (Tab) counts, and nothing more is asked.
- It is asked once and is optional, like every reason.
- A question is **eligible** (`eligible: true` on the record) unless it is
  irreversible, an action or a match of the irreversible list (`forced: true`);
  ineligible questions are never in the subsample. A surface that cannot take free
  text (a plain picker) is left out of it too, and its record says so
  (`reasonPrompt: false`): it never prompts, not even after a deviation.
- `KERYX_DECISIONS_REASON_SUBSAMPLE=off` turns the subsample off (the tests use it);
  a deviation is still asked. The report's settings block says so
  (`Reason subsample: off (KERYX_DECISIONS_REASON_SUBSAMPLE)`).

## The report

```text
keryx decisions report [--json | --line] [--exclude-legacy]
```

It prints, from the journal alone (plus the quality ratings, below):

- the match share overall and by mode (`ordinary`, `blind`, and `partial` for arms B and C when there are any);
- the match share by **arm**: A, B, C and D. Arm A is shown as two rows, **A free**
  (drawn) and **A forced** (the question looked irreversible, so it was always A).
  A forced A was not randomized, so it is never pooled with the drawn arms;
- the match share by **channel** (`tui`, `telegram`, ...), each channel cut by arm.
  On `telegram` arms A and B are **one row, "A+B"**, because a poll cannot preselect
  an option (see "What the journal does NOT measure");
- the records from before the arms in a block of their own, **legacy** (see
  "Importing earlier decisions"). By default they stay in the old overall and by-mode
  totals, as before, and never appear in the arm and channel tables.
  `--exclude-legacy` leaves them, and the imported historical records, out of every
  number and block;
- the share of **named reasons**, separately for agreement and for deviation. Only
  decisions that could be asked count: a deviation asks wherever the surface can
  prompt, so every one of those counts; an agreement only asks inside the reason
  subsample, so only those count (the others were never asked). A deviation on a
  surface that never prompts (a picker menu) was never asked either: it is counted
  apart as "not asked" and stays out of the share. Next to it, the median time to
  answer for the decisions where a reason was requested and for the rest, on the
  `tui` channel and over the same population: eligible questions on a surface that
  can prompt (forced irreversible questions and picker menus are in neither);
- the **ineligible** questions (irreversible, an action or a match of the irreversible
  list) on a line of their own, outside the arm comparison;
- **progress** toward flow 392 AC11 (20 answered decisions, 5 of them blind) and toward
  the per-arm threshold: reversible, answered questions with a recommendation per arm,
  against `perArmThreshold` in `.metaproject/decisions.config.json` (150 by default,
  a positive whole number);
- the arm weights and the per-arm threshold in use, each saying whether it comes from
  `decisions.config.json` or is the default, the reason subsample (on, or off through
  `KERYX_DECISIONS_REASON_SUBSAMPLE`), and a `Config:` line naming what in
  `decisions.config.json` could not be used and fell back to a default;
- the recommendation-quality matrix (see "Rating the recommendation");
- the match share by stage;
- every deviation with its reason (`(none given)` when you gave none);
- your own answers and typed reasons, in full (see above);
- how many questions **looked irreversible** and how many of those would have been
  blind but were asked the ordinary way because of it (`blind refused`), overall
  and per stage. A high count on questions that were really ordinary means the
  irreversible list over-matches and is eating the measurement.

The first answer is the one counted for the match share. A changed answer is
counted separately, because it was given after the reveal.

In the shell the same report is `/decisions`, and the sidebar shows a
`N decisions · /decisions` row once the journal holds a record; clicking it opens
the report. `/decisions arms` (or a click on the arms row) opens the arm summary: the
share per arm, the reasons named, the ineligible line and the progress. `/decisions`
works while a turn is running.

## Importing earlier decisions

Questions you answered before the journal existed (a poll in a chat, say) can be
loaded as the "before" arm of a comparison:

```text
keryx decisions import <file.jsonl> [--dry-run] [--json]
keryx decisions report --line
```

One decision per line:

```json
{"id":"bf-p12-q0","at":"2026-08-14T09:30:00Z","flow":"392","stage":"design","question":"...","options":[{"id":"o0","label":"..."},{"id":"o1","label":"..."}],"recommendation":{"optionId":"o0","reason":"..."},"source":"poll 12","answer":{"choice":"o0"},"reason":"only when you deviated"}
```

`recommendation` and `answer` may be `null`; `answer.other: true` marks your own
words instead of an option. Each line is checked (unique option ids, a
recommendation and an answer that are options): a line that is not a decision is
skipped, named with its line number and why, and counted, and the rest is
imported. An id that is already in the journal is skipped and reported, which
makes the import safe to repeat, and two imports at once are serialised by a lock file next to the journal (`journal.jsonl.lock`; a run that finds one waits, and one left by a dead process is cleared); a backfilled decision whose answer is missing
(an interrupted write) gets just that answer on the next import. `--dry-run` only
counts. It prints `Imported: N, skipped: S, with recommendation: R, answered: A,
deviations: D`, plus `, repaired: R` and `, malformed: M` when there are any. With
`--json` a failure is `{"error": "..."}`.

An imported decision is **backfilled** and **legacy**: its recommendation was written
down after the fact, its time to answer is unknown, and it was not drawn by the arms.
An ordinary record is stamped `legacy: true` and goes to arm A; a line with
`"mode":"blind"` goes to arm D. A record that is already in the journal from before
the arms (no `arm` field) is read the same way, so the roughly 87 pre-v2 records need
no rewrite (the journal is append-only and is never rewritten). Running the import
again changes nothing. The arm a legacy record carries only says how it was shown
(marked or blind); it was **not randomized**, so the report keeps it in a "Legacy,
before the arms" block, split by that arm, and never mixes it into the arm tables.
It stays apart from the live records everywhere. The report has a block "до (историческое,
дозаполнено задним числом)" with the total, the decisions that had a
recommendation, the matches and their share, and every deviation with its reason;
the live numbers and the median time to answer never include it, and `--json` has
a `backfilled` section. `report --line` prints one line in Russian for a daily
message, for example `Журнал решений: всего 70 (до: 60, после: 10). Совпадение с
рекомендацией: видимая 80% (4/5), скрытая 60% (3/5); до: 72% (36/50).` (`нет
данных` where there is nothing to divide). In the shell a bare `/decisions change`
and `/decisions reason` never pick a backfilled decision, and the sidebar row
counts them apart (`10 decisions + 60 before`).

## Driving it from another agent or a chat bridge

keryx and a chat bridge know nothing of each other, so the journal is driven by
three commands any agent can call:

```text
keryx decisions open --question "<text>" --option a=<label> --option b=<label> \
    --recommend a --reason "<why>" [--stage <name>] [--flow <id>] [--action <tag>] \
    [--channel <name>] [--json]
keryx decisions answer <id> --choice <id> [--reason "<why>"] [--json]
keryx decisions reason <id> --text "<why>" [--json]
```

1. Call `open` **before** showing the question. It writes the record and prints the
   mode, the order to show and whether to mark the recommendation.
2. Show the question as told, and take the answer.
3. Call `answer`. It prints the reveal (the recommendation) and the time taken,
   and says whether the human may add a reason.
4. If it did, ask for it once and call `reason` with what the human says. (keryx's
   own `ask_user` waits for it; an empty answer is recorded as absent.)

`--flow` and `--stage` default to what the checkout says (`KERYX_FLOW`, the
branch, the only flow in progress). `--channel` says where the question is shown
(`telegram` for a chat bridge); it is lower-cased, and a question without one is `tui`.
A bridge that shows polls must pass `--channel telegram`: that is what lets the report
treat arms A and B as one condition there. A failure here is
reported on one line and never has to stop the question.

keryx's own `ask_user` tool does all of this for you.

## Rating the recommendation

Matching the recommendation is not the same as the recommendation being good. After a
decision is closed you can rate it:

```text
keryx decisions rate <id> good|bad|unclear [--note "<why>"] [--json]
keryx decisions rate --blind-model --model "<label>" --model-cmd "<command>" \
    [--since <date>] [--id <id>] [--limit <n>] [--json]
```

- `rate <id> ...` is **your** rating and the main measure. It needs a closed decision.
- `rate --blind-model` has a model rate every closed decision that carries a
  recommendation, in a **clean context**: the model gets only the question and the
  options, numbered, in the order you saw them, with the recommendation mark removed
  and no reason, no choice and no conversation history. Its pick is compared with the
  agent's recommendation (`good` when they agree, `bad` when they do not, `unclear`
  for no usable answer). `--model` is the label the rating is filed under;
  `--model-cmd` is a command that reads the prompt on stdin and prints the answer
  (for example `claude -p`). Each call is a new process, which is what makes the
  context clean, and a rating records `cleanContext: true` only when the call really
  carried no earlier messages. A decision already rated under the same label is
  skipped, and imported records are left out (their recommendation was written after
  the answer).

Ratings are appended to `.metaproject/data/decisions/quality.jsonl` (mode 0600), a file
of their own next to the journal. The report shows a matrix with your rating in the
rows and the model's in the columns, and your rating against whether you followed the
recommendation. Every model rating is labelled **model self-assessment**.

## Exporting for analysis

```text
keryx decisions export [--since <date>] [--format jsonl|json] [--exclude-legacy]
```

One row per decision with its **structure only**: arm, seed, preselected, forced,
legacy, channel, the display order as option positions (never ids), the position of
the recommended and the chosen option, whether you deviated, how many times you
changed the answer, whether the question was `eligible`, whether a reason was
requested (`reasonRequested`) and whether one was named (`reasonNamed`, a yes or no,
never the words), the quality ratings and the times. There is no question text, no
option label or description, no reason and no note; the decision id is replaced by a
short hash, and a stage, channel or model name is kept only when it is a plain
identifier. A test plants strings in every text field and fails if one reaches the
export, so the file can be shared without reading it first.

## What the journal does NOT measure

Read the numbers with these limits in mind:

- **Arms A and B are indistinguishable in Telegram.** A Telegram poll cannot start with
  an option highlighted, so a question asked there shows the "recommended" mark and
  no preselection whichever of the two arms was drawn. The report merges A and B into
  one "A+B" row for the `telegram` channel, and the effect of preselection can only be
  read from the `tui` channel.
- **Model ratings are a self-assessment by the same model.** The model that rates a
  recommendation in a clean context is usually the model that wrote it, so it will tend
  to agree with itself, and a clean context does not remove that. Treat the model
  columns as a consistency check; your own rating is the measure.
- **The legacy records are not randomized.** The roughly 87 records from before the
  arms were shown marked, or blind, by a hand-made rule, not drawn. Their share
  of matches cannot be compared with the randomized arms, which is why they have a
  block of their own and why `--exclude-legacy` exists.
- **A forced A is not randomized either.** Irreversible questions are always arm A, so
  "A forced" is reported apart from "A free".
- **A match is not a good recommendation.** Following the recommendation can mean the
  recommendation was right, or only that it was marked. Only the arm comparison and
  your rating separate the two.

## What it does not do

- Journaling itself never blocks or delays a question: a journaling failure is
  shown as a one-line note in the transcript and the question goes on. The single
  deliberate wait is the optional reason prompt after a deviation, or inside the
  one-in-three reason subsample (see above).
- The tool-permission picker (allow / deny a tool call) is not journaled; it is
  an approval, not a question with a recommendation.
- It judges nothing and gates nothing; the report is a mirror.
