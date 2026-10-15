# Let the review arbiter answer policy questions

A review sometimes stops to ask a question that is about policy, not about the code: may it
widen the scope, spend more of the budget, go on with part of the files covered, retry with a
smaller slice. In a review run by `review-auto` or with `--autonomous` nobody is there, and the
old behaviour was a word heuristic: take the recommended option unless the question sounds
dangerous.

The **review arbiter** replaces that heuristic for the questions it understands. It is a small
model call in a sub-agent that can run no shell command, write no file and open no network
connection. It answers from a file of **numbered rules** that you can read and change, it logs
every answer with the rule it used, and when it cannot decide it says so: the run then takes the
safe path, not a guess.

It decides nothing that is irreversible, and nothing that always needed a person.

## When it is consulted

| Mode | A tagged policy question | An untagged question |
|---|---|---|
| `ask` (an ordinary session) | You are asked. The arbiter is not consulted. | You are asked. |
| `review-auto` | The arbiter answers. A `deny` or `escalate` goes to you, with a notice that says which. | The old behaviour: the recommended option. |
| Autonomous (`keryx review run --autonomous`) | The arbiter answers. A `deny` or `escalate` is a refusal, and a line goes into `answers.ndjson`. | The safe default of the autonomous profile. |

A question is **tagged** when the review skill raises it with a `policy` field: a `kind` and a
few numbers and booleans (`facts`) that describe the option it recommends. The model's prompt is
built from the validated kind, the number of options, which one is recommended, those facts and
the rules, and from nothing else. The question text, the option labels, and anything quoted from
the diff, a finding or a pull request comment never reach the arbiter, so text planted in a pull
request cannot talk it into an answer.

## The floor: what it is never asked

These are refused or sent to a person before any model is called, and the log says `floor`:

- a question marked irreversible, or tied to a named action such as a release or a merge;
- a question the loop saw shaped by content from outside (a fetched page, a tool result that
  carried instructions, a pull request body);
- a question after the operator already said no to the same thing;
- any call that needs approval for being destructive, touching credentials, publishing, asking a
  hook, being always-ask, or coming from an untrusted origin.

In an autonomous run a floor question is a refusal, recorded with the basis `refused-floor`.

## The rule file

