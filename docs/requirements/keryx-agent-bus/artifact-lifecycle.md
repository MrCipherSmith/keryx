# Artifact Lifecycle: Keryx Agent Bus
Version: 0.2.0

## Status

Specification ready (future). The storage paths are defined in
[specification.md](specification.md) §2.

## Why the bus manages its own retention

The retention engine (`src/retention/`) walks only `.metaproject/`. The bus
lives in the git common directory (D-02), so the bus bounds its own storage.
Every step below runs lazily inside a normal append or poll, the same way
external slates clean up after themselves (`src/session/external-slate.ts`).
There is no daemon. `keryx bus prune` runs the same steps on demand.

## Presence record

| State | Condition | Transition |
|---|---|---|
| live | `heartbeatAt` at most 15 s old | Rewritten every 5 s by its owner. |
| stale | older than 15 s, same host, pid alive | Listed with a `stale` marker. Receives no new messages. **Keeps** the pause leases and session lease it holds (D-03, D-09). |
| gone | older than 15 s and (pid dead or other host) | Hidden from lists. The file is deleted by the next instance to join or prune once it is older than 24 h. |
| removed | owner exited cleanly | The owner deletes the file. |

## Session lease

| State | Condition | Transition |
|---|---|---|
| held | directory present, heartbeat fresh | Refreshed every 5 s. |
| stale | heartbeat older than 15 s, same host, pid alive | Reclaimed only with `--take-over`. |
| reclaimable | heartbeat older than 15 s and (pid dead or other host) | Taken over silently by the next open. |
| released | the owner exits | The owner removes the directory, after a token check. |

## Pause lease

| State | Condition | Transition |
|---|---|---|
| active | the file exists, `now < expiresAt`, and the holder is not gone (a stale holder keeps it; a CLI holder is bounded by the TTL alone) | Created together with its `pause-request` event, under one `append.lock` hold. Never applies to its own holder. |
| ended | `resume` from the holder, or `keryx bus resume` from an operator outside a tool call (D-13) | The writer deletes the file and writes `resume`. |
| expired | `now >= expiresAt`, or the holder is gone | The first instance to observe it takes `append.lock` and checks the file still exists. Only then does it write `lease-expired` and delete the file, so the event is written exactly once. |
| overridden (per target) | the target's operator ran `/bus override` | The file is kept for the other targets. The target records `override`, and its shell stops honouring the lease. |

## Event log

- **Append.**
  1. Hold `append.lock`.
  2. Take `seq = max(head.seq, seq of the last complete line) + 1`, so a
     crash between the append and the head update cannot cause a duplicate.
  3. Write one line.
  4. Rewrite `head.json` atomically.
- **Rotation.** On an append that would take `events.jsonl` past 1 MiB, in the
  same lock hold:
  1. rename the file to `events.<n>.jsonl`;
  2. start a new file;
  3. record the new `segment` and `segmentInode` in `head.json`.
- **Kept segments.** At most two rotated segments. Older ones are deleted at
  rotation.
- **Age bound.** Rotated segments older than 7 days are deleted by the next
  rotation or prune.
- **Readers.** A reader compares `head.json`'s segment and inode with its cursor
  **before** comparing sizes. When the segment was rotated under it, the reader
  finishes the old file, then switches (spec §5.2, AC16).
- **Contents.** Bodies are already redacted. The log is local, mode `0o600`,
  and never committed: it lives under `.git/`, outside the working tree.

## What is never stored

- transcripts, prompts, tool output or hidden reasoning;
- credentials, which are redacted at write;
- Flow state (D-11).
