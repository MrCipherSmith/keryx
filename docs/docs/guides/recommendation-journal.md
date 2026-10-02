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
- the display mode: `ordinary` or `blind`;
- your choice and the time it took you to answer;
- a reason for deviating, when you give one.

The journal is `.metaproject/data/decisions/journal.jsonl` (append-only, mode
0600, git-ignored in this repository). There is one journal per repository, under
the main checkout: every git worktree reads and writes the same file. Inside a
flow, the answer also adds one line to that flow's `journal.md`; outside a flow
only the project-wide journal is written. The flow is `KERYX_FLOW` when it is set,
else the flow named by the git branch (`flow-392`, or the flow's slug), else the
only flow in progress; the stage is the kind of the task in progress, or the
flow's status.

## Blind questions

One question in three is asked **blind**: the recommended option carries no
"recommended" mark and the options come in random order. Your answer is recorded,
and then the recommendation is revealed. This is what lets the match share mean
something: if you only ever saw the recommendation marked, you would match it
because it was marked.

A question about something on the **irreversible list** is never blind. The built-in
list is `release`, `delete`, `remove`, `push`, `publish`, `unpublish`, `deploy`,
`merge`, `drop`, `force`, `destroy`, `wipe` and `purge`, with Russian roots
(`релиз`, `удал`, `пуш`, `отправ`, `опублик`, `слить`, `слив`, `мерж`, `деплой`,
`выкат`, `сброс`; a Russian root matches inside a word, so `запушить` and
`смержить` count); add your own words in
`.metaproject/decisions.config.json`, which extends the built-in list and cannot
shorten it:

```json
{ "irreversible": ["migrate", "drop"] }
```

A word matches at the start of a word in the question text, in the `--action`
tag the agent passes, or in any option's id, label or description,
case-insensitively. When in doubt, keryx treats the question
as irreversible. A question with no recommendation is never blind. In a blind question a mark
written into a label, such as `(Recommended)`, `[recommended]`, `- recommended`,
`Recommended:` or a star, is removed from what is shown.

## Changing your mind, and giving a reason

Your answer is never held back. After you answer, the transcript shows the reveal
and tells you what you can still do:

- `/decisions change <option id or label>` changes the answer of the latest
  question (or name another with the id from `keryx decisions report`). Both
  answers are kept and the record says it was changed.
- `/decisions reason <why>` adds an optional reason when your answer differed from
  the recommendation. It is offered **once**; nothing asks you for it, and leaving
  it out costs nothing (the report shows `(none given)`).

The same two steps from a shell are `keryx decisions answer <id> --choice <id>`
again and `keryx decisions reason <id> --text "<why>"`. An answer must be one of
the options (a free-form `ask_user` answer is recorded as such). Journal lines
that cannot be read are skipped and the report says how many.

## The report

```text
keryx decisions report [--json]
```

It prints, from the journal alone:

- the match share overall and by mode (`ordinary`, `blind`);
- the match share by stage;
- every deviation with its reason (`(none given)` when you gave none).

The first answer is the one counted for the match share. A changed answer is
counted separately, because it was given after the reveal.

In the shell the same report is `/decisions`, and the sidebar shows a
`N decisions · /decisions` row once the journal holds a record; clicking it opens
the report. `/decisions` works while a turn is running.

## Driving it from another agent or a chat bridge

keryx and a chat bridge know nothing of each other, so the journal is driven by
three commands any agent can call:

```text
keryx decisions open --question "<text>" --option a=<label> --option b=<label> \
    --recommend a --reason "<why>" [--stage <name>] [--flow <id>] [--action <tag>] [--json]
keryx decisions answer <id> --choice <id> [--reason "<why>"] [--json]
keryx decisions reason <id> --text "<why>" [--json]
```

1. Call `open` **before** showing the question. It writes the record and prints the
   mode, the order to show and whether to mark the recommendation.
2. Show the question as told, and take the answer.
3. Call `answer`. It prints the reveal (the recommendation) and the time taken,
   and says whether the human may add a reason.
4. If it did, offer it once, without holding the answer back, and call `reason`
   whenever it arrives.

`--flow` and `--stage` default to what the checkout says (`KERYX_FLOW`, the
branch, the only flow in progress). A failure here is
reported on one line and never has to stop the question.

keryx's own `ask_user` tool does all of this for you.

## What it does not do

- It never blocks or delays a question: a journaling failure is shown as a
  one-line note in the transcript and the question goes on.
- The tool-permission picker (allow / deny a tool call) is not journaled; it is
  an approval, not a question with a recommendation.
- It judges nothing and gates nothing; the report is a mirror.