The bundled rules are `src/review/arbiter-rules.json` in the package. They are one JSON object:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "R-04",
      "kinds": ["budget"],
      "verdict": "allow",
      "text": "Allow the recommended step when it does not raise the budget and 90 percent or less of the budget is used.",
      "when": [
        { "fact": "raisesBudget", "op": "==", "value": false },
        { "fact": "budgetUsedPercent", "op": "<=", "value": 90 }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | A positive whole number. Raise it when you change the rules; it is written to every log line. |
| `id` | `R-` and two or three digits, unique. A rule without an id, or with one that does not look like that, makes the whole file invalid. |
| `kinds` | One or more of `scope`, `budget`, `option_choice`, `partial_coverage`, `smaller_slice`, `slice_order`, or `*` for all. |
| `verdict` | `allow`, `deny` or `escalate`. Nothing else. |
| `text` | The rule in a sentence, up to 600 characters. This is what the model reads. |
| `when` | Conditions on the question's facts, written `fact op value` with `==`, `<=`, `>=`, `<` or `>`. All of them must hold. |

`allow` means the recommended option is taken. `deny` refuses it. `escalate` means the arbiter
will not decide: a person has to.

The facts each kind carries (all required):

| Kind | Facts |
|---|---|
| `scope` | `filesInScope`, `widensScope`, `outsideRepository` |
| `budget` | `budgetUsedPercent`, `raisesBudget` |
| `option_choice` | `changesFiles`, `reversible` |
| `partial_coverage` | `coveragePercent`, `blockersOpen` |
| `smaller_slice` | `retryCount`, `sliceCount` |
| `slice_order` | `blockersFirst`, `sliceCount` |

keryx does not take the model's word for which rule applies. After the answer comes back it
checks that the rule exists, covers the question's kind, has the same verdict as the model gave,
that every `when` condition holds for the facts, and, for an `allow`, that the option taken is the
recommended one. If several rules hold, the stricter verdict wins: `deny` over `escalate` over
`allow`. An answer that fails a check is an `escalate`.

### Change the rules for a project

Put your own file at `.metaproject/review/arbiter-rules.json`. It **replaces** the bundled rules,
it is not merged with them, so copy the bundled file and edit it. To make the arbiter stricter,
turn an `allow` into an `escalate` or tighten a number in a `when`. Keep a final rule with
`"kinds": ["*"]` and the verdict `escalate`, so a case no rule fits ends in a person, not a gap.

A project file that cannot be read or does not validate is never half used: every question
escalates, and the log says `rules-invalid` with the first problem. The same holds for a
`review.arbiter` block that is malformed (`config-invalid`). Change a rule, then run a review
that asks a question of that kind and read the line in `arbiter.log`: the rule id and the rules
version are on it.

## Configuration

In `.metaproject/tasks.config.json`:

```json
{
  "review": {
    "arbiter": {
      "enabled": true,
      "tier": "light",
      "model": "anthropic/claude-haiku-4-5",
      "callCap": 20,
      "timeoutMs": 20000
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` puts `review-auto` and the autonomous profile back on their old behaviour. |
| `tier` | `light` | `light` or `standard`. The flagship tier (`deep`) is refused: the arbiter runs a step below it. A tier name, resolved against the provider of the session, not a model id. When nothing smaller than the session model exists, the session model is used and the log says `session-fallback`. |
| `model` | none | Pins `provider/model` and wins over the tier. |
| `callCap` | `20` | Model calls per run, at most 200. A question over the cap escalates (`cap`). |
| `timeoutMs` | `20000` | From 100 to 120000. A timeout escalates. |

The model GPT-6 Astra is refused by name, as a pin and as a tier result, whatever provider
serves it; the question then escalates with `model-refused` and no call is made.

An identical question in the same run (same kind, same facts) is answered from a cache, not a
second call, and the log line says `cached`.

## What it leaves

Every question, answered or not, writes one line to `arbiter.log`:

- in an autonomous run, to the run directory, and a copy into the review package when the run
  ends, so the record travels with the review;
- otherwise to the open review package under `.metaproject/reviews/`, or to
  `.metaproject/data/review-arbiter/arbiter.log` when no package is open yet.

A line has the time, the question kind, the facts, the verdict, the rule id, the reason, the model
and where it came from, the tokens and cost, the milliseconds, and the rules version and hash.
The reason is one of `model`, `cache`, `floor`, `invalid-kind`, `invalid-facts`,
`no-recommendation`, `cap`, `timeout`, `model-error`, `invalid-output`, `model-refused`,
`config-invalid`, `rules-invalid` or `no-model`. Nothing from the question's text is stored.

## Where you see it

In `keryx shell`:

```
/autoreview arbiter [pull request URL | number]
```

lists the log of the run in progress (or the newest run): the time, the kind, the verdict and the
rule, one line each, the last thirty. The sidebar section of a run shows `arbiter N asked`, and
`arbiter N · M escalated` in the attention colour when any question was escalated.
`/autoreview list` shows the same counts.

When an autonomous run stops without finishing and the last thing the arbiter did was an
`escalate`, the Telegram note after the usual end line says so:

```
Arbiter escalated and the run stopped: owner/repo PR #123, budget escalate (cap) (cap). A person has to decide; the log is in the package as arbiter.log.
```

## How it is tested

`src/review/arbiter-eval.fixtures.json` holds 26 policy questions with the verdict each should
get, and `arbiter-adversarial.fixtures.json` holds 28 cases built to push the arbiter into an
answer it must not give: injection text in a question, a forged rule id, a model that cites a rule
for another kind, a floor-class question. Both run in CI against a stubbed model and a recorded
one. The first set must agree at least 95 percent, the second must end in `deny` or `escalate`
every time. If you change the bundled rules, run them: `bun test src/review/arbiter-eval.test.ts`.

## Limits worth knowing

- It answers six kinds of question. Another kind escalates without a model call.
- It judges the recommended option from facts the review skill supplies. If the skill states a
  fact wrongly, the arbiter has no way to see it. The facts are numbers the review itself
  counted, which is why the arbiter takes them and not prose.
- It does not pick between options by their wording. A menu with no recommended option escalates.
- A tagged question, when the arbiter says `deny` or `escalate`, costs a person's attention in
  `review-auto`; in an autonomous run it costs the step it would have taken. Tighter rules mean
  more of both.
- The arbiter does not replace the floor. It sits under it.

See [Review a pull request with nobody at the keyboard](autonomous-review.md) for the run that
uses it, [Permission modes](permission-modes.md) for `review-auto`, and
[Review with a durable record](review-with-a-record.md) for the package that keeps its log.
