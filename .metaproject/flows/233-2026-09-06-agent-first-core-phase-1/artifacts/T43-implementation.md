# T43 — implementation: `readJsonObjectFile`, and the six readers that moved to it

Ruling implemented: `T39-review.md` §"Judgement calls" #4. Spec: `T43-spec.md`.
`readJsonFileOr` is byte-identical; a sibling was added; the two hand-rolled
`Symbol` sentinels are gone.

## 1. What was added

`src/lib/json.ts` gains `JsonObjectRead` and `readJsonObjectFile(filePath)`.

```ts
export type JsonObjectRead =
  | { state: "object"; value: Record<string, unknown> }
  | { state: "non-object"; value: unknown }
  | { state: "unreadable" };
```

Three answers, because the callers have three situations. `object` means the
file was read, parsed, and IS a plain object. `non-object` means it parsed to
`null` / an array / a number / a string / a boolean, and carries that payload.
`unreadable` means it could not be read or did not parse — an absent file lands
here too, and every migrated caller asks `pathExists` first, because "never
configured" and "configured but destroyed" are different postures and a reader
that does not stat cannot honestly tell them apart.

Deliberately **not generic**. `readJsonFileOr<HealthReport>(file, fallback)`
type-checks and then hands back whatever parsed; a generic sibling would repeat
that one shape further in. What comes back is `Record<string, unknown>` —
exactly the fact that was verified — and the caller narrows with its own
predicate (`hasGateShape`, `isSecurityMode`, …). That is the acceptance
criterion "a signature that does not promise a type it may not return", read
literally.

Named `readJsonObjectFile`, not `readJsonObject`, because
`src/harness/external/codec/codex-cli.ts:322` already has a module-local
`readJsonObject(line: string)` that parses one NDJSON line.

## 2. Classification criterion

A reader migrates **iff its payload can change a gate status, a process exit
code, or a persisted security decision** — i.e. iff an unparseable or non-object
payload could make a check read as *clean*, *passed* or *disabled* when it was
never established. This is the ruling's own phrasing and `policies.md`
§"Health и security gate": a required check that is missing, skipped, unparsed
or unfinished is INCOMPLETE, never PASS.

Two things the criterion deliberately does **not** sweep in. A configuration
merge whose documented answer for a broken file IS the default (the file states
a preference, not a verdict) stays. A reader whose payload is legitimately
non-object stays — that is the whole reason `readJsonFileOr` was not changed.

Ownership overrides classification: only `src/lib/json.ts`,
`src/security/config.ts`, `src/security/guard.ts`, `src/commands/security.ts`,
`src/commands/health.ts`, `src/health/service.ts` and their tests were editable
this wave. A site classified security-relevant but outside that set is listed
below as deferred-by-ownership, not silently dropped.

## 3. Full call-site enumeration

`keryx ctx rg "readJsonFileOr" src --glob '!*.test.ts'` → 57 raw lines, 24
files. Stripping the 23 `import` lines, the 3 comment mentions and the
definition itself leaves **30 actual call sites in 23 files**. No test file
calls it (`keryx ctx rg "readJsonFileOr\(|readJsonFileOr<" src --glob '*.test.ts'`
→ 0 matches). Raw: `2026-09-06T16-09-46-846Z_rg.log`,
`2026-09-06T16-10-03-480Z_rg.log`.

### 3a. Migrated (5 `readJsonFileOr` sites + 2 bare parses, 4 files) — all inside the owned set

| # | Site | Feeds | Verdict change |
|---|---|---|---|
| 1 | `src/security/config.ts:265` `loadSecurityConfig` | the workspace's whole security posture: `guardOutput`, `securityFlowGate`, every §14 check | **none** |
| 2 | `src/security/guard.ts:183` `resolveManifestSecurityState` | `securityFlowGate` status, `guardOutput` allow/refuse | **none** |
| 3 | `src/health/service.ts:67` `readLatest` (the stored report) | `health gate` status + exit code, `health status`, `explain`, `baseline` | **none** |
| 4 | `src/health/service.ts:77` `readLatest` (the pointed-to record) | same | **none** |
| 5 | `src/commands/security.ts:370` `scan-mcp --pin` | the pinned rug-pull baseline (a persisted security decision) | **changed** — see §5 |
| 6 | `src/commands/security.ts:403` `scan-mcp` per-manifest read | `--strict` exit code | **changed** — see §5 |

