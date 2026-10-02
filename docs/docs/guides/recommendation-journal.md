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
only flow in progress. The last one is a guess: it is recorded as `inferred`
(`flowSource` on the record is `env`, `branch` or `inferred`) and the report marks
those flows `(inferred)` and counts them. The stage is the kind of the task in progress, or the
flow's status.

## Blind questions

One question in three is asked **blind**: the recommended option carries no
"recommended" mark and the options come in random order. Your answer is recorded,
and then the recommendation is revealed. This is what lets the match share mean
something: if you only ever saw the recommendation marked, you would match it
because it was marked.

A question about something on the **irreversible list** is never blind. The list has
two tiers, so that ordinary coding questions ("merge these two helpers", "drop an
unused import", "remove dead code", "force a type") are not mistaken for a release:

- **Strong terms always count**: `release`, `ship`, `publish`, `unpublish`,
  `deploy`, `rollout` / `roll out`, `promote`, `go live`, `delete`, `push`,
  `destroy`, `wipe`, `purge`, with the Russian roots `релиз`, `выпуск` / `выпуст`,
  `залить` / `залей`, `накат`, `удал`, `пуш`, `опублик`, `деплой`, `выкат` (a
  Russian root matches inside a word, so `запушить` counts). Strong patterns
  count too: `git reset --hard`, `clean -f`, `checkout --`, `rm -rf`,
  `branch -D`, `--force`, tagging a version (`tag v1.4.0`, `тег версии`),
  publishing to a registry (`to npm`, `в npm`) and going to production (`в прод`,
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
removed from what is shown.

## Changing your mind, and giving a reason

Your answer is never held back. After you answer, the transcript shows the reveal
and tells you what you can still do:

- `/decisions change <option id or label>` changes the answer of the latest
  question **asked in this session**. The journal records the session on every
  question, and with no id the command only ever touches a decision of this
  session. If the only candidate is another session's (found through the current
  flow), it changes nothing and names the decision it would have changed, with
  the `keryx decisions answer <id> --choice <option>` command to do it on purpose.
  It prints which decision it changed. Both answers are kept and
  the record says it was changed. The agent already received your first answer,
  so the change is recorded in the journal but may not reach the agent.
- `/decisions reason <why>` adds an optional reason when your answer differed from
  the recommendation, to the same decision. After a deviation the transcript shows
  one line naming it, **once per decision**; nothing waits for it, the tool result
  has already gone back, and leaving it out costs nothing (the report shows
  `(none given)`).

The same two steps from a shell are `keryx decisions answer <id> --choice <id>`
again and `keryx decisions reason <id> --text "<why>"`. An answer must be one of
the options (a free-form `ask_user` answer is recorded as such). Journal lines
that cannot be read are skipped and the report says how many. Free text you type
(a free-form answer, a reason) is collapsed to one line of at most 300 characters,
when it is written and again when it is shown, so it cannot add lines to a flow's
`journal.md` or to the report.

## The report

```text
keryx decisions report [--json]
```

It prints, from the journal alone:

- the match share overall and by mode (`ordinary`, `blind`);
- the match share by stage;
- every deviation with its reason (`(none given)` when you gave none);
- how many questions **looked irreversible** and how many of those would have been
  blind but were asked the ordinary way because of it (`blind refused`), overall
  and per stage. A high count on questions that were really ordinary means the
  irreversible list over-matches and is eating the measurement.

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
