# Implementation Plan

Status: frozen with ACs (flow-orchestrator, 2026-09-24)

## Approach

New core module `src/learning/` (register it in `src/lib/import-zones.ts`),
one CLI module `src/commands/learn.ts` (route `learn` in `CLI_ROUTES`), plus
small extensions to existing modules: the shell hook runtime wiring
(`src/commands/agent-hooks.ts`), the W5 registry (one opt-in Claude observe
surface), `src/gdskills/learn.ts` (export helpers only — `LearningProposal`
shape and `applyLearningProposal` unchanged), `src/review/review-learning.ts`
(optional `reviewerProfiles`), `src/commands/review.ts` (`learn --reviewer`),
W1 scout record (optional learned origin), the ignore block, and the D-3 rule
amendment. Everything is deterministic; no network, no model call.

## Module layout (src/learning/)

| File | Owns |
|---|---|
| `types.ts` | `LearnedPattern`, `ObservationEvent` (JSONL line), `LearningDomain`, `EvidenceItem`, status/scope unions, `ProjectIdentity` |
| `learned-pattern.schema.json` | byte-identical runtime copy of `docs/requirements/keryx-agent-platform-expansion/schemas/learned-pattern.schema.json` |
| `schema.ts` | `validateLearnedPattern(value) → {ok, errors[]}` hand-written validator covering every schema rule (no ajv in repo) |
| `confidence.ts` | `SEED_DETERMINISTIC=0.4`, `SEED_MODEL=0.3`, `REINFORCE_RATE=0.35`, `CONTRADICT_RATE=0.5`, `DECAY_RATE=0.02`, `MAX_WEIGHT=1.5`; `applyEvidence(conf, kind, weight)`, `applyDecay(conf, days)`, `confidenceLevelFor(conf)` |
| `identity.ts` | `normalizeRemoteUrl(url)`, `resolveProjectIdentity(root, deps?) → {identity, identityKind, displayName?}` (first of `origin`, else first remote; fallback sha256 of realpath root) |
| `paths.ts` | `learningDataDir(root)`, `observationsDir`, `candidatesDir`, `decisionsLogPath`, `graduationDir`, `userLearningDir(env, home?)` = `<resolveHookHomeDir>/.keryx/learning`, `userPatternsDir`, `userIndexPath`; every writer asserts `isPathInside` |
| `scan.ts` | `scanLearnedText(root, texts[]) → {findings: category[]}` via security `analyze(..., source "untrusted-external")` plus a local imperative-injection detector ("ignore previous instructions", "you must now", "system prompt", role tags …); used before any persistence and again before apply/graduate/review-learn writes |
| `store.ts` | read/list/write project records `.metaproject/data/learning/candidates/<id>.json` and user records `~/.keryx/learning/patterns/<id>.json`; `withFileLock` (`.metaproject/data/learning/learn.lock`, `~/.keryx/learning/learn.lock`); validates before write; **`writePattern` refuses `status: "accepted"` unless handed the unexported accept capability from `accept.ts`** |
| `decisions.ts` | append-only `.metaproject/data/learning/decisions.jsonl` (and `~/.keryx/learning/decisions.jsonl` for user scope): `{schemaVersion:1, action:"accept"|"reject"|"refresh"|"promote"|"graduate-apply", id, scope, actor, tty:true, at}`; `auditAcceptedRecords(root, env)` → accepted records lacking a matching accept decision |
| `observe.ts` | `createLearningObservationSink(root, deps?)` implementing W6 `LearningObservationSink`; `mapHookEventToObservation` (C-14 table); `buildObservationLine`; bounded append (200-char previews, 5000 lines/day, overflow rolls to next UTC day file, then drops), redaction through `analyze` (finding → `"[redacted:<category>]"`), `inputDigest` sha256, `cwdHash` sha256, optional hash-only `edit {pathDigest, removedDigest, addedDigest}`; `observeHostHookPayload(root, runtime, stdinJson)` for host harness hooks. Never throws into the hook runtime. Disabled by `KERYX_LEARNING=off` |
| `extract.ts` + `signals/*.ts` | `runExtract(root, {since?, domain?, now?, modelExtractor?})`; signals `repeated-correction`, `reverted-edit`, `failing-to-passing-test` (weight 1.5), `reviewer-comment`, `health-regression`; candidate upsert with deterministic id (`<domain>.<slug>-<sha8>`), seed 0.4, evidence dedup by `sourceRef`, reinforcement formula, decay pass, 30-day candidate TTL; scan-refused candidates counted, never stored; model extractor is a port refused unless the `learning.modelExtractor` capability is enabled in config (no implementation shipped) |
| `accept.ts` | `acceptPattern(root, id, {scope, refresh?, actor, isTerminal})`, `rejectPattern(...)`; the only code that produces `status: "accepted"`; TTY required for accept; project-scope accept writes one index entry `{projectIdentity, identityKind, confidence, acceptedAt}` under `id` in `~/.keryx/learning/index.json`; `--refresh` overwrites only the current identity's entry |
| `promote.ts` | `promotePattern(root, id, {isTerminal, confirm})`: non-TTY refusal (`promote-requires-terminal`), `<2` identities at indexed ≥0.8 refusal (`insufficient-project-identities`), typed confirmation, writes user-scope candidate (new ttl) |
| `apply.ts` | `learnedPatternToProposal(record, skill)` (pure, carries `confidenceLevel`), `applyLearnedPattern(root, id, {skill, dryRun})` → writes proposal under `.metaproject/data/gdskills/proposals/` then calls `applyLearningProposal` |
| `reviewer-profile.ts` | `reviewerIdFor(identity, login)` (`rv-` + 16 hex), `generalizeLesson(text, logins)`, `renderReviewerProfile`, `applyReviewerProfile(root, reviewerId, {dryRun})` → `.metaproject/rules/reviewers/<id>.mdc` (semver header, changelog block, `reviewers.lock`, `isPathInside`, refuses output containing any configured login) |
| `graduate.ts` | `runGraduate(root, {domain?})` clustering (Jaccard ≥0.5, ≥2 shared keywords; skill ≥2 records; workflow ≥0.7 → rule; agent ≥3 avg ≥0.75) → `.metaproject/data/learning/graduation/<proposal-id>.json` + sets `graduation`; `applyGraduation(root, proposalId, {isTerminal})` writes agent candidate `.metaproject/agents/<name>.md` (origin.kind learned, sourceRef = pattern id, validated) — agent target only; skill target prints W1 `skills scout --record … --origin learned --source-ref <id>` |
| `prune.ts` | delete observation files >30 days by filename date; expire candidates past `ttl.expiresAt` (status `expired`, ttl removed) |
| `index.ts` | facade |

