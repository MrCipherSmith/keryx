# Metaproject Standard: technical specification

Version: 0.1.1

Status: draft v0.1. This document defines the intended standard contract, not a
fully implemented validator.

## 1. Definition

A Metaproject is a project-local `.metaproject/` workspace that stores
agent-readable context, human documentation, module manifests, generated
artifacts, rules, skills and project workflow state.

`gd-metapro` is the reference implementation. Other tools may implement the same
format without using the `gd-metapro` runtime.

## 2. Required Root Files

Every compatible Metaproject must contain:

```text
.metaproject/
  index.md
  README.md
  metaproject.json
```

`index.md` is the primary LLM-friendly portal. It should be concise and link to
enabled modules, rules, skills, wiki, memory, tasks and report artifacts.

`README.md` is the human technical guide for the local `.metaproject/`
workspace.

`metaproject.json` is the machine-readable discovery manifest.

## 3. Required Core Directories

```text
.metaproject/
  modules/
  rules/
  skills/
  data/
```

`modules/` stores human-readable module manifests.

`rules/` stores project and agent rules.

`skills/` stores reusable agent-facing skills.

`data/` stores module artifacts and generated outputs.

## 4. Optional Standard Directories

```text
.metaproject/
  core/
  project-skills/
  hooks/
  post-update.d/
  reports/
  templates/
  wiki/
  memory/
  health/
  security/
```

`core/` may contain project-local service scripts copied by a reference
implementation. Other implementations may use global commands instead.

`project-skills/` contains generated entity/component/domain skills.

`hooks/` and `post-update.d/` describe local automation hooks and update hooks.

`reports/` contains human-readable published reports. Dashboard HTML may live at
`.metaproject/gd-metapro-dashboard.html` or under `reports/` in a future
profile.

## 5. Discovery Manifest

`metaproject.json` must follow the initial schema in
[schemas/metaproject.schema.json](schemas/metaproject.schema.json).

Required fields:

- `schemaVersion`;
- `standardVersion`;
- `createdBy`;
- `paths`;
- `modules`.

Recommended fields:

- `name`;
- `projectType`;
- `languages`;
- `profiles`;
- `capabilities`;
- `updatedAt`.

Example:

```json
{
  "schemaVersion": 1,
  "standardVersion": "0.1.0",
  "name": "example-project",
  "createdBy": "gd-metapro",
  "profiles": ["minimal", "agent"],
  "paths": {
    "root": ".metaproject",
    "data": ".metaproject/data",
    "rules": ".metaproject/rules",
    "skills": ".metaproject/skills",
    "modules": ".metaproject/modules"
  },
  "modules": {
    "gdgraph": {
      "enabled": true,
      "manifest": ".metaproject/modules/gdgraph.md",
      "data": ".metaproject/data/gdgraph",
      "commands": ["build", "query", "affected"]
    }
  }
}
```

## 6. Module Contract

Each module entry in `metaproject.json` must declare:

- `enabled`;
- `manifest`;
- at least one of `data`, `wiki`, `memory`, `core`, `skills` or
  `projectSkills`;
- `commands` or `capabilities` when the module exposes operations.

Each enabled module should have a human-readable Markdown manifest:

```text
.metaproject/modules/<module>.md
```

The Markdown manifest should include:

- purpose;
- agent entry;
- data paths;
- commands;
- generated artifacts;
- lifecycle notes.

Future versions may add optional `.metaproject/modules/<module>.json` manifests,
but v0.1 keeps `metaproject.json` as the only required machine-readable module
registry.

## 7. Agent Entrypoint Contract

Root-level `AGENTS.md`, `CLAUDE.md` or equivalent agent entrypoints should:

- keep only global/highest-priority rules;
- link to `.metaproject/index.md`;
- instruct agents to discover module capabilities before broad raw file search.

The standard does not require every runtime to support the same skill format,
but it requires that project-local agent skills are discoverable under:

```text
.metaproject/skills/
.metaproject/project-skills/
```

## 8. Artifact Contract

All module artifacts must live under:

```text
.metaproject/data/<module>/
```

Recommended subdirectories:

```text
artifacts/
history/
raw/
storage/
queries/
summaries/
reports/
```

`artifacts/latest.md` and `artifacts/latest.json` are recommended for normalized
latest reports when a module has report-like output.

## 9. Reference Module Keys

The standard reserves these module keys for common capabilities:

| Key | Capability |
|---|---|
| `gdgraph` | Code graph and affected context |
| `gdctx` | Compact command/file context and raw-output summarization |
| `gdwiki` | Project wiki and knowledge pages |
| `gdskills` | Skill lifecycle, routing, verification and learning |
| `health` | Code health reports and quality gates |
| `testing` | Test discovery, context and normalized reports |
| `memory` | Long-term project memory |
| `tasks` | Task and flow state |
| `security` | Prompt, artifact, privacy, secret and exfiltration policy checks |

Third-party modules should use lowercase kebab-case keys and must not reuse
reserved keys with incompatible semantics.

## 10. Versioning

`standardVersion` uses semantic versioning while the standard is pre-v1:

- patch: clarification or schema-compatible field documentation;
- minor: new optional fields, profile additions, new module annex drafts;
- major: incompatible manifest, path or lifecycle changes.

While the standard is `<1.0.0`, minor versions may still change draft fields.
Validators must report unsupported versions clearly.

## 11. Validation Requirements

A validator should check:

- required files exist;
- `metaproject.json` matches schema;
- declared paths exist or are marked optional;
- enabled modules have manifests;
- root entrypoints point to `.metaproject/index.md` when present;
- generated/transient data follows lifecycle policy;
- profile requirements are satisfied.

Planned reference commands:

```bash
gd-metapro standard validate
gd-metapro standard doctor
gd-metapro standard capabilities
```

## 12. Relationship To Existing Specs

This document defines the standard core. Module details stay in:

- [../spec-orchestrator/specification.md](../spec-orchestrator/specification.md)
- [../gdgraph/specification.md](../gdgraph/specification.md)
- [../gdctx/specification.md](../gdctx/specification.md)
- [../gdskills/specification.md](../gdskills/specification.md)
- [../code-health/specification.md](../code-health/specification.md)
- [../testing/specification.md](../testing/specification.md)
- [../wiki/specification.md](../wiki/specification.md)
- [../documentation-memory/specification.md](../documentation-memory/specification.md)
- [../task-manager/specification.md](../task-manager/specification.md)
- [../security/specification.md](../security/specification.md)
