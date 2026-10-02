# Skills, rules and learning

Keryx ships a library of working skills (short, versioned instructions an agent loads for a kind of task), keeps your `AGENTS.md` and `CLAUDE.md` in step with the project's rules, and can turn what happens in your sessions into reviewed, reusable knowledge. Without it, every agent session starts from a blank page and every repository re-learns the same lessons.

## When to use it

- You want an agent to follow a repeatable procedure (review, commit, plan, test) instead of improvising it.
- You wrote a skill for one module and want agents to find it by describing the task, not by knowing its path.
- Your `AGENTS.md` or `CLAUDE.md` holds rules that should also reach every other agent in the project.
- A review or a failing test keeps teaching the same lesson and you want to capture it once, with your approval.
- You need to hand a set of skills, rules or memory entries to another repository or another machine.

## Quick example

Run this in a repository where `keryx init` has already run.

```bash
keryx skills status
keryx skills create src/payments --module payments --name retry-policy
keryx skills route "retry backoff in payments"
keryx rules sync
```

```text
gdskills: enabled
profile: recommended
bundled skills in profile: 59
installed skills root: .metaproject/skills/gdskills
…
Skill route for: retry backoff in payments
| Score | Source | Skill | Where | Reasons |
|---:|---|---|---|---|
| 110 | project | retry-policy | src/payments | target basename, module, tokens:retry+payments |
| 10 | catalog | review-highload | review/ | tokens:retry |
Next: keryx skills inspect payments/retry-policy

# rules sync

synced: 1
- AGENTS.md -> .metaproject/rules/agents-md.md (high)
```

## How it works

**Bundled skills.** `keryx init` installs the `recommended` profile of the gdskills module into `.metaproject/skills/gdskills/` (59 skills; `minimal` and `full` are the other profiles) and writes a catalog at `.metaproject/skills/catalog.md`. The package ships about 170 `SKILL.md` files in all, including stack-specific and rule variants. `keryx skills doctor` compares what is installed with the install record and reports each path as ok, drifted, missing or orphaned. `keryx skills verify --bundled` checks the shipped tree's structure, and says plainly that it does not judge whether a skill's advice is good.

**Project skills and routing.** `keryx skills create <target> --module <m> --name <n>` writes a skill package for one file or directory under `.metaproject/project-skills/<module>/<name>/`. `keryx skills route "<query>"` scores project skills and the bundled catalog against a phrase or a path and prints the best matches, so an agent loads one skill instead of reading a directory. `import`, `update` and `remove` bring in a skill from a folder, a `SKILL.md` or an HTTPS URL, re-read its origin, and delete it. `export` and `sync` write skills in the layout a given agent runtime reads.

**Rules.** `keryx rules sync` imports each root entrypoint (`AGENTS.md`, `CLAUDE.md`) as a high-priority rule under `.metaproject/rules/` and writes a managed routing block into the local entrypoint files, so every agent sees the same index. `keryx rules distill` goes further: it splits a large entrypoint into typed rules, project skills and root-only sections.

**Learning loop.** `keryx learn` is a consent pipeline: observe, extract, review, accept, apply, promote, graduate, prune. Observation is passive and stores only redacted digests, never transcripts. `extract` finds candidate patterns from five deterministic signals. Every step that changes a skill, rule or memory file needs you to type the command at a real terminal. Read [Self-learning loop](../learning.md) for the signals, the consent rules and the off switch (`KERYX_LEARNING=off`).

**Bundles.** `keryx bundle` moves skills, rules, agents, learned patterns, memory and hook configuration between projects and machines as a checksummed directory or archive. Applying a bundle copies verified bytes into known locations and never executes anything. See [Move skills, rules, agents, and memory](../guides/portability.md).

```bash
keryx bundle export --scope project --include 'project-skills/**' ./portable
keryx bundle verify ./portable
keryx bundle import ./portable --target-scope project --dry-run
```

```text
Exported bundle keryx-project-5838ef3b2046 to ./portable
  5 entrie(s), 0 skipped
Bundle keryx-project-5838ef3b2046: verified
Plan for bundle keryx-project-5838ef3b2046 (ok):
  skill:
    [new] project:project-skills/payments/retry-policy/SKILL.md
…
```

## Common tasks

| I want to… | Command or page |
|---|---|
| See what is installed and how fresh it is | `keryx skills status`, `keryx skills doctor` |
| Find the skill for a task | `keryx skills route "<what you are doing>"` |
| Write a skill for a module | `keryx skills create <target> --module <m> --name <n>` |
| Check a skill's structure | `keryx skills verify <module>/<name>` or `--all` |
| Bring in a skill from elsewhere | `keryx skills import --from <dir\|SKILL.md\|https-url>` |
| Push `AGENTS.md` rules into the project | `keryx rules sync` |
| Review what the sessions taught | `keryx learn list`, `keryx learn review <id>` |
| Share skills with another repository | [Move skills, rules, agents, and memory](../guides/portability.md) |

## Status

Stable. Skills come from `gdskills`, one of the nine modules `keryx init` enables by default; `keryx rules`, `keryx learn` and `keryx bundle` are commands, not separate modules. Passive learning observation runs by default in `keryx shell`; accepting, applying and promoting a learned pattern always needs you at a terminal. Model-judged skill evaluation (`keryx skills eval`, `judge-check`) calls a provider you choose and costs tokens, so it runs only when you ask.

## Reference

- CLI reference: [skills](../cli-reference.md#skills), [rules](../cli-reference.md#rules), [learn](../cli-reference.md#learn), [bundle](../cli-reference.md#bundle)
- Module reference: [gdskills](../modules.md#gdskills) and [rules](../modules.md#rules)
- [Self-learning loop](../learning.md)
- [Move skills, rules, agents, and memory](../guides/portability.md)
- [Give an agent context](../guides/give-an-agent-context.md)