## CLI

`keryx learn observe [--hook claude]`, `extract [--domain] [--since]`,
`list [--status] [--domain] [--scope] [--json]`, `review [<id>]`,
`accept <id> [--scope user] [--refresh]`, `reject <id> [--scope user]`,
`apply <id> --skill <module/name> [--dry-run]`, `promote <id>`,
`graduate [--domain] | graduate apply <proposal-id>`, `prune [--dry-run]`;
`keryx review learn --reviewer <id> [--dry-run]`;
`keryx skills scout … --record <dir> --origin learned --source-ref <id>`.
None of accept/promote/graduate apply is agent-invocable (not exposed via MCP).

## Decisions

- D1 all project records (every status) live in `candidates/<id>.json` — the
  record's own store; `candidates/` is gitignored per W3-AC9.
- D2 accept and promote both require a TTY (spec requires it for promote;
  "accept never runs unattended" is enforced the same way). No bypass flag.
  Tests inject `isTerminal`.
- D3 the observation line gets one optional hash-only field `edit` (documented
  in W3 doc as a v0.1.4 amendment) so reverted-edit / repeated-correction are
  detectable without storing content. Previews stay 200 chars.
- D4 candidate TTL 30 days (both scopes); decay counted in whole UTC days since
  `updatedAt`.
- D5 host observer: Claude Code only, opt-in surface (`keryx integrations
  install --runtime claude --surface observe`), command
  `keryx learn observe --hook claude`, always exit 0, no stdout decision.
- D6 injection-shaped learned text is refused outright (never stored); a
  refusal is reported as a category count only.

## Steps (tasks)

T5 core → (T6 observe, T7 extract) → T8 consent CLI → (T9 apply+reviewer
profiles, T10 promote+graduate, T11 host observer, T12 D-3 + docs) → T13 exit
guard test → T14 e2e CLI verification → T15 Observe-vs-SAC deep review → T4 PR.

## Risks

- Transcript creep (SAC non-goal): mitigated by preview bound, digests, hash-only
  edit field, and a dedicated opus review task (T15).
- Doc/CLI drift tests (help groups, reference coverage, matrix) — each CLI task
  updates the docs it triggers.
- Parallel flows 311/313: do not touch `src/gdskills/bundled/agents/**` or
  `~/.keryx` paths other than `learning/`.
