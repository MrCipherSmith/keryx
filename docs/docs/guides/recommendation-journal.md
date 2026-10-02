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
0600, git-ignored in this repository). Inside a flow, the answer also adds one
line to that flow's `journal.md`; outside a flow only the project-wide journal is
written.

## Blind questions

One question in three is asked **blind**: the recommended option carries no
"recommended" mark and the options come in random order. Your answer is recorded,
and then the recommendation is revealed. This is what lets the match share mean
something: if you only ever saw the recommendation marked, you would match it
because it was marked.

A question about something on the **irreversible list** is never blind. The built-in
list is `release`, `delete`, `push`, `publish` and `deploy`; add your own words in
`.metaproject/decisions.config.json`, which extends the built-in list and cannot
shorten it:

```json
{ "irreversible": ["migrate", "drop"] }
```

A word matches at the start of a word in the question text or in the `--action`
tag the agent passes, case-insensitively. When in doubt, keryx treats the question
as irreversible. A question with no recommendation is never blind.

## Changing your mind, and giving a reason

If you change your answer after the reveal, both answers are kept and the record
says it was changed. When your answer differs from the recommendation you are
asked **once** for an optional reason; an empty reply is recorded as no reason.

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
   and says whether to ask for a reason.
4. If it did, ask once and call `reason`.

`--flow` defaults to the `KERYX_FLOW` environment variable. A failure here is
reported on one line and never has to stop the question.

keryx's own `ask_user` tool does all of this for you.

## What it does not do

- It never blocks or delays a question: a journaling failure is swallowed.
- The tool-permission picker (allow / deny a tool call) is not journaled; it is
  an approval, not a question with a recommendation.
- It judges nothing and gates nothing; the report is a mirror.
