# Hub work management: candidate handoff

Historical milestone record: the counts below describe their named pre-review test scopes, not the current PR head. Current validation and per-finding outcomes are recorded in [PR1113 correction results](../../.metaproject/flows/480-2026-11-01-implement-collaborative-hub-work-metadat/review-fixes/report.md).
Version: 0.2.0

Status: integrated candidate verified, including native UI delta. No owner product acceptance or public production upgrade is claimed.

## Source and integration

Backend/integrated branch: feat-hub-work-management. Worktree: /path/to/backend-worktree/keryx. Base main 0.4.1: 3dd6ac53f159c65a522f1db7e755268174bb1217. UI lane: feat-hub-workspace-design in /path/to/ui-worktree/keryx. Patches were checked/applied into the backend branch; old dirty prototype worktree was preserved. Branches are local until explicitly published.

Implementation commits include 11a776df1 (contracts/adapters),239ba7229 (durable domain/native integration),c82fe19e4 (core UI),466980d0a (distribution),c2109a7aa (membership/snapshot corrections),d01d5328a (advanced review/Overview) and dec5ecce4 (native UI). Final reload recovery and handoff evidence are recorded in subsequent commits on the same branch.

## Delivered behavior

Flow → bounded required/optional Intent → parallel/retried Attempt → exact context/result/Evidence → human selection and acceptance. Code stays Git/GitHub. New managed data is additive and legacy work is preserved; explicit eligible conversion creates draft requirements and protects the old Flow from writes. Every human decision targets exact immutable digests and current versions. Amended requirements require a complete replacement set and fresh work/review; accepted history is retained.

Pending Work/native requests survive a same-tab reload with their original immutable request ID/body/headers. Recovery is explicit; no automatic protected decisions. An authority refusal on a later retry cannot erase an earlier unknown result. Bounded session storage is isolated by principal/project/session and cleared on logout; credentials/cookies and ordinary drafts are excluded.

The React UI preserves the existing machine/session cockpit, both themes and RU/EN. It exposes manual/Git/document/report work, exact requirement review, criteria and mappings, Evidence, human waiver overlays, amendments, attention and context. Overview uses authorized per-project requests with explicit bounded fanout. Work events update canonical queries. No failed live request is disguised as a demo success.

Existing native messages can carry paired managed-work headers; original controller, consent, authority and allocation checks remain. Context consumption is unverified unless independently observed. CLI and read/contributor MCP use the same application boundary and never expose protected human operations as agent tools. Exact archived document content is fetchable without latest fallback. Git/CI metadata refresh is read-only and never auto-accepts work.

## Historical validation at the reload-recovery milestone

- Backend 1783 tests passed across 158 files; source health, types and lint passed.
- Frontend 151 tests passed across 31 files; types, lint, build and embedded asset freshness passed.
- Packaging6 tests passed, including isolated archive extraction, frozen offline dependency install, actual HTTP mutation/replay and official-SDK MCP calls. Docker source/schema inclusion checked.
- Backend independent initial findings were reproduced and corrected; round3 and subsequent membership/snapshot delta reports APPROVE. UI initial two majors were reproduced/corrected; second increment APPROVE.
- Browser core lifecycle ran against the actual API, including human requirement approvals, Attempt, Evidence, selection, Intent and final Flow acceptance. Additional live waiver, amendment approve/withdraw, legacy conversion, exact archive reads and Overview links passed. Desktop375/1280, RU/EN and both themes were inspected without document overflow.
- Separate operator@hub-host Linux source-archive runtime passed install/start/authenticated Flow create+durable replay+agent read. Official SDK initialized and discovered 37 managed-work tools and read the test Flow. No production credentials or live GitHub/provider execution were used.

Raw gate/review evidence is retained under output/work-quality-gate-final.md, output/work-independent-review-round3.md, output/work-independent-review-final-delta.md and output/work-ui-independent-review-round2.md. Native UI review is recorded in output/work-ui-independent-review-native.md. The later reload-recovery review/gate are output/work-ui-independent-review-reload.md and output/work-quality-gate-reload.md; they supersede earlier frontend counts and asset digests. Backend source bytes match the1783-test pass.

## Access and operation

See hub-work-management-runbook.md for configuration, trial launcher and safe activation/rollback. On operator@hub-host the private synthetic preview source is /path/to/isolated-preview/team-hub-prototype, loopback port19879. A laptop tunnel currently exposes it at http://localhost:18794. To recreate that tunnel:

```sh
ssh -N -L 18794:127.0.0.1:19879 operator@hub-host
```

The fixture launcher scripts/smoke/team-hub-work.ts contains deliberately public dummy login values; use only for the disposable loopback preview. The production Hub and its Cloudflare Access configuration were not modified. The candidate source archive and SHA256SUMS are under artifacts/team-hub-work-management on the laptop; verify the generated SHA256SUMS file for the final archive bytes.

## Boundaries and next operator decision

Single-process SQLite; explicit configured Git refresh, no background webhook scheduler; no automatic machine-result→trusted Evidence promotion; runtime content consumption remains unverified; conservative unknown/known-refusal recovery retains original allocations. Synthetic WebSocket machines prove protocol behavior, not execution by a real model or physical multi-machine rollout. Production cutover/real-team pilot and product acceptance remain explicit owner work. Local Task Manager Flow480 remains in-progress for verified handoff rather than being self-accepted/merged by the implementation agent.

Routing: graph used/refreshed after source commits; wiki and memory consulted; ctx used for source/logs; raw rg not used.
