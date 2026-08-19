# TRD: Wrap-Up Dispatch Outcome Recording

Grounds `prd.md` against the current shape of `src/sac/machine-wrap-up.ts`,
`src/commands/agent.ts`, `src/commands/harness.ts`, `src/sac/catch-up.ts`,
and `src/tui/review-inspector.ts` (re-read 2026-08-19).

## 1. Architecture

### 1.1 Correction to the PRD's framing — the outcome data already exists

The PRD (and the investigation behind it) framed this as "add outcome
computation." Re-reading `machine-wrap-up.ts` shows that's not quite right:
**`runWrapUp` already computes and returns rich per-group outcome data —
the two callers just discard it.**

- `WrapUpGroupOutcome` (`machine-wrap-up.ts:315-333`) is a discriminated
  union: `{outcome:"proposed"; proposalId}` | `{outcome:"conflict"}` |
  `{outcome:"unbound-candidate"}` | `{outcome:"no_credential"}` |
  `{outcome:"error"; message}`. The `"error"` variant is populated by
  `proposeOneGroup`'s own top-level try/catch (`machine-wrap-up.ts:493-503`,
  the "F-002 fix") specifically so a per-group failure becomes a **returned
  value**, never a thrown exception.
- `runWrapUp` (`machine-wrap-up.ts:517-...`) returns `WrapUpOutcome =
  {groups: WrapUpGroupOutcome[]}` (`machine-wrap-up.ts:335`).
- `dispatchWrapUpBestEffort` (`agent.ts:1013-1027`) calls
  `await dispatch({trigger, cwd, dir, slate})` and **never captures the
  return value** — only a *thrown* exception (now rare, by design, since
  F-002 routes most failures through the return value instead) is caught,
  producing a transient `io.onSystem` message with nothing durable.
- `harness.ts:600` (`await runWrapUp({...})`) does the exact same thing —
  returned `WrapUpOutcome` discarded, only a thrown exception logged to
  stderr (`harness.ts:601-610`).

**Consequence for the fix's shape**: this is not "add error handling to
compute failure info" — it's "make `runWrapUp` persist the outcome value it
already computes, instead of letting both callers throw it away." This is a
smaller, more mechanical change than the PRD anticipated, and it fully
satisfies FR-1/FR-2/FR-3 without touching `agent.ts` or `harness.ts` at all
(see §1.2).

### 1.2 Resolved shape: `runWrapUp` persists its own outcome, once, centrally

Rather than modifying both call sites (`agent.ts:1013-1027`,
`harness.ts:595-611`) to capture and persist `runWrapUp`'s return value
separately — duplicating the write logic twice — add ONE new durable-write
step **inside `runWrapUp` itself**, right before it returns, covering both
of its existing return paths (the `nonEmptyKinds.length === 0` no-op early
return at `machine-wrap-up.ts` stays untouched — see §5 Non-Goals: nothing
to record for a harmless no-op with zero seeds). This means:

- `agent.ts:1013-1027` and `harness.ts:595-611` need **zero changes** for
  FR-1/FR-2/FR-3 — they already call `runWrapUp`/`dispatch(...)` at all
  three trigger sites; the new durable write happens inside the function
  they already call, for free.
- The exact call in `dispatchWrapUpBestEffort` is
  `options.dispatchWrapUp ?? runWrapUp` (`agent.ts:1022`) — a test seam.
  The new write must happen inside the REAL `runWrapUp`
  (`machine-wrap-up.ts`), not the test-injectable wrapper, so tests that
  inject a fake `dispatchWrapUp` are unaffected (and continue to not
  exercise the new artifact — acceptable, see §7 Verification).

### 1.3 New artifact: mirrors `writeUnboundCandidateArtifact`'s exact convention

`writeUnboundCandidateArtifact` (`machine-wrap-up.ts:357-378`) is the
existing precedent for a durable, best-effort, session-dir artifact:

```ts
const archiveDir = path.join(dir, "slate-archive");
await mkdir(archiveDir, { recursive: true });
const nowIso = now().toISOString();
const filename = `${nowIso.replace(/[:.]/g, "-")}-unbound-candidate.json`;
const content = { recordType: "unbound-candidate", trigger, generatedAt: nowIso, groups: [...] };
await writeFileAtomic(path.join(archiveDir, filename), `${JSON.stringify(content, null, 2)}\n`);
```