Plus one bare reader in the same command, migrated for the same reason:
`src/commands/security.ts:385`, the pinned-baseline read itself (now
`readMcpBaseline`, §5).

`src/commands/health.ts` is in the owned set and reads **no JSON file at all** —
zero call sites. Listed so the enumeration is complete, not migrated.

### 3b. Not migrated (25 `readJsonFileOr` sites, 20 files)

30 sites − the 5 migrated above = 25; 23 files − the 3 migrated files = 20.

**Deferred by ownership — another worker holds the file this wave** (the
dispatch's own instruction; both would otherwise be examined against the
criterion):

| Site | Note |
|---|---|
| `src/security/self-protect.ts` (no `readJsonFileOr` site; owned by another worker) | untouched entirely |
| `src/security/service.ts` `readLatestReport` (bare parse, not `readJsonFileOr`) | T39 calls it "already correct, as the reference shape"; owned by another worker |
| `src/security/detect/exfil.ts` (no site) | read-only review in progress |

**Classified security/gate-relevant, deferred by ownership — recommended
follow-up, in priority order:**

| Site | Why it qualifies |
|---|---|
| `src/health/config.ts:71` `loadHealthConfig` | The payload carries `gate` (`failOnPriorities`, `failOnRegressionDrop`, `failOnMissingRequiredSource`) and the `required` flag of every source. A destroyed file silently reverts an operator's tightened thresholds to the defaults — and a file containing the four bytes `null` **throws** (`null is not an object (evaluating 'parsed.schemaVersion')`), out of `health run` and `health sources`. Probe: `2026-09-06T16-23-57-189Z_run.log`. This is the strongest remaining instance of the class. |
| `src/wiki/config.ts:106`, `src/memory/config.ts:54`, `src/gdgraph/config.ts:103` | Same crash on `null` (`parsed.rlm`, `parsed.ingest`, `parsed.affected`), same log. Not gate-relevant by the criterion — they configure behaviour, not a verdict — but they are the same unguarded-merge shape and would be cheap to fix in the same pass. |

**Not security-relevant — configuration merges whose defaults are the intended
answer, and which already guard their payload's shape:**

| Site | Reason |
|---|---|
| `src/mcp/config.ts:108` | `mergeMcpConfig` rejects non-objects at `:63` before merging. Probe: all five payloads → defaults, no throw. |
| `src/assets/lock.ts:83` | `normalizeLock` tolerates any payload; probe confirms all five → empty lock. The comment already documents the fallback as intended. |
| `src/capability/wiring.ts:188` | Carries the shape guard T39 named as "the pattern"; a capability config only turns a capability on or off, which the manifest already decides. |
| `src/commands/ctx.ts:1153` | `ctx` output-shaping preferences. |
| `src/wiki/ask.ts:255` | Explicitly checks `raw === fallback \|\| raw == null \|\| typeof raw !== "object"` at `:257` — it already has the distinction, locally. A dictionary miss degrades a translation, not a decision. |
| `src/commands/skills.ts:1263` | Validates `module`/`name`/`status`/`verifiedAt` field by field at `:1264` and drops anything that fails; a malformed report is already excluded from the summary. |

**Not security-relevant — the `manifest.modules` readers (T35 enumerated eight;
the complete list today is the 15 sites below).** The ruling says these "stay
fail-closed and are not urgent". Each reads
`modules.<name>.enabled === true`, so every payload that is not the object it
must be resolves to "module disabled", which is the safe direction for a
capability probe (unlike `guard.ts`, where "disabled" is what an attacker wants
and the file therefore has to distinguish unreadable from off):

