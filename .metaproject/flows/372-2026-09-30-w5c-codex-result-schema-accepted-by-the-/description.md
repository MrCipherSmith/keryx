# W5c codex result schema accepted by the OpenAI strict response_format

Status: frozen
Source: live smoke of flow 371 (release 0.3.42)

## Problem

Every `codex-cli` run, read-only or write, ends with `invalid_json_schema`: keryx hands codex the full subagent-result schema with `--output-schema`, and the OpenAI structured-output validator rejects it (optional properties not listed in `required`, `additionalProperties: true` on metrics, sibling `$ref`, and keywords it does not support). No codex run has ever completed through keryx with the schema flag; flow 366's live runs stopped earlier at a usage limit, so the defect was not seen.

## Expected Outcome

A codex run completes through keryx and returns a schema-valid result. keryx keeps validating against the full schema; codex is only given a strict copy to constrain its output.

## Outcome criteria

- A real codex-cli run, read-only and with --write, returns Completed with a valid subagent-result instead of the schema error.

## Out of Scope

Changing the subagent-result contract itself, claude and agy schema handling, the codex read-only `--ignore-rules` gap.