Add a sibling function, same file, same conventions:

```ts
async function writeWrapUpOutcomeArtifact(
  dir: string,
  trigger: WrapUpTrigger,
  now: () => Date,
  groups: WrapUpGroupOutcome[],
): Promise<void> {
  const archiveDir = path.join(dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  const nowIso = now().toISOString();
  const filename = `${nowIso.replace(/[:.]/g, "-")}-wrap-up-outcome.json`;
  const content = { recordType: "wrap-up-outcome", trigger, generatedAt: nowIso, groups };
  try {
    await writeFileAtomic(path.join(archiveDir, filename), `${JSON.stringify(content, null, 2)}\n`);
  } catch {
    // NFR-1: best-effort — a failure to record the outcome must not itself
    // throw and must not prevent runWrapUp from returning its already-
    // computed result to the caller.
  }
}
```

**Correction (implementation review, 2026-08-19):** the sketch above has a
gap — only `writeFileAtomic` is inside the try/catch; the preceding `mkdir`
is not, so an `mkdir` failure would still escape and violate NFR-1/EC-4. The
actual implementation wraps the ENTIRE function body (`mkdir` + filename/
content computation + `writeFileAtomic`) in one top-level try/catch, mirroring
`proposeOneGroup`'s existing whole-body try/catch pattern in this same file.
A regression test (`machine-wrap-up.test.ts`) forces the `mkdir` to fail and
asserts `runWrapUp` still resolves with its correctly-computed `groups`.

Called from `runWrapUp` right before each of its two "real work happened"
return points:
- After `writeUnboundCandidateArtifact` in the `workspaceId === undefined`
  branch (`machine-wrap-up.ts`, the `if (input.slate.workspaceId ===
  undefined)` block) — write an outcome artifact with
  `groups: nonEmptyKinds.map(kind => ({kind, outcome: "unbound-candidate"}))`
  (same shape already being returned).
