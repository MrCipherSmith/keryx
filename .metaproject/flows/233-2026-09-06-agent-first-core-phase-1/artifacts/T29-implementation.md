# T29 Implementation — retain the memoization regression under the mandatory redaction floor

## What was wrong

`src/security/service.memo.test.ts`, test `"one service keeps the config it loaded; a fresh one picks up the change"` (in `describe("the service actually uses it")`), asserted at its final line:

```ts
const fresh = await createSecurityService(dir).redact(PII, { source: "generated" });
expect(fresh.redacted).toContain("nobody@example.com");
```

That control step expects a FRESH `SecurityService`, created after the PII policy (`policies.pii.enabled`) was switched off, to return the synthetic email **raw**. That expectation predates T19/T22's mandatory deterministic output floor. Since then, `createSecurityService(...).redact()` (`src/security/service.ts:295-315`) always finishes with `validateSerializedOutput(content)`, i.e. `validateSerializedContentForTransport` (`src/security/output-validation.ts:549-569`), which runs its own independent `detectSecrets`/`detectPii`/`detectExfil` pass over every string leaf (`redactString`, `output-validation.ts:146-191`) and masks recognized spans **unconditionally** — it does not read `SecurityConfig` at all. So no service, fresh or otherwise, can return the raw email any more; the floor's whole job (T19/T22, `src/security/guard.ts:7-13`: "The mandatory deterministic output floor ... always applies first, even when the `security` module is disabled") is to make that assertion false. The old expectation was asserting the opposite of the product's guarantee.

Confirmed before editing: `bun src/cli.ts ctx run -- bun test src/security/service.memo.test.ts` — **5 pass, 1 fail**, failing exactly at that line with a `toContain` mismatch (raw log: `.metaproject/data/gdctx/raw/2026-09-06T13-52-59-963Z_run.log`). All other tests in the file (the four `memoizeResolved` unit tests, and the HMAC-key memo test in the second `describe`) already passed and were not touched.

## Why the property is still worth proving, and what observable replaces it

The test exists to pin that `createSecurityService` memoizes `configFor` (`memoizeResolved(() => loadSecurityConfig(cwd))`, `service.ts:281`) per **instance**: a service created before a config-file change keeps behaving per the old config on a later call, while a fresh instance picks up the new file. That property is real (see the file's own opening docstring: an unmemoized `redact()` cost ~80µs/call in `keryx serve`'s per-`assistant.delta` loop) and is not what changed.

What changed is which output is config-dependent. Reading `src/security/detect/index.ts:27-53` (`runDetectors`) shows `config.policies.pii.enabled` gates whether `detectPii` runs **at all** inside `resolveDecision` — not merely which `action` a resulting finding gets (`buildFinding`, `src/security/resolve.ts:74-111`, uses `policy.action` unconditionally once a match exists). So:

- policy enabled -> `detectPii` runs -> `redact()`'s `findings` array contains a `category: "pii"` entry (confidence 0.85 >= the test config's `minConfidence: 0.5`, so it is a genuine finding, not a `warn`-downgrade).
- policy disabled -> `detectPii` never runs inside `resolveDecision` -> `findings` contains **no** `pii`-category entry.
- meanwhile the floor's own `detectPii` call inside `redactString` runs regardless, so `redacted` never contains the raw email either way.

`findings` (specifically, whether a `pii`-category finding is present) is therefore a genuine config-dependent signal the floor does not touch, verified by reading `service.ts`, `resolve.ts` and `detect/index.ts` rather than assumed.

## What changed

Only `src/security/service.memo.test.ts`, only the one test and its immediately preceding explanatory comment block (both describing this test's own rationale — the rest of the file, including the second `describe` block about the HMAC key load and all four `memoizeResolved` unit tests, is untouched):

- `first`/`second`/`fresh` each keep the existing `not.toContain("nobody@example.com")` assertion on `redacted` (the floor keeps masking on every call, memoised config or not — this is what AC2/AC5's "floor keeps masking even when the advisory PII policy is disabled" pins).
- Each call adds `expect(<call>.findings.some((f) => f.category === "pii")).toBe(<true|true|false>)`: `first` (policy on) and `second` (policy off on disk, but same memoised service) both still report a `pii` finding — proving the service kept the config it loaded; `fresh` (new service, same disk state as `second`) reports none — proving the fresh instance picked up the change.
- No assertion anywhere expects raw PII in output. No production code was touched.

## Verification

| Step | Result | Raw log |
|---|---|---|
| Before: `bun src/cli.ts ctx run -- bun test src/security/service.memo.test.ts` | 5 pass, 1 fail (fails at the old line 162 `toContain` assertion) | `.metaproject/data/gdctx/raw/2026-09-06T13-52-59-963Z_run.log` |
| After: `bun src/cli.ts ctx run -- bun test src/security/service.memo.test.ts` | 6 pass, 0 fail, 26 expect() calls | `.metaproject/data/gdctx/raw/2026-09-06T13-55-48-329Z_run.log` |
| After: `bun src/cli.ts ctx run -- bun test src/security/service.memo.test.ts src/security/guard.test.ts src/security/persistence-sinks.test.ts` | 40 pass, 0 fail, 110 expect() calls | `.metaproject/data/gdctx/raw/2026-09-06T13-55-58-627Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint src/security/service.memo.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T13-56-03-155Z_run.log` |
| `bun src/cli.ts ctx run -- bun run typecheck` | `tsc --noEmit`, exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T13-56-14-585Z_run.log` |
| `git status --porcelain -- src/security/service.memo.test.ts` | ` M src/security/service.memo.test.ts` only | `.metaproject/data/gdctx/raw/2026-09-06T13-56-18-376Z_run.log` |

## Aside worth recording

`bun src/cli.ts ctx run` / `ctx rg` route captured command output through the project's own mandatory redaction floor before writing it to `.metaproject/data/gdctx/raw/*.log` or displaying it — so the raw logs listed above show the synthetic email as `[REDACTED:email]`, not literally. This is dogfooding of the same floor this task is about (`guard.ts`'s "always applies first" line) and did not interfere with verification: pass/fail counts and assertion counts are not PII and are unaffected. Source-file reads (via the `Read` tool) are unredacted and were used to confirm the true on-disk content before editing.

## Concerns

None. All acceptance criteria met; no production code touched; no other file changed; no git state, network, model, or dependency changes.

## Routing audit

- graph_used: not-relevant — this was a single-file, already-located test edit; no structural/blast-radius question needed gdgraph.
- wiki_used: not-relevant — mechanism was read directly from `service.ts`/`resolve.ts`/`detect/index.ts`/`output-validation.ts`/`guard.ts` and the T19/T22 implementation artifacts named in `context_refs`, which were sufficient; no separate architecture/domain question needed the wiki.
- ctx_used: yes — all commands and searches ran through `bun src/cli.ts ctx run` / `ctx rg` (see raw log paths above and in T29-result.json).
- raw_rg_used: no.
