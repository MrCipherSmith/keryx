# T44 deterministic native controller fixture race

Source frozen, only two authorized test files changed. No product code, staging, commit, push or install.

## Cause and reproduction

The fixture claim helper read a SessionRecord then immediately asserted its controller-claim POST succeeded. A real native event can advance SessionRecord.version in between. CI failed the second takeover claim with409 stale-version, while AC8 on the same head passed.

The regression holds a real HTTP GET response, applies a real controller release through HTTP +the native MachineBridge, waits for applied native projection/command settlement, then delivers the old captured GET response to the helper. Original helper deterministically fails at the same `success` assertion as CI. RED: `07-24-59-426Z-011162_run.log`.

## Repair and invariants

Only fixture `claim` refreshes pins on409 with error.code exactly stale-version, with at most four total attempts. It does not sleep, retry an entire test, bypass CAS, accept authority conflicts or weaken product behavior. Three real network regressions pass70assertions (`07-27-20-503Z-0a9441`):

- controller claim refreshes pins when an applied native release overtakes its captured snapshot
- controller claim does not retry a real controller conflict
- controller claim bounds repeated stale-version refusals to four fresh reads

The last two use actual HTTP validation/conflict responses; no manufactured success response or product event is injected.

## Verification

Root types, scripts types, owned lint and diff-check PASS. Related eight bridge network files plus managed execution suite: **93pass,1preexistingtodo,0fail,7,775assertions across9actual files**,192.53s (`07-31-07-190Z-bbd2b7`). Original R2.1 passed; observer/stale approval and controller-generation negative cases remain green. A standalone src/hub/remote-v2/queue.test.ts does not exist; native queue coverage ran through bridge.queue and work/execution.

Changed files:

- `src/lib/hub-machine/bridge.test-support.ts`
- `src/lib/hub-machine/bridge.queue.network.test.ts`

Routing: exact failing files; no graph needed; testing/wiki context previously read; ctx searches/output used; no bare rg.

Checked source: HEAD `a862a0a3ea5d7f085e2fde1e86097b3486ae556a` plus the two frozen fixture changes. Exact SHA256 hashes are in the JSON. No code changed after checks began.
