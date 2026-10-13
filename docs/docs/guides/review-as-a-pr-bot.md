# Review as a pull request bot

**The problem:** a review that lives in a terminal session does not reach the
pull request, and nobody can tell afterwards whether it was worth reading.

**What you get:** a GitHub Actions job that reviews each same-repository pull
request, has a second model turn try to refute every finding, and posts **one**
review with an inline comment per finding. Every finding is stored as a
[managed review](review-with-a-record.md), and `keryx review metrics` can say how
many were acted on and how many were wrong, but only on a machine that holds
those review packages (see [Metrics](#metrics)).

Nothing here has been run against a real GitHub repository or a real model
provider by the people who wrote it; the tests inject fakes for both. Try it on
a scratch repository first, with `post: "false"` (see [Dry run](#dry-run)).

## Set it up

1. Add the key your model provider gives you as a repository secret, for
   example `ANTHROPIC_API_KEY` (Settings, Secrets and variables, Actions).
2. Copy [`docs/examples/review-bot.yml`](https://github.com/MrCipherSmith/keryx/blob/main/docs/examples/review-bot.yml)
   to `.github/workflows/review-bot.yml`:

```yaml
name: keryx review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: keryx-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: MrCipherSmith/keryx@v0.3.46
        with:
          model-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          max-diff-bytes: "200000"
```

The action installs keryx from npm, then runs `keryx review bot run` and
`keryx review bot post --post`. Inputs: `model-api-key` (required), `api-key-env`
(the variable name the provider reads, default `ANTHROPIC_API_KEY`), `provider`,
`model`, `max-diff-bytes`, `github-token`, `keryx-version` and `post`.

## Secrets

- The provider key is passed to the action as one input and reaches the step as an
  environment variable. It is never written to a file, never put on a command
  line and never echoed.
- The job needs `contents: read` and `pull-requests: write` and nothing else.
- `persist-credentials: false` keeps the checkout token out of the git config.
- Keep `uses:` pinned to a release tag, as in the example, and move it forward deliberately. `@main` runs unreleased code with your provider key.

## Same-repository pull requests only

The bot refuses to run on a pull request whose head is in a fork, and it checks
this in three places: the workflow's job `if:`, a guard step at the top of the
action, and `keryx review bot run` itself, which reads the pull request and stops
before any model call. A fork pull request would otherwise run with a token and a
secret chosen by someone who does not control the repository.

Do not switch the trigger to `pull_request_target` to make forks work. The
example workflow test fails on it.

## Dry run

`keryx review bot post` prints what it would send and sends nothing unless you
pass `--post`:

```bash
keryx review bot run --pr 7 --repo acme/app   # calls the model, posts nothing
keryx review bot post --pr 7 --repo acme/app   # prints the payload, sends nothing
keryx review bot post --pr 7 --repo acme/app --post
```

Set the action input `post: "false"` to get the same behaviour in CI. The post
step also refuses when the pull request is closed or merged, when `--sha` is not
the current head, or when the review was made at an older commit. The one write
it performs is a single `POST repos/{owner}/{repo}/pulls/{n}/reviews` with event
`COMMENT`; a comment that quotes a line outside the diff goes in the review body
instead of inline. A comment that would carry a secret-shaped string is withheld
and counted, never masked and posted; the same check covers the review body and
each finding's file header. A finding whose file is not in the diff is posted
without a file header, and a finding without a quote is never placed inline.
The review body ends with a hidden marker naming the head commit, and the post
step refuses when a review carrying that marker is already on the pull request.

## What one run costs

One reviewer turn over the diff, then one verifier turn per finding. The diff is
cut at `--max-diff-bytes` (default 200,000 bytes, roughly 50,000 tokens) at a line
boundary. When it is cut, the review says so and lists nothing about the files
after the cut. When the cut leaves no findings, the review is still posted so the
reader learns the coverage was partial. A smaller cap costs less and sees less. Findings the verifier
refutes are dropped and not stored.

## Metrics

The Action's runner writes the review packages and the bot state under
`.metaproject/` and keeps them only for the length of the job; nothing uploads
them, so the Action does not produce `keryx review metrics`. Metrics need the
managed review packages on the machine where you run `keryx review complete` and
`keryx review metrics`.

The numbers below are illustrative.

```console
$ keryx review metrics
Review metrics: 3 review(s) on 2 pull request(s).
Findings raised: 9
  acted on: 4
  dismissed: incorrect 1, won't fix 1, out of scope 0, deprioritised 0
  answered, disagree: 0
  still unknown (open): 3
Precision: 80% (4 acted on, 1 dismissed as incorrect)
Resolved before merge: n/a (no merged pull request on record; run with --refresh to read merge state)
```

- **Precision** is acted on divided by (acted on plus dismissed as incorrect).
  A finding nobody has looked at, or that was dismissed as won't fix, out of
  scope or deprioritised, is in neither half.
- **Resolved before merge** is a proxy. A finding counts as resolved when its
  pull request has a recorded merge time, it has a disposition other than
  unknown, and its review package was last updated at or before that merge. The
  package's `updatedAt` stands in for when the disposition was recorded, because a
  disposition carries no timestamp of its own. The denominator is every finding on
  merged pull requests.
- A ratio with nothing behind it prints `n/a`, not `0%`.
- `--refresh` reads each pull request's state from GitHub (a read) so merge times
  are current. `--json` prints the same numbers as JSON.
- The counts cover every managed review of a pull request, not only the ones the
  bot ran, and leave out findings imported from other reviewers.

Record what happened to a finding with `keryx review complete --finding <id>
--disposition <state>`, as described in
[Review with a durable record](review-with-a-record.md).

## Inside a session

`/reviews` in the TUI opens a list of the managed reviews with round, head commit,
findings by outcome, precision and resolved-before-merge; the sidebar's Reviews
row shows the open-findings count and opens the same list on click. In the
readline agent shell, `/reviews` prints the same numbers as text. The existing
`/review` command is unchanged.
