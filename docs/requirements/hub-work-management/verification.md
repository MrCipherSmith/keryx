# Candidate verification
Version: 0.2.0

Status: PASS for the tested candidate scopes. Owner product acceptance, real-team pilot, live GitHub compatibility and real model execution are not asserted.

## Executed gates

- Backend1783 passed across158files; root/script types, scoped backend lint and source health passed. Subsequent backend source hashes were unchanged during final native UI gate.
- Frontend151 passed across31files in the reload-recovery candidate; types, lint and production Vite build passed. Embedded22assets are regenerated and checked against the final source; the exact input digest is retained in output/work-quality-gate-reload.md.
- Packaging6 passed, including extracted isolated source, frozen offline disposable runtime installation, real HTTP mutation/replay, official SDK MCP, Docker COPY/schema closure and symlink refusal.
- CLI/reference67 passed. Counts overlap other focused diagnostic runs and must not be summed into an inflated total.
- Documentation verifier PASS:13Markdown files,14PRD requirements,16AC,3JSONSchemas,11positive/16negative examples. Generated OpenAPI and closed response/command validation have executable tests.
- Historical native-only gate measured447files unchanged before/after; scope digest f314ee647fa45e4ceb58e076a2f36252145335eafd62d3500e4625e812c8c3bf. Generated frontend bundle is verified separately; committed HEAD changes do not invalidate identical measured source bytes.

Latest reload-delta commands/results are retained in output/work-quality-gate-reload.md and its companion scope/check JSON; output/work-quality-gate-final.md records earlier native/backend scopes. These are actual executions, not planned test names. Standard Bun test preloads remained enabled, isolating user-global configuration. Runtime/frontend installs used existing frozen locks in isolated directories; shared root dependencies were not modified.

## Coverage of judged acceptance criteria

| AC | Candidate evidence | Remaining judgment boundary |
|---|---|---|
|1|Domain/manual/native tests, multi-Intent and retry history|Owner evaluates deliverable semantics|
|2|Exact archive HTTP/CLI/MCP, old-content restart, missing context/start refusal|Actual runtime content consumption remains unverified|
|3|Real HTTP/WebSocket reservation/admission/queue tests plus live native UI single-link trial|Synthetic machine, no real provider execution|
|4|Configured Git/document/report subjects and local fake-provider observations|No live vendor credential/readiness claim|
|5|Exact Evidence coverage, immutable waiver overlays, unwaivable parent refusal|Human assesses test adequacy|
|6|Agent/readonly/cross-project refusals; protected operations absent from MCP|Initial principal model retains existing shared human roles|
|7|Immutable submissions, late contradiction attention and fresh amendment remediation|Historical acceptance is not erased|
|8|Server lost-response/replay/conflict/restart, scoped snapshot/event cursors; browser remount restores original envelope without auto-send; original retry403 retains unknown|Single-process Hub; tab session storage cleared at logout, ordinary drafts remain memory-only|
|9|Real queue/unknown/cancel/terminal protocol fixtures and no replacement allocation|Physical machine/provider pilot remains owner work|
|10|Read-only configured Git/CI refresh, drift/freshness/outage/policy tests|Explicit refresh; no webhook scheduler|
|11|Exact proposal references/no-update rationale, existing wiki proposal review|Product acceptance does not verify wiki truth|
|12|Legacy conversion, old-writer marker3, backup/restore, old-path write refusals|Activation rollback procedure requires operator diligence|
|13|CLI and official SDK MCP against actual isolated Hub, including Linux|Clients must use this candidate build|
|14|Browser lifecycle, advanced review, exact navigation,8theme/locale/width combinations, native composer tests|No blanket WCAG certification|
|15|Body quotas, credential rejection,100refresh/pagination cycles, scoped archives and backups|No long-term production retention/pilot measurement|
|16|Independent backend/UI delta approvals, verified source archive and runbook|Owner alone accepts product work and production cutover|

## Live checks

Manual Flow→Intent→Attempt→Evidence→human selection/Intent acceptance→final Flow acceptance completed via real browser forms against local API. Waiver, whole-set amendment approve/withdraw, legacy conversion, exact document read and Overview deep links passed. Native browser explicitly claimed released control, selected a started Attempt, confirmed pins and existing consent, sent one message, and observed one actual server ExecutionLink. Runtime consumption was labelled unverified.

On geekom Linux a separate loopback source-archive preview installed and started, authenticated requests created a Flow and replayed without duplication, and an agent read it. The official MCP SDK initialized, discovered37managed-work tools and read Flow data. All values/principals were deliberately synthetic; public Hub/Cloudflare configuration and production data were untouched.

Routing: graph attempted/refreshed after source commits; wiki/memory consulted; ctx used; raw rg not used.

Reload regressions separately cover exact original Work/native envelopes after remount, explicit-only retry, lookup404, authority-refused retry after lost response, principal/project/session isolation, malformed/quota-failing storage and logout invalidation. The independent original-retry403 probe was RED before the correction and GREEN afterwards. Earlier pre-fix automated checks alone were not treated as review clearance.
