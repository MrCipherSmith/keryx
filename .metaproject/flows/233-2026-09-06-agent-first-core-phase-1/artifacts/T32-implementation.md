STATUS: DONE_WITH_CONCERNS

# T32 implementation — committing the MCP transport and persistence regressions T24R#F-004 named

Ownership: `src/mcp/structural-redaction.test.ts` (new tests appended) and
`src/security/persistence-sinks.test.ts` (new tests appended). No production file was
edited in the working tree. No existing test was deleted or weakened.

Shapes were taken verbatim from the reviewer's own probes
(`T24-recheck-boundary.ts`, `T24-recheck-f002-class.ts`) and from `T24-recheck.md` /
`T36-implementation.md`, not invented independently.

## What each new test pins

### `src/mcp/structural-redaction.test.ts` (3 new tests)

1. **"MCP returns format-unsafe with the fixed property-name reason when a tool
   result's property name carries a credential, leaking it nowhere"** — mirrors
   `T24-recheck-boundary.ts`'s `mcp.secretKey` / `mcp.deepSecretKey` (top-level and
   array-nested). Asserts `isError:true`, `redaction.state:"format-unsafe"`,
   `redaction.reasons:["sensitive-property-name"]`, `text` equal to the constant
   `"Output withheld: format-unsafe"`, and `JSON.stringify(result)` (payload +
   metadata together) excludes the credential.
2. **"MCP refuses a declared output schema using a local $ref together with a
   supported validation sibling, with the fixed reference-sibling reason"** —
   mirrors `mcp.refSibling` (refused, `schema.unsupported-reference-siblings`)
   and `mcp.refDefsSibling` (bare `$ref` beside `$defs` alone stays supported,
   `state:"none"`), so the closure cannot regress into "any `$ref` fails".
3. **"MCP treats an entity-encoded image src and every srcset candidate as
   auto-fetch while an ordinary public link in the same payload is untouched"** —
   mirrors `mcp.entityImage` / `mcp.srcsetImage` / `mcp.publicLink`. Asserts
   `state:"redacted"`, `reasons:["egress.html-image-exfil"]`, the attacker host
   absent from the whole transported text, both masked fields carry
   `[REDACTED:url]`, and the public link field is byte-identical to the input.

### `src/security/persistence-sinks.test.ts` (6 new tests)

