# Specification: Keryx Desktop App
Version: 0.2.0

Status: draft; decisions D1–D5 taken by the operator (section 9). Quick start (section 6, "Quick start request", criteria 3–6) is implemented by flow 492 and its acceptance criteria are frozen in that flow; the remaining criteria below are not frozen. Everything else below is `planned` unless a source path is cited as existing.

## 1. Module identity

- Name: `keryx-desktop-app`.
- Kind: module package, spanning a shell (new), Hub backend additions (`src/hub`, `src/hub/work`), web views (`apps/hub-web`) and TUI items (`src/tui`).
- Principle: the shell is thin. Capabilities are Hub and web features first.

## 2. Baseline (checked 2026-11-14, source at HEAD ed3cd4372)

| Fact | Evidence |
|---|---|
| Hub web has eleven tabs and token login | live walk, `apps/hub-web/src/app/navigation.ts` |
| Production web assets are embedded and freshness-checked | `src/hub/web-assets.generated.ts`, `bun scripts/build-hub-web.ts --check` |
| Hub work module exists: attempts, requirements, reviews, integrations, git observer, execution binding | `src/hub/work/*` (listing) |
| Hub references loopback in server, connector, remote-v2, mcp-bridge, work client and git observer | files returned by a loopback search under `src/hub` |
| No screenshot or visual-stage handling exists in `src/hub` or `src/lib/hub-machine` | empty search result for `screenshot\|visual` |
| The Work tab reported the new model unavailable on the fixture server | live walk |
| Not observed: real runs, real diffs, real Work data, pairing code creation | live walk gaps |

Consequence: R13 (visual QA) needs a new artifact kind and a new stage. R9 and R12 need a check of which stage and finding data the current work module already stores before any new endpoint is designed (Phase 0 below).

## 3. Structure (planned)

```text
src/desktop/                 shell-side code that is not UI: hub-supervisor, solo secret, update check
src/hub/solo-auth.ts         solo login route and loopback guard
src/hub/work/quick-modes.ts  mode table (exists)
src/hub/work/clarify.ts      clarifying-question storage (exists)
src/hub/work/quick-start.ts  quick start request parser and route body (exists)
src/hub/work/quick-start-limits.ts  size limits shared by the Hub, web and TUI (exists)
src/hub/work/stage-timeline.ts
src/hub/work/diff-view.ts
src/hub/work/finding-anchor.ts
src/hub/work/visual-artifacts.ts
apps/hub-web/src/...         QuickStart, StageTimeline, DiffView, FindingList, VisualQa views
src/tui/...                  TUI modal, sidebar section, commands (R14, R15)
apps/desktop/                shell project (Tauri or Electron, decision D1); separate from the npm package
```

## 4. Config

`~/.keryx/desktop.json` (planned):

```json
{
  "version": 1,
  "mode": "solo",
  "hub": { "bind": "127.0.0.1", "port": "auto" },
  "notifications": { "events": ["decision", "question", "review-ready"], "suppressWhenFocused": true },
  "update": { "channel": "stable", "applyWhileRunning": false }
}
```

`mode: "team"` points the window at a remote Hub origin and uses its normal login. `mode: "solo"` is the only mode in which the solo login route exists.

## 5. CLI and UI surface

| Surface | Item |
|---|---|
| CLI | `keryx hub solo` starts a solo Hub without the shell, for browser use (D3: no `keryx desktop` command) |
| Web | New task dialog; run page with stage timeline; diff view; finding list; visual QA panel |
| TUI | `/task` command and menu item (quick start modal); sidebar section "Stages"; modal "Stage log"; modal "Findings"; status line "Hub: local" |
| Desktop | window, tray, notifications, update prompt |

### TUI parity table (R14, R15, R16)

| Capability | Web | TUI |
|---|---|---|
| Quick start, modes, clarifying form | New task dialog | `/task` modal, keyboard only |
| Timeline | Run page | Sidebar "Stages", live without refresh |
| Stage log | Stage detail | Modal "Stage log" |
| Findings with file and line | Beside diff | Modal "Findings" |
| Diff | Diff view | Existing review surface |
| Visual QA | Panel | List with artifact path (a terminal cannot show the image; stated, not hidden) |
| Solo status | Tray, window title | Status line |

