# Metaproject Artifact Lifecycle

Version: 0.1.1

## 1. Purpose

The lifecycle policy defines which `.metaproject/` files are canonical,
generated, transient, versioned, local-only or CI-published.

## 2. Canonical Files

Canonical files should usually be committed:

```text
.metaproject/index.md
.metaproject/README.md
.metaproject/metaproject.json
.metaproject/modules/*.md
.metaproject/rules/**
.metaproject/skills/**
.metaproject/project-skills/**
.metaproject/wiki/**
.metaproject/memory/**
.metaproject/security.config.json
```

Project policy may exclude sensitive memory/wiki pages.

## 3. Generated But Useful Artifacts

These artifacts may be committed when the team wants agent-readable project
state in git:

```text
.metaproject/data/*/artifacts/*.md
.metaproject/data/*/artifacts/*.json
.metaproject/gd-metapro-dashboard.html
```

The project may choose to keep only latest artifacts or publish them through CI
instead of committing them.

## 4. Transient Artifacts

Transient artifacts should usually be ignored:

```text
.metaproject/data/**/raw/
.metaproject/data/**/storage/
.metaproject/data/**/queries/
.metaproject/data/**/summaries/
.metaproject/data/**/history/
.metaproject/data/**/logs/
.metaproject/data/security/raw/
.metaproject/data/security/incidents/
.metaproject/data/security/redactions/
```

Module specs may override this when a storage artifact is intentionally
versioned.

## 5. Managed Service Files

Reference implementation service files under `.metaproject/core/` are managed
by `gd-metapro init` and `gd-metapro update`.

They should not be hand-edited unless the project intentionally forks the local
service layer. `gd-metapro update` must not delete or rewrite user-owned data
artifacts.

## 6. Hooks

Git hooks must be installed as managed blocks:

```text
# gd-metapro:<hook-id>:begin
...
# gd-metapro:<hook-id>:end
```

Updates must replace only managed blocks and preserve user hook content, Husky,
Lefthook, lint-staged and custom commands.

## 7. Update Contract

`gd-metapro update` may refresh:

- service files;
- bundled skills;
- bundled rules;
- module manifests;
- dashboard/service templates;
- hook definitions when `--hooks` is explicit.

It must not refresh analyzer data by default and must not overwrite user-authored
wiki, memory, rules or project-skills without an explicit command or managed
marker.
