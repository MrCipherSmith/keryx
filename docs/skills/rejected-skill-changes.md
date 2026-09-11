# Rejected skill changes

## Purpose
An append-only record of changes to keryx's own bundled skills
(`src/gdskills/bundled/skills/**`) and rules (`src/gdskills/bundled/rules/**`)
that were tried and rejected, with the evidence that sank them. The idea is
adapted (MIT) from the rejected-change ledger in
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills). Its
purpose is to stop the same rejected idea from being re-proposed blindly —
before authoring a change to a shipped skill, search this ledger for that
skill and that idea.

This file lives in `docs/` (not `.metaproject/`) because `.metaproject/`
inside this repository is keryx's own install mirror, and `docs/` is not
part of the npm-published `files` in `package.json` — this ledger is
contributor-facing history for keryx's own skill authoring, not something
that installs into a user's project.

## Append-only rule
Never edit or delete an existing row. When a proposed change to a shipped
skill or rule is rejected (by review, by a routing/behaviour-eval
regression, or by explicit user/maintainer decision), add a new row in the
same change that records the rejection. This file lives on the default
branch (`main`) so its rows survive the rejected PR's branch being deleted.

## Ledger

| date | skill | change tried | why rejected | evidence (before → after) | link |
|---|---|---|---|---|---|