## 6. Data contracts (reconciled with the code by the Phase 0 evidence pass, flow 492)

Evidence, with references taken on 2026-11-14:

- The work module stores **no stage and no finding**. It has `Attempt.state` (draft, running, blocked, submitted, failed, cancelled, accepted, changes-requested, rejected, withdrawn), `executionOutcome` (none, active, known-terminal, unknown), `attempt.report` events (progress, blocked, failed, cancel-request, cancel-confirmed) and `EvidenceRecord` (`criterionIds`, `result`, `source`, `method`, `sourceRunId`). `WorkEvent.type` is a closed enum (`src/hub/work/model.ts`, `domain.ts`).
- The stage record below is therefore a **derived projection, new**: it is computed from attempt and evidence events, not stored.
- Findings live in the review-orchestrator log and the review round, not in the work module. The finding anchor below is a **derived projection, new**, read from that log.
- The only mutation surface is `WorkCommand` (`src/hub/work/model.ts:31`): `{operationId, expectedVersions, command, payload}`. `operationId` is the idempotency key (200 characters at most, per project and actor); the same id with a different request digest gives 409 `idempotency-conflict` (`src/hub/work/http.ts:234`). Quick start composes `flow.create` (its `specification` may be null), `intent.create` and `flow.approve-and-start`. Criteria are frozen by the human-only `requirements.approve` or `flow.approve-and-start` (`domain.ts:76`, `model.ts:20-30`).
- A specification is a `DocumentRef` (`documentId`, `version`, `contentDigest`). Documents enter a project through the machine connector's `importDocuments` (`src/hub/connector.ts:186`, driven by `src/hub/client-command.ts:93`) and the project event `documents-imported` (`src/hub/domain.ts:178`). Quick start does not import: it creates the Flow with `specification: null`.
- The `flow.create` payload fields are `title, problem, expectedOutcome, scope, outOfScope, ownerId, specification, criteria[{criterionId, text, waivable}]`.

**Stage record** (derived from run events):

```json
{ "runId": "…", "stage": "plan|implement|checks|review|visual|accept",
  "state": "waiting|running|passed|failed|skipped",
  "agent": "…", "startedAt": "ISO", "endedAt": "ISO|null", "logRef": "…" }
```

**Finding anchor**:

```json
{ "findingId": "…", "file": "…", "line": 0, "severity": "…", "summary": "…",
  "verdict": "CONFIRMED|PLAUSIBLE", "inDiff": true }
```

**Visual artifact**: `{ "runId", "stage": "visual", "kind": "screenshot", "role": "before|after", "ref", "capturedAt" }`.

**Quick start request**: `{ "mode": "quick|bug|task|epic|refactor", "description": "…", "answers": [{"q","a"|null,"skipped":bool}], "criteria": ["…"] }`. The server composes `flow.create` (with `specification: null`; the description and answers go into the problem text, every skipped question recorded as `Skipped`), `intent.create` and `flow.approve-and-start`, freezing `criteria` in one idempotent action keyed by the `Idempotency-Key` header (the operation id), following the existing mutation-queue rule. The route is `POST /hub/work/v1/projects/:p/quick-start`.

JSON schemas for these contracts are not written yet. They are added under `schemas/` once Phase 0 settles field names, and the specification then links them.

## 7. Integration points

- Hub server and `remote-v2` for sessions, runs and commands: unchanged contracts. New endpoints are additive.
- `src/hub/work` for Flow, Attempt, Evidence: quick start writes through its public handlers, not around them.
- Review orchestrator log and review findings: the source of R12. Format read from the existing log, not redefined.
- Sandbox credential masking: reused for stage logs (R10).
- Ticket intake: quick start must not duplicate it. Intake creates from external tickets, quick start from typed text.
- `keryx-native-distribution`: the desktop artifact ships separately; the npm global install stays as it is.

