# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A strict-output-schema transform turns the bundled subagent-result schema into a document the OpenAI structured-output validator accepts: every object lists all its properties in `required` and has `additionalProperties: false`, a property that was optional becomes nullable, and keywords the validator rejects (allOf, if/then/else, pattern, format, min/max bounds, default, title, description) are removed; the transform never mutates its input. [verify: exec `bun test src/harness/external/strict-schema.test.ts`]
- AC2: A reverse step removes a null that sits on a property the original schema did not require, so a document produced under the strict schema validates against the full original subagent-result schema, while a null on a required property is kept and still fails validation. [verify: exec `bun test src/harness/external/strict-schema.test.ts`]
- AC3: The codex codec is handed the strict document (its own staged file, refs bundled, no sibling `$ref`), claude still gets the inline bundled document and the unchanged full schema is what every result is validated against; a codex run whose final message carries nulls for the optional fields is Completed and its returned output has those nulls removed; a codex run that narrates in earlier agent messages returns only the final message as its result; a run ended by our own kill after its terminal event keeps the exit code from its events, not the signal exit code, and codex gets a terminal settle window long enough for its teardown. [verify: exec `bun test src/harness/external`]
- AC4: The strict document derived from the real subagent-result schema is accepted by the live codex API: `codex exec --output-schema <the staged file>` in a scratch repository returns a turn instead of `invalid_json_schema`; recorded in the flow journal with the codex version. [verify: judged]
- AC5: Live smoke with the installed release: one real `codex-cli` read-only run and one real `codex-cli --write` run through the real CLI return a schema-valid result; the write run yields a diff for review, discard leaves nothing, approval yields the branch `external/<run-id>`, and the main checkout is untouched; recorded with the codex version. [verify: judged]
- AC6: CHANGELOG and the external-agent docs state that codex receives a strict copy of the result schema and that keryx validates against the full one. `bun run check:doc-links` passes. [verify: exec `bun run check:doc-links`]
- AC7: A stop: the operator report carries the live results and what remains. [verify: none — a stop is an absence of work; the operator report is the evidence]