- After the `Promise.all(nonEmptyKinds.map(kind => proposeOneGroup(...)))`
  resolves — write an outcome artifact with the resulting `groups` array
  directly (it's already exactly `WrapUpGroupOutcome[]`).
- The `nonEmptyKinds.length === 0` early return: no artifact written (see
  §5 Non-Goals — nothing happened, nothing to record, matches PRD's EC-1
  spirit even though that's about "not yet triggered" rather than "triggered
  with zero seeds"; both cases correctly produce **no artifact**, which is
  the "no attempt recorded yet" reading G4 requires).

This satisfies FR-1 (all three trigger sites, for free, since they all funnel
through this one function), FR-2 (trigger/timestamp/outcome/reason — the
`WrapUpGroupOutcome` union already carries a `message` on `"error"`),
FR-3 (written unconditionally, success or failure — `proposeOneGroup`'s
F-002 fix already guarantees `Promise.all` never rejects, so this write
always runs), and NFR-1/NFR-2 (best-effort try/catch around one atomic
local-disk write, no network I/O).

### 1.4 Read side: `classifySession`'s `unknown` branch

`classifySession` (`catch-up.ts:151-186`) already has the exact insertion
point. Current order: lock-held (excluded) → `terminal-state.json` (blocked)
→ newest `unbound-candidate` artifact → `isSlateEngaged` check → `unknown`.

Add a **new read, in the same position as `readNewestUnboundCandidate`**
(`catch-up.ts:171`), for the newest `*-wrap-up-outcome.json` artifact,
mirroring `readNewestUnboundCandidate`'s existing scan-`slate-archive/`-by-
filename-suffix pattern (not shown above but implied by the `-unbound-
candidate.json` suffix convention — TRD assumes/requires the implementer
add `readNewestWrapUpOutcome(dir)` next to `readNewestUnboundCandidate` in
the same file, same lenient-undefined-on-any-read-failure posture as
`safeReadSlate`, per `catch-up.ts:216-224`'s stated module-wide policy).

Insertion point — **after** the unbound-candidate check (that check already
wins if both exist, since an unbound-candidate artifact is itself evidence
of a completed dispatch and already fully informative), **before** the
`isSlateEngaged`/`unknown` fallback:

```ts
const unboundCandidate = await readNewestUnboundCandidate(dir);
if (unboundCandidate !== undefined) { /* unchanged */ }

const wrapUpOutcome = await readNewestWrapUpOutcome(dir);
if (wrapUpOutcome !== undefined && wrapUpOutcome.groups.every(isFailureOutcome)) {
  const workspaceId = (await safeReadSlate(dir))?.workspaceId;
  return {
    kind: "unknown",
    item: {
      type: "unknown", sessionId: session.id,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      lastSeenAt: session.updatedAt,
      wrapUpOutcome: { trigger: wrapUpOutcome.trigger, generatedAt: wrapUpOutcome.generatedAt, groups: wrapUpOutcome.groups },
    },
  };
}

if (!(await isSlateEngaged(dir))) return undefined;
// ...unchanged unknown fallback (no wrapUpOutcome field) below
```

Where `isFailureOutcome(g: WrapUpGroupOutcome): boolean` is
`g.outcome === "error" || g.outcome === "no_credential" || g.outcome ===
"conflict"` — a `"proposed"` or `"unbound-candidate"` group outcome means
the OTHER durable artifacts (a real proposal, or the unbound-candidate file
itself) already exist and already win classification earlier in this same
function, so by the time control reaches this new check, any group that
succeeded has already been accounted for by a HIGHER-priority branch —
`wrapUpOutcome.groups.every(isFailureOutcome)` is a defensive completeness
check, not the primary signal.

### 1.5 `CatchUpUnknownItem` type change (extends, does not replace)

`catch-up.ts`'s `CatchUpUnknownItem` (referenced from
`review-inspector.ts:14`'s import, defined in `catch-up.ts`) gains one new
**optional** field:

```ts
export type CatchUpUnknownItem = {
  type: "unknown";
  sessionId: string;
  workspaceId?: string;
  lastSeenAt: string;
  wrapUpOutcome?: { trigger: WrapUpTrigger; generatedAt: string; groups: WrapUpGroupOutcome[] };
};
```

Optional field, additive — satisfies PRD's choice (FR-4) of "extend the
`unknown` variant" over "new variant," since the existing `unknown` semantics
("nothing else classified this session") remain exactly correct; this just
adds detail for WHY nothing else classified it, when that detail is known.

### 1.6 Review UI render change

`describeReviewItem`'s `"unknown"` case (`review-inspector.ts:106-113`)
branches on the new optional field:

```ts
case "unknown":
  return item.wrapUpOutcome !== undefined
    ? [
        `Session    ${item.sessionId}${item.workspaceId !== undefined ? `  (workspace ${item.workspaceId})` : ""}`,
        `Last seen  ${item.lastSeenAt}`,
        `Wrap-up dispatch (${item.wrapUpOutcome.trigger}, ${item.wrapUpOutcome.generatedAt}) did not produce a proposal or unbound-candidate:`,
        ...item.wrapUpOutcome.groups.map((g) => `  ${g.kind}: ${describeGroupOutcome(g)}`),
        "",
        `Investigate: keryx sessions list / keryx shell -r ${item.sessionId}`,
      ]
    : [
        `Session    ${item.sessionId}${item.workspaceId !== undefined ? `  (workspace ${item.workspaceId})` : ""}`,
        `Last seen  ${item.lastSeenAt}`,
        "No proposal, terminal state, or unbound-candidate artifact recorded.",
        "",
        `Investigate: keryx sessions list / keryx shell -r ${item.sessionId}`,
      ];
```

`describeGroupOutcome(g: WrapUpGroupOutcome): string` — a small new local
helper — renders `"error"` as its `message`, `"no_credential"` as "no model
credential available", `"conflict"` as "a concurrent proposal already
claimed this slot". This satisfies FR-4/FR-5 exactly: when
`wrapUpOutcome` is present, the detail shows real diagnostic info; when
absent (the overwhelmingly common case per PRD's EC-1), the message is
byte-for-byte what it is today.

`formatReviewListLines`/`summarizeReviewItem` (`review-inspector.ts:57-67`)
are **not** changed — the list-row summary for `unknown` stays
`"<sessionId> — last seen <lastSeenAt>"` regardless of whether
`wrapUpOutcome` is present; only the detail view changes. (TRD judgment
call: keeping the list terse and pushing detail to the detail tab matches
this file's own stated design — "Mirrors flow-inspector.ts's list+detail
interaction model" — no PRD requirement forces a list-row change.)

## 2. Tech Stack

No new dependencies. Reuses `writeFileAtomic` (`../lib/fs`, already
imported in `machine-wrap-up.ts`), `mkdir`/`path` (already imported), and
the existing `slate-archive/` directory convention.

## 3. Data Models

- New (internal, not exported beyond the module boundary needed):
  `writeWrapUpOutcomeArtifact` writes `{recordType: "wrap-up-outcome",
  trigger, generatedAt, groups}` — same shape family as the existing
  `{recordType: "unbound-candidate", ...}` artifact.
- `CatchUpUnknownItem` gains one optional field, `wrapUpOutcome` (§1.5).
  `WrapUpGroupOutcome`/`WrapUpTrigger` (already-exported types from
  `machine-wrap-up.ts`) are reused as-is inside it — no new outcome enum.

## 4. API / Interaction Contracts

No public CLI/API surface changes. `runWrapUp`'s exported signature and
return type (`Promise<WrapUpOutcome>`) are unchanged — the new write is a
side effect, not a contract change. `catchUpItems`/`buildCatchUp`'s exported
signatures are unchanged; `CatchUpUnknownItem`'s new field is additive
(structurally compatible with any existing caller that doesn't know about
it).

## 5. Non-Functional Requirements

- Matches PRD NFR-1..NFR-4. NFR-4 (no secret leakage in the failure reason)
  is satisfied as-is: `WrapUpGroupOutcome`'s `"error"` `message` field is
  already `error instanceof Error ? error.message : String(error)`
  (`machine-wrap-up.ts:501`) — the SAME string already shown transiently via
  `io.onSystem`/`console.error` today (`agent.ts:1025`, `harness.ts:610`).
  Persisting it durably is no NEW exposure surface versus what's already
  printed to the transcript/stderr today; no additional sanitization is
  introduced or required beyond what already exists.
- NFR-2 (cheap, no network I/O at `process-termination`): the new write is
  one `mkdir` + one `writeFileAtomic` call to the same `slate-archive/`
  directory `writeUnboundCandidateArtifact` already writes to at that exact
  trigger site today — no new I/O class introduced.

## 6. Non-Goals confirmation

- `nonEmptyKinds.length === 0` early return: confirmed no artifact write
  needed — matches PRD's "no false failure" spirit; a session with zero
  seeds triggering wrap-up is a harmless no-op today and stays one.
- No change to `agent.ts`/`harness.ts` — confirmed not needed (§1.2).
- No change to `classifySession`'s existing `blocked`/`unbound-candidate`
  priority — confirmed unchanged; the new check is strictly additive and
  placed after both existing checks (§1.4).
- EC-3 (a later `terminal-state.json` appears after a recorded failure):
  confirmed `classifySession`'s existing ordering already handles this
  correctly with ZERO new logic — `terminal-state.json` is checked FIRST
  (`catch-up.ts:161-169`), before the new `wrapUpOutcome` check, so a
  session that later produces a `blocked` classification always wins over a
  stale failure record, automatically, by the existing priority order. FR-6
  is satisfied for free; no additional reconciliation logic needed.

## 7. Verification

- **How to test**: unit tests for `writeWrapUpOutcomeArtifact` (via
  `runWrapUp`'s existing test seams — `now`/injected `providerFactory` to
  force `"error"`/`"no_credential"`/`"proposed"` outcomes deterministically,
  matching `machine-wrap-up.test.ts`'s existing patterns) asserting the
  artifact's exact file location/content. Unit tests for
  `readNewestWrapUpOutcome`/`classifySession`'s new branch (outcome present
  + all-failure → `unknown` with `wrapUpOutcome` populated; outcome present
  + a success group → falls through, unaffected since a real
  proposal/unbound-candidate artifact already exists and wins earlier).
  Render tests for `describeReviewItem`'s two `"unknown"` branches.
- **Where to test**: `src/sac/machine-wrap-up.test.ts` (new artifact write),
  `src/sac/catch-up.test.ts` (new read + classification branch),
  `src/tui/review-inspector.test.ts` (render branches) — all three files
  already exist per the established test-per-module convention in this
  codebase.
- **Observability checks**: none new — the artifact itself is the
  observability mechanism (PRD §11, unchanged).