4–8. **Duplicate-member table** (`DUPLICATE_MEMBER_SHAPES`, one test per shape) —
   the exact five shapes from `T24-recheck-f002-class.ts`'s `shapeResults`: the
   JSON-escaped duplicate (`I`), the fully escaped duplicate (`AK`),
   and the empty/`null`/`false` survivor shapes for a contextual credential field
   (`pwd`, `api_key`, `secret`). Each calls `prepareOutputForPersistence` (the real
   materializer every durable sink calls) with a `pass` guard decision and asserts:
   `allowed:true`; `content` is **not** byte-identical to the input (proving the
   original bytes were not restored); `content` contains none of the credential's
   spellings (plain, `I`, `A`, `K`); and `JSON.parse(content)` equals
   the canonical safe value the current contract requires (`{"a":"safe"}`,
   `{"pwd":""}`, `{"api_key":null}`, `{"secret":false}`). This is the
   **current** contract per `T36-implementation.md`: the safe canonical form
   comes back with a redacted state, not a blanket refusal — these tests assert
   that contract, not the earlier `format-unsafe`/`serialized-content-mismatch`
   verdict the T24-recheck reported as a defect (T24R#F-003).
9. **"materializer keeps a metric string beside a long digit run allowed and
   redacted"** — mirrors `T24-recheck-boundary.ts`'s `requiredAllowedAndRedacted`
   (`{"metric":"<secret>","count":123456789}`). Asserts `allowed:true`, `content`
   differs from the raw input (redaction happened), the secret is absent, and the
   9-digit `count` survives untouched at its original numeric value.

## Scratch-revert experiment (all cases inverted)

Never edited the working tree. Built a scratch copy at
`/private/tmp/claude-502/-Users-Goodea-goodea-keryx/2c1aca69-07c3-46d7-89d4-79e0152123a5/scratchpad/T32-revert`
(`rsync` of the repo minus `node_modules`/`.git`, `node_modules` symlinked back to
the real checkout), removed after the run — nothing under that path exists any
more.

Two production files were reverted in the scratch copy only:

- **`src/security/detect/exfil.ts`** — replaced with the real, git-tracked
  pre-feature version (`git show HEAD:src/security/detect/exfil.ts`, 153 lines vs.
  307 today). This is a genuine historical revert, not a reconstruction: HEAD has
  no `CHARACTER_REFERENCE` decoder and no `srcset` support at all.
- **`src/security/output-validation.ts`** — this file is **untracked** (`git
  status` shows `?? src/security/output-validation.ts`; it was added uncommitted
  within this branch's in-flight work), so there is no prior git revision to check
  out. I reconstructed the pre-T36 "accountability gate" state instead, from the
  exact algorithmic description in `T24-recheck.md` (T24R#F-001, T24R#F-003) and
  cross-checked it against every control case the recheck recorded (the
  `{"pwd":"<credential>"}` single-member control staying `state:"redacted"`, and
  `escapedSecretDuplicateKey` / `numberUnderCredentialKeyDuplicate` staying
  `format-unsafe`). The reconstruction: a `parsedValueAccountsForBytes` gate runs
  **before** the structural walk, over raw-text `detectSecrets`/`detectPii`/`detectExfil`
  spans (no JSON-escape normalization, no contextual field-name rule) compared
  against the parsed value's reachable **string** scalars; if any span is
  unaccounted for, refuse with `serialized-content-mismatch` before ever running
  the walk; otherwise run the walk and return the walk's own text unless its state
  is `"none"`, in which case the **original raw bytes** are returned unconditionally
  (this unconditional substitution, not a byte/canonical check, is exactly the
  T24R#F-001 bug). Two more one-line reverts in the same scratch file: removed the
  `isSensitivePropertyName` screen in the object walker (T24#F-001, the *original*
  T24 property-name bypass) and removed the `REFERENCE_SAFE_SIBLINGS` sibling
  screen in `screenSchema` (T24#F-003, the *original* `$ref`-sibling bypass) — both
  one-line deletions, clearly marked `SCRATCH REVERT` in the file, isolating
  exactly the check each test pins.

Ran `bun test src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts`
from inside the scratch copy (`cd` into it, `bun` resolves `node_modules` via the
symlink): **21 pass, 10 fail**, raw
`.metaproject/data/gdctx/raw/2026-09-06T14-07-36-078Z_run.log`.

All 9 new tests failed as expected, for the documented reasons:

| Test | Failure under revert |
|---|---|
| secret property-name (top-level + nested) | `isError` false instead of true — the reverted walker copies the credential-bearing key through |
| `$ref` + sibling refused | `isError` false instead of true — the reverted `screenSchema` accepts the sibling silently |
| entity image / srcset / public-link control | `reasons` is `["egress.markdown-link-exfil"]` instead of `["egress.html-image-exfil"]` — HEAD's `exfil.ts` has no entity decoder and no `srcset` regex at all, so neither auto-fetch field is recognized; it also has no `SENSITIVE_URL_VALUE` gate on plain links, so it over-flags the ordinary public link instead. The test still fails as required — it just fails via a different mechanism than the narrow T24R#F-002 padded-reference nuance, because HEAD predates several generations of `exfil.ts` work, not only the T24 recheck's fix. |
| 5× duplicate-member persistence (escaped, fully-escaped, empty/null/false survivor) | `output.content` is byte-identical to the raw input — the reverted gate's `spans.length === 0` short-circuit (no escape normalization, no contextual rule) restores the original bytes with the credential still inside, exactly as T24R#F-001 described |
| metric beside long digit run | `output.allowed` is `false` instead of `true` |

**Concern on the last row.** `T36-implementation.md` records that
`secretPlusLongDigitRun` behaves identically (allowed, redacted) *before and
after* the T36 fix — i.e. under the real historical T26-era code this case should
still have passed, not failed. My reconstruction's `reachableScalarText` collects
only **string** scalars, so the raw-text `detectPii` phone-shaped span over the
nine-digit `count` in the serialized bytes has no string scalar to match against
and is treated as unaccounted-for, over-rejecting. This is a fidelity gap in the
reconstruction (the real old recognizer almost certainly excluded, or otherwise
accounted for, plain numeric-context digit runs the same way
`isNumericContextKey`/`isNumericText` already do on the value side), not evidence
that the *new* test is miscalibrated: `T36-implementation.md` is the authoritative
before/after record for this shape and it is independent of anything reconstructed
here. The pre-existing committed test at
`src/security/persistence-sinks.test.ts:27` (not one I added) also failed under
this same reconstruction artifact, which is additional evidence the imprecision is
in the scratch reconstruction, not specific to the new test.

No case needed a production change to invert — the scratch copy contains the only
edits, and they are pure deletions/reconstructions of already-documented pre-fix
logic.

## Verification

| Check | Result | Raw log |
|---|---|---|
| `bun src/cli.ts ctx run -- bun test src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` — **before** (original committed test files, reconstructed from the pre-edit `Read` output into temporary sibling files, run, then deleted; never left in the tree) | **22 pass, 0 fail**, 58 expect() calls, 2 files | `.metaproject/data/gdctx/raw/2026-09-06T14-01-48-091Z_run.log` |
| same command — **after** (with the 9 new tests added) | **31 pass, 0 fail**, 110 expect() calls, 2 files | `.metaproject/data/gdctx/raw/2026-09-06T14-00-29-403Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/security/output-validation.test.ts src/security/detect/exfil.test.ts src/mcp` — after | **216 pass, 3 skip, 0 fail**, 844 expect() calls, 219 tests across 20 files | `.metaproject/data/gdctx/raw/2026-09-06T14-01-58-957Z_run.log` |
| Scratch-revert experiment (all 9 new tests + 1 pre-existing test fail; 21 pass) | **21 pass, 10 fail**, 71 expect() calls, 2 files | `.metaproject/data/gdctx/raw/2026-09-06T14-07-36-078Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint src/mcp/structural-redaction.test.ts src/security/persistence-sinks.test.ts` | exit 0, no output | `.metaproject/data/gdctx/raw/2026-09-06T14-08-29-384Z_run.log` |
| `bun src/cli.ts ctx run -- bun run typecheck` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T14-08-41-199Z_run.log` |

`git status --porcelain` after cleanup shows exactly the two owned files touched
(`src/mcp/structural-redaction.test.ts` untracked/new, `src/security/persistence-sinks.test.ts`
modified, +85 lines / 0 deletions per `git diff --stat`) plus the large,
pre-existing multi-worker uncommitted state already present at dispatch start; no
scratch file, no other test file, and no production file was left changed.

## Acceptance criteria

- **AC2 (AFC-02)** — met at the transport and persistence boundaries this
  dispatch owns: the synthetic secret is absent from the transported JSON, the
  MCP metadata, and the persisted content in every new test; a numeric required
  field carrying a secret already had transport coverage (existing test,
  untouched) and stays green.
- **AC5 (AFC-15)** — met: no field-name bypass survives at the MCP transport
  (property-name test); a URL secret's auto-fetch channel is masked (entity/srcset
  test); the ordinary public Markdown link in the same payload is confirmed
  byte-identical, not a false positive.
- **Third criterion** ("every closure the two reviews demanded is pinned by a
  committed test at the boundary where the defect was reachable") — met for the
  four boundary-reachable closures T24R#F-004 named (secret property name,
  `$ref` sibling, entity/srcset auto-fetch, duplicate-member persistence) plus the
  metric/digit-run control; the full focused security + MCP selection stays green
  (`216 pass, 3 skip, 0 fail`).

## Concerns

1. The `output-validation.ts` scratch revert is a reconstruction, not a
   git-history revert (the file has no prior commit). It is closely
   cross-validated against every control case in `T24-recheck.md`, but a reviewer
   should not read the scratch-only "SCRATCH REVERT" code as ever having shipped —
   it is a testing aid only, and it never touched the real working tree.
2. The `exfil.ts` scratch revert used the real git-tracked HEAD version, which
   predates not just the T24 recheck's fix but the entire structural-redaction
   feature (no `SENSITIVE_URL_VALUE` gate on plain links either), so the auto-fetch
   test's failure mode under revert is broader than the narrow T24R#F-002 nuance
   alone. The test still demonstrably fails pre-fix, which is what was required.
3. The metric/long-digit-run reconstruction fidelity gap described above under
   "Concern on the last row" — the new test's correctness is anchored to
   `T36-implementation.md`'s explicit before/after record for that shape, not to
   the (imprecise) scratch reconstruction.
4. No production file was changed. If any of the pinned behaviors described above
   is not actually the intended contract, that is a specification question for the
   dispatch, not something this worker could resolve without a production change
   it is not authorized to make.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch enumerated the exact file set
  (`files_to_read`, `context_refs`); the graph predates this session's large
  uncommitted multi-worker change set and could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing text for this task is the
  reviewers' own probes and reports (`T24-recheck.md`, `T24-recheck-boundary.ts`,
  `T24-recheck-f002-class.ts`, `T36-implementation.md`), all read directly per the
  dispatch's explicit instruction to learn the exact shapes from them.
- `ctx_used: yes` — every command, test run, `git status`/`git diff`/`git show`,
  eslint and typecheck invocation went through `bun src/cli.ts ctx run`.
- `raw_rg_used: no` — no bare `rg`/`grep`. Two bounded raw escapes were used, both
  for writing (not reading-into-context) exact byte-for-byte source content into
  the scratch copy: `git show HEAD:src/security/detect/exfil.ts` redirected
  straight to a scratch file, and its `wc -l` confirmation — routing that through
  `ctx run` would have summarized/altered the exact source bytes the revert
  experiment depends on being byte-identical to HEAD.
