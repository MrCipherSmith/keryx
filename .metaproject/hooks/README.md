# Metaproject Hooks

Hooks are local project scripts executed by selected `gd-metapro` lifecycle commands.

## post-update.d

Executable files in `post-update.d/` run after `gd-metapro update`.

Rules:

- keep hooks idempotent;
- keep hooks project-local;
- do not require network access unless the hook clearly documents it;
- use generated data under `.metaproject/data` for outputs.
