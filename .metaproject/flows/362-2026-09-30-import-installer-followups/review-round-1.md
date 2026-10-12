# Review round 1 — flow 362

Range `origin/main..c8ef114e` (PR #822). Run inline by one reviewer across security, logic, test quality and
doc-vs-code; mutation runs M1–M4 and the two AC2 mutants all killed. 1 major, 4 minor, 2 info.

- **K-001 (major)** — with the security module disabled `guardOutput` returns no findings, so injection text is
  imported verbatim with a plain `imported` row, while the docs and help promise refusal in every mode.
  **Decision:** the import runs the repo's deterministic injection detector (`src/security/detect/injection.ts`)
  itself when the module is disabled, and refuses on a match exactly as in advisory/enforced; the row reason says
  the check ran without the security module. Secrets keep the floor redaction they already get. Docs say what
  the import checks when the module is off.
- **K-002 (minor)** — rules cited by a refused package are still imported. **Decision:** rules cited only by
  refused/would-refuse packages are not written and are reported `skipped — cited only by a refused package`;
  a rule also cited by an imported package is handled as before.
- **K-003 (minor)** — refused files exit 0; a SKILL.md blocked under `enforced` used to exit non-zero.
  **Decision:** a real run with any `refused` row exits 1 (after printing every row); a dry run with
  `would-refuse` rows exits 0. Docs and help state it.
- **K-004 (minor)** — `createProjectSkill` writes the scaffold/registry/catalog (and overwrites on `--force` /
  update) before the final re-gate. **Decision:** gate the final stamped text before `createProjectSkill`; a
  refusal at that point writes nothing. Keep the post-write re-gate only if it can no longer disagree — or remove
  it and state why.
- **K-005 (minor)** — PR body out of date. **Decision:** orchestrator rewrites it at the end.
- **K-006 (info)** — the `--allow-flagged` hint prints for refusals the flag cannot override. **Decision:** fix
  (print only when a refused row has a `prompt-injection.*` finding).
- **K-007 (info)** — the bundled example quotes injection text and the AWS placeholder; no path gates it.
  **Decision:** no change.
