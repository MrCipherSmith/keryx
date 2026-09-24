# W1: stack detection, install profiles and catalog governance gates (scout, eval, stocktake)

Status: formalized
Source: agent-platform-expansion program, Wave 2 (W1 slice). Spec:
`docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md`
(v0.1.2), `schemas/install-manifest.schema.json`, `implementation-plan.md` Wave 2.

## Problem

Keryx has no project-wide stack detection (only `src/review/stack.ts`, a
7-tag, `package.json`-only review-dispatch filter), a single fixed
`keryx skills install --profile recommended` curated subset with no plan,
install-state, doctor or uninstall, and no governance that checks catalog
growth before content is added (D-7: content scale-out only through
governance gates). Wave 4 stack-pack authoring cannot start until detection,
the install model and the gates exist.

## Expected Outcome

- `keryx stack detect [--cwd] [--json]`: deterministic, offline, marker files +
  extensions + manifests, per-signal uncertain contribution, persisted to
  `.metaproject/data/stack/stack.json`; running twice yields identical output.
- A bundled install manifest (profiles → modules → components) validated
  against `install-manifest.schema.json`; `keryx skills install --profile <p>
  [--with/--without <component>] [--target <harness>] [--dry-run] [--json]`
  plan/apply; per-target install-state
  `.metaproject/data/skills/install-state/<target>.json`; `keryx skills doctor`;
  `keryx skills uninstall` touching recorded, hash-matching files only.
- Governance gates `keryx skills scout`, `keryx skills eval`,
  `keryx skills stocktake`, each with a CLI and data contract, running
  successfully on the existing bundled catalog.
- Authoring-standard lint for SKILL.md / stack rules integrated with the
  existing guard tests; `metadata.origin` provenance parsed and required on
  stack-pack content.
- One small experimental stack pack that exercises the gates (no Wave-4
  scale-out).

## Out of Scope

- Wave-4 stack-pack content scale-out (the 23-stack table).
- W2 agent definitions/compiler/exporters (`src/agents/`), W3 learning, W4
  bundles (only the documented hooks they will call).
- Redesigning `review-orchestrator`'s `stack_requires` dispatch; the legacy
  `--profile minimal|recommended|full|custom` install path keeps its behavior.
- A runtime rule loader that honors `paths:` globs (content carries the field;
  loader logic is a follow-up).
- Mass-editing the 72 existing bundled skills to add `metadata.origin`.
