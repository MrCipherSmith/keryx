# Metaproject Standard Profiles

Version: 0.1.1

## 1. Purpose

Profiles define compatible subsets of the Metaproject Standard. A repository
does not need every module to be standard-compatible.

## 2. Minimal Profile

Required:

- `.metaproject/metaproject.json`;
- `.metaproject/index.md`;
- `.metaproject/README.md`;
- `.metaproject/modules/`;
- `.metaproject/rules/`;
- `.metaproject/skills/`;
- `.metaproject/data/`.

Required manifest capability:

```json
"profiles": ["minimal"]
```

Use when a project only needs a stable agent/CI discovery layer.

## 3. Agent Profile

Includes Minimal Profile.

Required capabilities:

- root `AGENTS.md`, `CLAUDE.md` or equivalent points to
  `.metaproject/index.md`;
- at least one agent skill is present under `.metaproject/skills/`;
- rules are indexed under `.metaproject/rules/`;
- module manifests include agent routing notes.

Recommended modules:

- `gdgraph`;
- `gdctx`;
- `gdskills`;
- `gdwiki`;
- `memory`.
- `security`.

## 4. CI Profile

Includes Minimal Profile.

Required capabilities:

- normalized report artifacts under `.metaproject/data/<module>/artifacts/`;
- deterministic `latest.md` and `latest.json` for enabled report modules;
- lifecycle policy separating CI-published artifacts from transient raw logs.

Recommended modules:

- `health`;
- `testing`;
- `gdgraph`;
- `gdctx`;
- `tasks`.
- `security`.

## 5. Full Profile

Includes Minimal, Agent and CI profiles.

Recommended modules:

- `gdgraph`;
- `gdctx`;
- `gdwiki`;
- `gdskills`;
- `health`;
- `testing`;
- `memory`;
- `tasks`.
- `security`.

Use when a project wants `.metaproject/` to be the shared operational brain for
humans, agents and CI.

## 6. Future Profiles

Future draft profiles may include:

- `ide` - editor/plugin-oriented discovery and command metadata;
- `enterprise` - stricter audit, policy and compliance requirements;
- `multi-repo` - cross-repository manifests and shared memory/wiki routing.
