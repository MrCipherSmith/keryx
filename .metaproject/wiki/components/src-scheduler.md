# Module src/scheduler

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/scheduler` owns the scheduled GitHub digest: on each fire the dispatcher itself runs read-only `gh` queries and reads the flow board, diffs the result against the previous run, and queues a Telegram message plus a run report. It groups 27 file(s), depends on `src/trigger`, `src/commands` and `src/lib`, and exposes 20 public symbol(s).

## Overview

`src/scheduler` owns the scheduled digest, a recurring report of what changed across the allowed GitHub repositories and the flow board: pull requests, issues, review requests, failed CI runs, and merged flows whose effect was never checked. A digest is an `agent-task` schedule whose action carries a `digest` block, and `runTriggerOnce` hands such a run to `runDigestDispatch` instead of the agent loop. The dispatcher makes every tool call in a fixed order; a model, if one runs, only summarises the finished text and has no tools.

## How it works

`runDigestDispatch` takes a per-schedule file lock (`schedule-<name>`, zero timeout), so a second concurrent fire is refused with a status line instead of running. `runLocked` then runs a fixed pipeline: the confirmed-content and granted-binary checks (a refusal before anything runs), a scratch directory, `startLimits` (one abort signal shared by the time, memory and spend limits), `collectFromGithub`, `readBoard`, the snapshot diff, `buildDigestContent` and `renderDigestText`, an optional `summarize`, the report write, and finally the delivery enqueue. Each source is isolated: a failure becomes a failure entry for that source and the others still run.

The layers are separate files. `digest-gh.ts` holds the account rule: `ghEnvForProject` sets `GH_ACCOUNT` to `work` for a project under `~/work` (or `GH_WORK_ROOT`) and to `personal` otherwise, and passes only an allowlisted part of the environment with no token variables. `digest-collect.ts` maps each catalogue tool to a source kind through `KIND_OF_TOOL`, requests `DIGEST_ROWS` (100) rows per call, and marks a full page as truncated. `digest-board.ts` does not import the product module; it calls a reader registered through `registerBoardReader`, and an absent, malformed or throwing board becomes a board failure. `digest-delivery.ts` keeps a queue on disk and sends through a `DigestSink`, which targets the project's live remote session when one exists and the service topic otherwise.

Delivery is durable and separate from the run. A failed send is retried with backoff (5 minutes, doubling, capped at 60 minutes) for up to `DELIVERY_MAX_ATTEMPTS` (12). The snapshot is written only after the message is queued, so a change is never recorded as reported before a message carries it, and a partial first baseline is not stored. Text is scrubbed of secrets before it leaves the process and capped at `DELIVERY_TEXT_MAX` (3800) characters.

## Key concepts

- **Digest schedule**: an `agent-task` schedule (flow 295) with a `digest` block, run by this module instead of the agent loop. Its injectable seams are `DigestDeps`: `runGh`, `limits`, `summarize` and `sink`.
- **Digest item**: one row from a source, keyed by source kind and repository, such as `pr:<repo>#<n>`, `ci:<repo>#<id>` or `board:<id>`. `parseDigestItems` builds them from the JSON `gh` returns.
- **Source kinds**: `pr`, `issue`, `review` and `ci` for GitHub, and `board` for the flow index.
- **Held source**: a source that failed or was truncated. The diff reports nothing from it as gone, so an unread source does not look like closed work.
- **Chain**: a `DigestChain`, a PR merged and its flow closed while the stated outcome is still unchecked.
- **Baseline run**: the first run for a schedule, with nothing to compare against. A run with no changes is reported as quiet.
- **Sink and delivery state**: `DigestSink` is the seam to serve's Telegram path, and the queue records `sent`, `queued`, `failed` or `gave-up` for each message.
- **Run id**: `dig-<timestamp>-<8 hex>`. Its report is written under `.metaproject/data/trigger/reports/<name>/`.

## Main flows

1. **A scheduled fire.** `runTriggerOnce` calls `runDigestDispatch`, which takes the lock and runs `runLocked`. The checks pass, then `collectFromGithub` calls each granted tool for each repository, `readBoard` reads the index, and `diffSnapshot` compares the items with the last snapshot. `buildDigestContent` and `renderDigestText` produce the text, the report is written, `enqueueDelivery` queues the message, `writeSnapshot` stores the new baseline, and `flushDeliveries` sends it when a sink is present.
2. **A refusal or a stop.** `announceRefusal` queues a short line, `Digest <name> stopped — <reason>`, instead of a digest. A stopped run uses the same path, and a run that found no source at all sends a status line that names the failed sources.
3. **Delivery retry.** `flushDeliveries` sends each due message to the session topic or the service topic. A `queued` result is left to the hub's own outbound queue. A failed send is kept with a later `nextAt` and tried again, and the report gets a `## Delivery` line for each attempt.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DigestDeps`
- `DELIVERY_TEXT_MAX`
- `scrubDigestReportLocator`
- `runDigestDispatch`
- `REPO`
- `OTHER_REPO`
- `TestClock`
- `DigestTestEnv`
- `setupDigestEnv`
- `DigestScheduleOptions`
- `digestScheduleEntry`
- `addDigestSchedule`
- `PrRow`
- `prJson`
- `issueJson`
- `ciJson`
- `GhKind`
- `FakeGhCall`
- `kindOfArgv`
- `FakeGh`

### Key files

- `src/scheduler/digest-run.ts` - imported by 4, imports 20
- `src/scheduler/digest.test-helpers.ts` - imported by 9, imports 9
- `src/scheduler/digest-delivery.ts` - imported by 10, imports 3
- `src/scheduler/digest-gh.ts` - imported by 12, imports 1
- `src/scheduler/digest-board.ts` - imported by 9, imports 2
- `src/scheduler/digest-collect.ts` - imported by 2, imports 8

### Depends on

- `src/trigger` - 22 import(s)
- `src/commands` - 8 import(s)
- `src/lib` - 5 import(s)
- `src/remote` - 1 import(s)
- `src/security` - 1 import(s)
- `src/harness/provider` - 1 import(s)

### Depended on by

- `src/intake` - 12 import(s)
- `src/commands` - 9 import(s)
- `src` - 1 import(s)
- `src/tui` - 1 import(s)

### Dependency basis

- Production imports only: 41 import(s) from test file(s) (e.g. `src/commands/agent-granted-json.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 27
- Cross-module imports: 38

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/trigger](src-trigger.md)
- [Module src/commands](src-commands.md)
- [Module src/lib](src-lib.md)
- [Module src/remote](src-remote.md)
- [Module src/security](src-security.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/intake](src-intake.md)
- [Module src](src.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
