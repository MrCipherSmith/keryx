# Remote execution security and authority
Version: 0.1.1

Status: planned, normative companion. Protect existing developer work and preserve explicit local opt-in while enabling remote operator control.

## Trust boundaries

The browser is an authenticated human surface, not a trusted source of actor/role/path. Hub authenticates the human and validates scope; machine connection authenticates a separate self-only principal. The local serve treats the authenticated Hub as a coordinator, but still checks local mappings, profiles, policy, budgets, source pins and readiness. Agent output/specification/prompt/logs are untrusted content, never authority to enroll machines, change permissions, select Git or approve work.

Keep human browser, agent MCP, machine, serve bearer and loopback shell-token roles disjoint. Machine-generated events are observations from that machine, not independently trusted evidence of success or a verified human identity. Server-derived human identity in commands is Hub-authenticated attribution, not a cryptographic signature produced by a person on the local machine. Legacy shared human operator credentials remain visibly shared identities.

## Least authority

- An operator may enroll only explicitly selected accessible projects; no wildcard enrollment in MVP. Local execution still requires a separate local mapping.
- Human reviewer has read-only machine/run access here; existing Flow review rights do not confer remote execution control.
- Agent/MCP principals have no new launch/answer/cancel or credential administration rights in this Flow.
- Machine keys cannot use human routes, modify other machines, mint approvals, impersonate agents, or access unrelated projects/runs. Context/spec reads and own-result uploads receive narrow machine gates.
- Local profiles allow only the implemented native adapter and an explicit supported tool set. Remote permission-mode changes, environment/executable arguments, unrestricted URLs/paths, package installation and standing approvals are forbidden.
- Existing hooks, command guards, workspace confinement, secret screening and OS containment remain local. Missing required containment means setup-required/refusal; no silent sandbox downgrade.

## Enrollment and secrets

Pairing is an explicit operator action plus a local action. Use at least128bits random one-time codes,10minute expiry, atomic consume and rate limits. Machine secrets have at least256bits random entropy, digest-only Hub storage, protected local files and scoped revocation. Retain only digests for unused/consumed pairing receipts; never persist/echo raw codes or secrets in browser storage, logs or audit events. Rotation creates a new secret and revokes the old one explicitly; do not silently replace unrelated credentials. No automatic global token export or credential-file scraping.

Connecting publicly may need Cloudflare service credentials distinct from the Hub machine Bearer. Keep them in locally supplied environment references/protected service configuration, not payload/config committed to Git. Test that Access/edge/tunnel permits the exact machine path while browser authentication remains protected; never disable those checks to make WebSockets work. Public machine connectivity is unavailable until this separate deployment setup is complete.

## Open-connection authorization

Authenticate before upgrade. Machine socket must reject human/agent tokens and browser cookie-only requests. Browser socket needs a current session and exact same Origin; machine native headers must not enable browser cross-site control. No URL token fallback. Apply size/schema/direction/epoch/ownership checks to every frame; Cloudflare filtering of the initial upgrade does not replace message validation.

Re-read machine revocation/scope and human session/role at most every20seconds and before privileged dispatch/result/approval actions. Revocation closes applicable sockets, stops new dispatch and pauses local work at its next safe boundary once control loss is observed. It cannot instantly undo a tool already executing or erase downloaded data. Active runs already admitted remain bounded local executions; reattachment after permission change requires the new effective scopes. Human browser logout invalidates that browser connection and future commands, without falsely reporting that local processes were killed.

## Approvals

Use existing approval fingerprints and one-time consumption, not generic web yes/no text. The tuple contains machine/run/checkout/daemon identity, approvalId, call fingerprint, policy digest and deadline. Hub derives answering human; request body cannot set actor or change the tool action. Before local application, the machine-only authorization endpoint rechecks current actor/session/role/scope and returns an exact command/run/action-bound grant with at most5seconds validity. Serve checks the grant binding, server expiry and local monotonic request age before local broker consumption. Grants do not survive reconnect/restart; renewal rechecks authority. A revocation racing an already issued grant can permit application within that bounded five-second window; the specification does not promise instantaneous distributed revocation. Local broker consumes only while waiting for that exact valid call. Deny wins when a question expires or authority is missing. Duplicate answers replay a receipt; conflicting answers conflict. Remote Allow once cannot override a hard local refusal, unsupported local-only interactive confirmation or changed parameters.

UI must show delivery and actual application separately. An approval successfully posted to Hub may still be not applied locally. Never convert a stale allow into approval of the next question. Reconnect/daemon restart do not restore an orphan grant or execute an abandoned action.

## Worktree and process safety

Only explicit exact canonical checkout mappings are executable; reject symlink/path escapes, unrelated clones, active Git operations, dirty/untracked/staged starts and incompatible HEAD. Do not use remote names/labels as paths. Do not stash/reset/pull or auto-create worktrees. Hold an atomic owner-nonce lock in the resolved per-worktree Git administration directory before execution, shared by every Hub enrollment and serve config root using the same canonical checkout; a per-Hub SQLite row is not sufficient. Local ledger lease records are ownership projections. No Hub may steal another Hub's active lease. Detect observable external edits/interference and block automatic result publication; the lease does not lock external editors or arbitrary processes.

Launch identity must be durable before effects. Machine-only reconciliation reports bind local ledger/daemon/run/checkout/native identity and command digest to a stored fresh Hub receipt. These are authenticated observations, not independent proof of OS absence. Human resolution cannot substitute an arbitrary ID for that receipt or unlock locally uncertain work. Crash uncertainty keeps claims/lease; a new transport connection is not permission to rerun. Cancel only through a live owning executor/supervisor generation. TERM then KILL addresses owned process groups, not a reused PID. If child cleanup is uncertain, show unknown with partial effects. Local filesystem writes may remain after successful cancellation and must be visible to the operator.

## Logs, data and limits

Redact operator-facing text and tool summaries before outbox persistence and at ingestion. Never stream hidden reasoning, full environment, provider auth stores, arbitrary file bytes or raw terminal escape sequences to HTML. Render content safely as text/escaped Markdown. Log quota pressure produces explicit gaps; critical control records have durable separate capacity. Configured logs expire after seven days terminal, but unresolved claims/approval records cannot be silently pruned. Enrollment secret storage, audit retention and local cached project data must be included in documented backup/revocation behavior.

## Required negative tests

Cross-machine/project IDs, copied checkout hints, browser Origin attacks, human/agent token on machine routes, machine attempting human actions, pairing brute force/replay, leaked-code reuse, scope downgrade during open socket, stale epoch, changed payload/key, stale approval/run/policy, duplicate start after crash, PID reuse, disconnected cancellation, malicious log HTML/control bytes, oversized/binary/unknown frames, slow readers, quota exhaustion and backup restore with old cursors. No test may label a fake transport, deterministic provider or loopback-only trial as a public real-vendor deployment.