## 8. Phases

0. **Evidence pass** (before any code): list what the work module already stores for stages and findings, what the web already renders, and which endpoints are missing. Output replaces section 6 field names with real ones. Exit: a short report in this package.
1. **Web: quick start** (R6–R8) and **TUI quick start** (R14).
2. **Web: timeline, log, diff, findings** (R9–R12) and **TUI timeline and findings** (R15). Visual QA (R13) is last in this phase because it needs a new stage.
3. **Solo mode** (R1, R2) with its security review.
4. **Shell** (R3–R5), distribution (D2).
5. Parity test (R16) runs from phase 1 on and gates every phase.

Each phase is shippable alone and is a separate Flow if the operator approves.

## 9. Decisions

Decided by the operator in Telegram message 262443 (2026-11-14), verbatim: «1-Tauri 2 гитхаб 3-отдельное приложение плюс keryx hub solo 4 согласен 5 по рекомендации». The "Recorded as" column is my reading of that line against the options sent; a wrong reading is corrected by the operator, not by me.

| # | Decision | Recorded as | Consequence |
|---|---|---|---|
| D1 | Shell | Tauri | No native Node code inside the shell: the Hub is a separate child process. Rust toolchain enters CI for the desktop artifact only. System webview differences across Linux, macOS and Windows need a smoke check per platform. |
| D2 | Distribution | GitHub releases, signed artifacts, no store listings in v1 | Update channel (R5) reads GitHub releases. |
| D3 | CLI entry | Separate app plus `keryx hub solo` for browser use | No `keryx desktop` command in the CLI. The CLI table in section 5 drops it. |
| D4 | Order | Web first (phases 1 and 2), solo (3), shell (4) | As in section 8. |
| D5 | Clarifying form | Template-based in v1; model-generated later | R8 becomes testable in v1: questions come from the mode template, so its verification can be `exec` instead of `judged`. Model-generated questions are future work and a separate requirement. |

## 10. Acceptance criteria (drafts, not frozen; one per line, none bound yet)

1. `keryx hub solo` starts a loopback-only Hub; a request from a non-loopback peer to the solo login route returns 403. (R2)
2. The solo Hub child exits within five seconds of the shell quitting, and no process remains. (R1)
3. Quick start of a one-line bug creates a Flow without a spec document, and frozen criteria, in one action. (R7)
4. Replaying the same quick-start mutation with the same idempotency key creates no second Flow. (R7)
5. Each of the five modes sets its default review depth and criteria template from the mode table. (R6)
6. Skipping the clarifying form is recorded in the Flow's problem text: every skipped question under its own name, and one skip line when the whole form was skipped. (R8)
7. A run page shows the six stages, with states derived only from stored events. (R9)
8. A stage log shows a seeded credential masked. (R10)
9. The diff view lists changed files and lines for a run's working copy against its base. (R11)
10. A finding whose line is outside the diff appears in the "outside the diff" group. (R12)
11. A run with a UI change stores before and after screenshots and shows them; a run without a visual stage says why. (R13)
12. A decision-needed event raises one OS notification, not when the window is focused on that run; clicking opens the run. (R4)
13. The tray reflects idle, working and needs-you. (R5)
14. An update is installed only after signature verification and not during an active run without confirmation. (R5)
15. The TUI has `/task`, a "Stages" sidebar section, a "Stage log" modal and a "Findings" modal, all keyboard-operable and updating in the background. (R14, R15)
16. The parity test fails when a stage or finding field exists on one surface only. (R16)
17. `bun scripts/build-hub-web.ts --check` passes. (R3)
18. `npm i -g keryx` ships no desktop binary. (release criterion 6)

Origin lines for a future Flow (to be filled only after operator confirmation): «Запрос (дословно)» — "Делай", reply to the offer "подготовлю PRD с критериями приёмки по этим четырём направлениям, и по вашему правилу в нём будут и пункты для TUI" (Telegram messages 262337, 262357, 262387, 262409); «Эффект»; «Как наблюдать».
