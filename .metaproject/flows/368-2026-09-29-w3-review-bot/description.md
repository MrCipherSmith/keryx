# P0 W3 review as a PR bot: headless run, verifier, inline comments, resolved-before-merge metric

Status: draft
Source: operator "по порядку" (helyx 172447), competitive review P0 item 3

## Problem

keryx has the strongest review infrastructure (managed rounds, a verifier that drops refuted findings, dispositions with evidence, PR comment collection) but it is only reachable locally. There is no headless review run, no way to post line-anchored inline comments (the PR-comment port deliberately allows only replies and issue comments), no GitHub Action, and no metric of how many findings were resolved before merge. Cursor Bugbot, Claude Code Code Review and OpenCode's Action have all of these.

## Expected Outcome

`keryx review bot run --pr <n>` reviews a pull request headlessly (a reviewer model turn, then a verifier turn per finding that can refute it), ingests the result as a managed review, and `keryx review bot post` publishes it as ONE GitHub pull-request review with inline comments anchored to diff lines, dry-run by default. `keryx review metrics` reports findings raised, acted-on, dismissed and resolved before merge. A composite `action.yml` runs it in GitHub Actions for same-repository pull requests only. The TUI shows the reviews (command, modal, sidebar).

## Outcome criteria

- On a real pull request the bot posts one review whose inline comments land on the right lines, findings the verifier refuted are absent, and `keryx review metrics` reports the resolved-before-merge ratio for it.

## Out of Scope

- Fork pull requests: a run that needs a model key and write access is refused when the head repository differs from the base repository (no `pull_request_target`).
- Resolving, hiding or dismissing threads, GraphQL calls, and merging: keryx never does these; the allow-list grows by exactly one write endpoint.
- Enabling the Action on this repository (needs repository secrets): the example workflow and docs ship, activation is the operator's step.
