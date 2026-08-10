# Keryx version update checks for shell and Metaproject agents

Status: formalized
Source: user description

## Problem

An installed Keryx can silently lag the latest npm release. The interactive
shell does not surface that fact, and agents routed through a generated
`.metaproject/index.md` have no stable, bounded command for checking it. Users
therefore keep running stale binaries and may mistake old CLI behavior for the
code or documentation currently under review.

## Expected Outcome

Keryx owns one dependency-free, cached, typed npm version check. `keryx shell`
starts it without delaying either TUI or readline startup and only shows an
upgrade advisory when npm `latest` is strictly newer. `keryx version check`
exposes the same result to humans and agents. Generated Metaproject indexes tell
agents to run that command once per session and to notify without blocking work.

## Out of Scope

- Automatically installing or executing an upgrade.
- Sending credentials, project data, or configurable URLs to npm.
- Guaranteeing that an external agent obeys Markdown prompt guidance.
- Backporting discovery into already-published `0.2.17`; the first
  feature-bearing release still needs one manual/external discovery.
- Changing `keryx update`, which refreshes a project workspace rather than the
  globally installed npm package.