`src/capability/seam.ts:70`, `src/capability/external-agents.ts:319`,
`src/testing/capability.ts:26`, `src/mcp/discovery.ts:123`,
`src/commands/ctx.ts:131`, `src/commands/skills.ts:274`,
`src/commands/skills.ts:1217`, `src/gdskills/verify.ts:125`,
`src/gdskills/learn.ts:202`, `src/gdskills/project-skills.ts:664`,
`src/gdskills/project-skills.ts:681`, `src/gdskills/export.ts:199`,
`src/gdskills/export-plugin.ts:188`, `src/gdskills/export-plugin.ts:189`,
`src/standard/emit-llms.ts:117`.

Every one of these 25 sites is untouched (4 + 6 + 15 = 25), and all of their
tests still pass (§6).

## 4. The two sentinel replacements

Both were invented for one reason: `readJsonFileOr` collapses "did not parse"
into "here is your fallback", and `{}` is a value a real file also produces.
Both are deleted and replaced by `read.state !== "object"`.

**`CONFIG_UNREADABLE` (`src/security/config.ts:206`)** — deleted, together with
the local `isMergeableConfigPayload` predicate it was paired with: the reader's
`object` state answers both questions at once. The forced-closed branch is
reached by exactly the same payloads as before (does not parse; `null`; array;
number; string; boolean), and the `mode`-recognition check below it now reads
`read.value.mode` — still the value the FILE declares, not the merged one, so a
present `"mode": null` still forces the posture closed instead of inheriting the
permissive default.

**`MANIFEST_UNREADABLE` (`src/security/guard.ts:152`)** — deleted. The T54
narrowing it was introduced to protect is intact: `modules === undefined` is
still "module disabled, manifest readable", `modules` present but not an object
is still unreadable, and a manifest that does not parse is still unreadable —
now because the reader says so, rather than because the `{}` fallback happened
to have no `modules` key.

Pinned, with no expectation changed, by the tests that already covered them —
`src/security/guard.test.ts` T37 D1, D1b, D2, D2b, D2c and T54 D1, D1b, D1c, D2,
D2b, D3 (the `__proto__` row included: an own `__proto__` member is data on the
returned object and `Object.prototype.modules` is still `undefined`). All 38
tests in that file pass unchanged (`2026-09-06T16-25-41-726Z_run.log`).

## 5. The one behaviour change: `security scan-mcp`

Disclosed in full, because it is a change and not a refactor.

`scan-mcp` read every manifest as `readJsonFileOr<unknown>(file, null)` and
handed the result to `scanMcpManifest`, whose `parseTools` finds no tools in a
non-object (`src/security/detect/mcp.ts:147`). So a manifest that could not be
read produced "scanned 1 manifest(s); 0 flagged" and, under `--strict`,
**exit 0** — a clean exit code for a check that never ran, which is the exact
sentence the dispatch gives as the reason this is worth fixing at the source.

Three changes, all of them explicit handling of the two non-object states:

1. **Per-manifest read.** An `unreadable` or `non-object` payload is recorded as
   `readable: false` and counted; it is not counted as scanned-and-clean. The
   run reports `coverage: "incomplete"`, and `--strict` exits 1 — findings and
   incompleteness stay independent, so a scan can be incomplete AND have found
   something, per `policies.md`.
2. **`--pin`.** An unreadable manifest is refused (`exit 1`, a message naming the
   file and never its bytes) instead of writing `{"schemaVersion":1,"tools":{}}`
   — an empty baseline nothing can ever drift from, recorded as though the
   operator had chosen it.
3. **The pinned baseline read** is now `readMcpBaseline`, which separates
   `absent` (never pinned — the ordinary case, silent and non-blocking) from
   `ok` from `unreadable` (present but unparsed, not an object, or with a
   `tools` member that is not a map). `unreadable` used to collapse into the
   same empty `{}` as `absent`, so every rug-pull comparison was silently
   skipped while the scan still reported clean.

