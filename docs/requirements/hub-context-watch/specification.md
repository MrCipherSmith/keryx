# Keep shared Hub context current with an opt-in local watch
Version: 0.1.0

Status: planned, pending human freeze in Team Hub. Hub document path: specs/hub-context-watch.md.

## Problem and expected outcome

Manual hub sync already downloads incremental canonical wiki/OpenSpec context into one local cache shared by explicitly connected clones/worktrees. Add opt-in repeated synchronization without requiring the developer to rerun sync after every Hub update. Hub remains the source of truth. Application execution remains local.

## CLI and configuration

Planned command: `keryx hub sync --watch [--interval <seconds>] [--token-env <name>]`. It runs in the foreground until interrupted; it is not an installed daemon. The standalone client supports the same arguments without the hub prefix. Default interval is 15 seconds; only integer values 5 through 3600 are valid. --interval requires --watch. Unknown/repeated/missing flags fail before network or filesystem writes. A missing trusted binding or credential fails before polling. Existing explicit binding and token-env precedence are preserved; never trust a copied checkout hint as enrollment.

Run one immediate sync, then wait the configured interval after each completed successful cycle. Never overlap cycles in one process. Emit one bounded JSON line per cycle/state transition with required state (updated, unchanged, retrying, busy, fatal, stopped), optional revision (nonnegative safe integer for the last committed cache), optional errorCode, and optional retryAfterSeconds (nonnegative safe integer). These are the only fields; omit unknown values. Each UTF-8 JSON line is at most 2048 bytes excluding the newline. errorCode is one of network, timeout, rate-limited, server-unavailable, cache-busy, unauthorized, forbidden, permanent-http, invalid-context, invalid-cache, filesystem, index-update-failed, or configuration; map all remote messages to these local codes. No token, Authorization, raw remote error, document content or full environment in output. No claim that a cached copy is currently fresh after a failed poll.

## Storage and data contracts

Watch output follows the [watch event schema](schemas/watch-event.schema.json), with the additional UTF-8 byte limit defined above. Existing persisted context and Hub HTTP contracts remain unchanged.

Reuse the existing server/project-keyed XDG cache and context.json schema (revision, manifest, documents). Explicit clones/worktrees keep distinct checkout IDs but share context. Do not relocate or duplicate local .metaproject/wiki or openspec files. No new persisted watch configuration is required.

Use existing authenticated GET /hub/v1/projects/{projectId}/context, with after equal to the cursor committed in the shared cache; missing cache uses the full snapshot path. Apply changed/deleted IDs to the prior documents for delta responses; replace for explicit full snapshots. Preserve digest, version and approval provenance exactly. Validate a safe integer cursor, unique manifest/document IDs and paths, valid required fields/kinds and project membership, document content digests, and consistency between resulting documents and manifest before committing. An unexpected delta without a valid prior cache or a regressing revision is a visible protocol failure, never an empty successful cache. Do not silently reset a corrupt existing cache; preserve it and stop with recovery guidance. Support the server's explicit full-snapshot fallback.

Serialize all cache read/request/validate/replace transactions for the same cache, including one-shot sync and watchers, with a cross-process lock. Acquire before reading the cursor. A competing watcher reports busy and waits the configured interval; a competing one-shot returns a visible busy error without writes. Only the lock owner can release it. Do not steal a lock merely because a timeout expired; an interrupted/killed owner's stale lock requires explicit safe recovery instructions. No new lock may let a late response overwrite newer context. Atomic replacement and owner-only cache permissions remain required; avoid rewriting unchanged context bytes.

Maintain the existing managed index routing block for the invoking checkout, preserving other index text and its initial backup behavior. Avoid rewriting an unchanged block. Cache and checkout index are separate writes: if index maintenance fails, report fatal and the committed cache revision accurately, preserve the original index, and do not claim a fully successful cycle. Do not promise a cross-file transaction.

## Failures and cancellation

Network errors, request timeout, HTTP 408/429/5xx retain last good cache and retry. After consecutive transient failures wait min(interval * 2^n, max(interval, 60)) seconds with n starting at zero; success resets the delay. Lock busy uses the normal interval and does not count as a network failure. HTTP 401/403/other permanent 4xx, malformed context, corrupt local state or filesystem errors stop with nonzero exit and sanitized diagnostics; no silent endless credential retry. Keep request timeout bounded at 30 seconds and support cancellation.

SIGINT/SIGTERM cancel sleep and in-flight requests, prevent a cancelled response from committing, release only owned locks, emit stopped, and exit successfully for requested shutdown. A synchronous atomic rename already completed before cancellation remains a valid committed cache; never delete it as cleanup. No further polling after shutdown.

## Boundaries

No Hub mutation during watch; no import, proposal, approval, code submit/pull, Git HEAD/index/ref change, remote Git push, server execution, auto-start service, browser notification, SSE, or Telegram serve changes. No remote revocation claim for data already downloaded. The current Hub has no document-deletion operation; deletion handling is verified with a contract-compatible HTTP fixture, without claiming a live deletion feature. Retain all existing human-only gates. Release packaging includes the watch command in npm and standalone client builds; no dependency installation into shared root node_modules.

## Acceptance criteria

1. The CLI and standalone client accept sync --watch with a default 15-second interval, validate integer intervals 5..3600 and reject invalid flag combinations before side effects; ordinary one-shot sync remains compatible. [verify: judged]
2. Watch immediately syncs and then requests incremental context using the last committed cursor, correctly applying additions, updates, deletions and explicit full-snapshot fallback while preserving document approval provenance; unchanged context/index are not rewritten. [verify: judged]
3. Two connected clones/worktrees share one cache with distinct checkout IDs; cross-process serialization covers both watch and one-shot sync, prevents stale-response rollback/lost updates/partial JSON, and lock contention and stale-lock recovery are explicit and safe. [verify: judged]
4. Malformed responses, invalid digests/manifests, regressing revisions and corrupt existing cache fail visibly without replacing last good data; index maintenance preserves unrelated content and reports partial cache/index outcomes accurately. [verify: judged]
5. Transient network/408/429/5xx failures retain last good context and report bounded retry state, recover automatically and reset backoff; 401/403/permanent failures stop nonzero without endless requests or secret disclosure. [verify: judged]
6. SIGINT/SIGTERM interrupt polling/wait/request, prevent post-cancellation commits, release only owned locks and stop further requests; code files, Git state, local wiki/spec sources and Hub approval/state remain unchanged. [verify: judged]
7. Real HTTP and real two-process tests cover incremental updates, contention, delayed responses, disconnect/recovery, revocation and shutdown; focused connector/CLI regressions, typecheck, lint, build and compiled-client smoke pass with documented limits. [verify: judged]
8. An immutable review-only Code Revision contains the changes and exact-candidate Evidence, setup/recovery instructions are provided, and the Flow is submitted for owner review without self-acceptance, Git/npm publication or deployment. [verify: judged]
