# T43 — spec: a shape-aware JSON reader, and the gate-relevant readers that move to it

Ruling implemented: `T39-review.md` §"Judgement calls" #4. Not re-decided here.
`readJsonFileOr` is not touched; a sibling is added; only readers whose payload
feeds a gate, an exit code or a security decision migrate.

## 1. The sibling

`src/lib/json.ts` gains one exported type and one exported function.

```ts
export type JsonObjectRead =
  | { state: "object"; value: Record<string, unknown> }
  | { state: "non-object"; value: unknown }
  | { state: "unreadable" };

export function readJsonObjectFile(filePath: string): Promise<JsonObjectRead>;
```

Three states, because the callers need three answers:

- `object` — the file was read and parsed and the payload IS a plain object.
  `value` is `Record<string, unknown>`: exactly the fact that was verified, and
  nothing more. There is no type parameter, so the signature cannot promise a
  shape it did not check — that is the half of `readJsonFileOr<T>` this exists
  to avoid, since `readJsonFileOr<HealthReport>` returns whatever parsed while
  the type says `HealthReport`.
- `non-object` — the file parsed, to `null` / an array / a number / a string /
  a boolean. The payload is carried on `value` so a caller that legitimately
  wants it can have it; no caller migrated here does.
- `unreadable` — the file could not be read or did not parse. Absent files land
  here too: every migrated caller already asks `pathExists` first, and a reader
  that does not stat cannot honestly distinguish "absent" from "unreadable"
  without a second syscall.

Name: `readJsonObjectFile`, not `readJsonObject` — `src/harness/external/codec/codex-cli.ts:322`
already has a module-local `readJsonObject(line: string)` that parses one NDJSON
line, and two different things with one name in one repository is how a reader
picks the wrong one.

`readJsonFileOr` keeps its signature, its semantics and its 30 callers.

## 2. Migration criterion

A reader migrates iff its payload can change one of:

1. a security or health **gate** status,
2. a process **exit code**, or
3. a **persisted security decision** (state a later decision is made against).

— i.e. iff an unparseable or non-object payload could make a check read as
*clean*, *passed* or *disabled* when in fact it was never established. That is
the phrasing of the ruling and of `policies.md` §"Health и security gate":
a required check that is missing, unparsed or unfinished is INCOMPLETE, never
PASS.

Everything else stays: configuration merges whose defaults ARE the intended
answer for a broken file, and readers whose payload is legitimately non-object.
A changed contract is not opt-in; a new function is.

## 3. Sites that migrate (owned set only)

| Site | Feeds | Change |
|---|---|---|
| `src/security/config.ts:265` `loadSecurityConfig` | the whole security posture (gate + guard) | drop the `CONFIG_UNREADABLE` Symbol and `isMergeableConfigPayload`; `state !== "object"` is the forced-closed branch. Behaviour identical. |
| `src/security/guard.ts:183` `resolveManifestSecurityState` | `securityFlowGate`, `guardOutput` | drop the `MANIFEST_UNREADABLE` Symbol; `state !== "object"` is `manifestUnreadable: true`. Behaviour identical. |
| `src/health/service.ts:67,77` `readLatest` | `health gate` status and exit code | replace both bare `JSON.parse(... ) as HealthReport` casts. Behaviour identical; the `null` case stops depending on a `TypeError` being thrown and caught. |
| `src/commands/security.ts:370` `scan-mcp --pin` | the pinned rug-pull baseline (a persisted security decision) | an unreadable manifest is refused (exit 1) instead of silently pinning an empty baseline. **Behaviour change.** |
| `src/commands/security.ts:385` pinned-baseline read | rug-pull findings, hence `--strict` exit code | a baseline file that exists but is unreadable makes the scan incomplete instead of silently disabling rug-pull detection. **Behaviour change.** |
| `src/commands/security.ts:403` per-manifest scan | `--strict` exit code | an unreadable manifest is counted and reported as unreadable; under `--strict` it exits 1. Previously it scanned `null`, found nothing, and exited 0 — a clean exit code for an unrun check. **Behaviour change.** |

`src/commands/health.ts` is in the owned set and reads no JSON file at all
(0 sites). It is listed for completeness, not migrated.

## 4. Sites that do NOT migrate

All 24 remaining `readJsonFileOr` call sites, enumerated with their reason in
`T43-implementation.md`. The two owned by other workers this wave
(`src/security/self-protect.ts`, `src/security/service.ts`) are deferred by
ownership regardless of classification.

## 5. Tests (RED first)

New `src/lib/json.test.ts`:
- object / array / null / number / string / boolean / unparseable / absent →
  the three states, exhaustively.
- `readJsonFileOr` unchanged: still returns a parsed array/number/string, still
  returns the fallback only on a parse failure.

New regressions that FAIL before the change:
- `src/commands/security-scan-mcp.test.ts` — `--strict` over an unparseable
  manifest exits non-zero; `--pin` on an unreadable manifest writes no baseline
  and exits 1; an unreadable pinned baseline makes the scan incomplete.

Pins that must not move (already green, must stay green):
- `src/security/guard.test.ts` T37 D1/D1b/D2/D2b/D2c, T54 D1/D1b/D1c/D2/D2b/D3 —
  the two sentinels' entire behaviour.
- `src/health/service-gate-exit.test.ts` — plus two added rows for a
  `latest.json` that parses to `null` and one that does not parse.

## 6. Out of scope

`readJsonFileOr` itself; `src/security/self-protect.ts`; `src/security/service.ts`;
`src/security/detect/exfil.ts`; any file outside the owned set; git state.
