# Delivery recovery
Version: 0.1.0

Git publication runs through the durable delivery service, outside the global mutation queue. The old direct domain delivery entry refuses before calling Git. A request keeps its original operation ID and immutable revision. Retrying a pending or interrupted operation never starts a second publication.

## Inspect and reconcile

These legacy Hub API routes require a current human operator with writable access to the project. Agent and reviewer credentials cannot read or resolve delivery jobs. A job from another project is not found. Mutating cookie requests also require the normal same-origin checks and `Idempotency-Key` header.

| Method and path below `/hub/v1/projects/{projectId}` | Purpose |
| --- | --- |
| `GET /delivery-jobs` | Up to 50 hot jobs, active jobs first and recent completed jobs next. |
| `GET /delivery-jobs/{jobId}` | Exact durable job, current version, original pins, result and reconciliation audit; archived jobs remain readable. |
| `POST /delivery-jobs/{jobId}/reconcile` | Explicit human reconciliation of an `uncertain` or `result` job. |
| `POST /delivery-jobs/{jobId}/archive` | Move a completed job to preserved cold storage. |

A reconciliation body has exactly `expectedVersion` (the current positive job version), `decision`, and a nonempty `reason` of at most 2,000 UTF-8 bytes. A stale version is rejected with `409 version-conflict`; the operator must inspect the new state before deciding again. Available decisions:

- `confirm-no-effect`: the operator explicitly attests that the operation did not publish externally. This records a completed no-effect response and releases the project fence. A server-recorded published result cannot be overridden with this decision.
- `finalize-recorded-result`: consume only the original server-recorded result. Client-supplied results, commits, branches and arbitrary state changes are not accepted.
- `inspect-publication`: perform a read-only Git inspection of the deterministic managed branch. The observed commit must contain the exact original `Hub-Operation` fingerprint, and its tree is read from Git. No commit, cherry-pick or push is performed. Unavailable or mismatching proof leaves the job fenced. Authority and job version are checked again after inspection.

A thrown publication adapter error is an **uncertain** outcome: the job remains fenced, with no invented failed Delivery fact. The built-in adapter throws this outcome after an attempted push whose reply is lost or times out. If push success is known but receipt-file persistence fails, the known published result is still returned and recorded. A custom adapter must return `failed`/`conflict` only for a definitive non-publication outcome; ambiguous external outcomes must throw.

The job records the resolving principal, decision, reason and timestamp. These transitions do not accept product work or change a selected integration line. Original delivery retries return the recorded response; reconciliation never invokes the publication adapter again. A service shutdown waits for an in-progress publication or reconciliation before closing its storage.

## External facts survive concurrent changes

The exact adapter result is persisted before later authority and integration-line checks. The corresponding Delivery fact is recorded independently of line CAS. If the selected line changes during a push, the response remains `409`, includes `operationId` and `externalResult`, and leaves the newer selection untouched. The published branch/commit remain visible through Delivery history and the exact job endpoint. If authority expires after publication, a current operator can inspect and finalize the recorded result.

## Explicit cold archive

The hot delivery-job working set is capped at 10,000 rows. When it fills, new publication reservations are refused; they do not erase history. An operator can archive a reviewed completed job with exactly `{expectedVersion, reason}`. Pending, uncertain and unfinalized result jobs cannot be archived to bypass their fence.

Archiving atomically moves the exact job body and its archival audit from `hub_delivery_jobs` into `hub_delivery_jobs_archive` and removes its hot row. Exact ID reads and original idempotent retries continue to work across both stores. Delivery facts and original replay history are retained. Cold history intentionally grows until an explicit future export/retention policy is introduced; it is not silently deleted and remains part of the Hub database backup. This frees hot admission capacity, not disk space.