`--json` gains `unreadable`, `coverage`, `baseline` and a per-file `readable`;
existing fields are unchanged. The shipped corpus is unaffected:
`security scan-mcp fixtures/mcp-threat --json --strict` → 14 scanned, 0
unreadable, coverage `complete`, baseline `absent`, 17 findings, exit 1 (from
the findings, as before). Raw: `2026-09-06T16-21-23-791Z_run.log`.

**Documentation drift this creates, deferred because the files are outside the
owned set:** `docs/docs/cli-reference.md:2116` ("`--strict` exits `1` when any
threat is found") and `:2139` ("`scan-mcp` exits `1` only with `--strict` when a
threat is found") must gain "…or when the scan could not read a manifest or the
pinned baseline (`coverage: incomplete`)".

## 6. Verification

All logs under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

| What | Result | Raw log |
|---|---|---|
| Regressions BEFORE the change | **8 pass / 6 fail / 1 error** across 14 tests, 3 files. The error is `json.test.ts` failing to load (`Export named 'readJsonObjectFile' not found`); the 6 failures are the `scan-mcp` rows. | `2026-09-06T16-15-47-976Z_run.log` |
| Regressions AFTER the change (`src/lib/json.test.ts src/commands/security-scan-mcp.test.ts src/health/service-gate-exit.test.ts src/security/guard.test.ts`) | **58 pass / 0 fail**, 458 expect(), 4 files | `2026-09-06T16-18-33-402Z_run.log` |
| `bun test src/lib src/security src/health src/commands` | **2076 pass / 6 skip / 0 fail**, 7778 expect(), 163 files | `2026-09-06T16-22-35-940Z_run.log` |
| `bun run typecheck` | exit 0 | `2026-09-06T16-20-30-084Z_run.log` |
| `bun run typecheck:scripts` | exit 0 | `2026-09-06T16-20-44-292Z_run.log` |
| `bunx eslint` on all 8 changed files | exit 0, no output | `2026-09-06T16-20-50-870Z_run.log` |
| `security scan-mcp fixtures/mcp-threat --json --strict` (real corpus, unchanged) | 14 scanned / 0 unreadable / complete / exit 1 from findings | `2026-09-06T16-21-23-791Z_run.log` |
| Probe: non-owned config loaders vs `null`/`[]`/`42`/`"x"`/unparseable | 4 of 6 throw on `null` (§3b) | `2026-09-06T16-23-57-189Z_run.log` |

The repository-wide suite was not run; the orchestrator owns it.

## 7. Files changed

| File | Change |
|---|---|
| `src/lib/json.ts` | added `JsonObjectRead` + `readJsonObjectFile`; `readJsonFile`/`readJsonFileOr` untouched |
| `src/lib/json.test.ts` | **new** — 7 tests over the three states, `__proto__`, the non-promising signature, and `readJsonFileOr`'s unchanged behaviour |
| `src/security/config.ts` | `CONFIG_UNREADABLE` + `isMergeableConfigPayload` deleted; reads via `readJsonObjectFile`; no verdict change |
| `src/security/guard.ts` | `MANIFEST_UNREADABLE` deleted; reads via `readJsonObjectFile`; no verdict change |
| `src/health/service.ts` | both bare `JSON.parse(...) as HealthReport` casts in `readLatest` replaced; `readFile` import dropped; no verdict change |
| `src/health/service-gate-exit.test.ts` | one added test (7 payloads) pinning the non-object/unparseable stored report |
| `src/commands/security.ts` | 3 `scan-mcp` readers migrated + `readMcpBaseline` helper + coverage/exit-code fold (§5) |
| `src/commands/security-scan-mcp.test.ts` | **new** — 6 tests, 4 of which failed before the change |

No test was deleted or weakened; no existing expectation was changed.
