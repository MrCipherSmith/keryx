# Governance and data lifecycle

Keryx answers "what did this work cost, who confirmed it, did the gates pass, and did it help" from what it already recorded, and it gives the stores that grow on disk a way to be bounded and to forget. Without it that evidence sits in per-flow files, review manifests and run ledgers, and nobody can say what was deleted or why.

## When to use it

- You need one report of spend, confirmations, signatures and gate outcomes across your flows.
- You want to know which finished work was never checked for its effect on the product.
- The compact-output logs under `.metaproject/data/` are growing and you want to bound them.
- Someone asked you to remove something, and you need a record of what was removed and what was left.
- You want a single HTML page that shows the state of the project for a person.

## Quick example

Create a flow, then ask for the governance report. The report only reads what is on disk; it never re-runs a gate or calls a model.

```bash
keryx flow init --title "Add login page"
keryx governance report
keryx retention status
keryx forgetting trail
```

```text
# Governance report
…
### 001 — Add login page

status: initializing
owner: not recorded
review spend: spent=not recorded (rounds_with_spent=0), …
acceptance coverage: not frozen yet (1 criteria drafted; kinds are read at freeze)
confirmations: not recorded (predates signing)
gate outcomes: not recorded
dispatch runs: none (no trigger has ever fired for this flow)

Written: <repo>/.metaproject/data/governance/artifacts/latest.md
Written: <repo>/.metaproject/data/governance/artifacts/latest.json
```

A figure nobody recorded reads "not recorded", never zero.

## How it works

**Governance report.** `keryx governance report` reads `flow.json` (owner, signatures, confirmed criteria, completion attempts), review package manifests (cost) and the trigger run ledger, and writes `latest.md` and `latest.json` under `.metaproject/data/governance/artifacts/`. Filter with `--flow`, `--owner`, `--since` and `--until`; `--all-projects` also walks every project in your registry (`keryx projects list`). `keryx governance show` reprints the last report without regenerating it. Each flow also shows how many of its acceptance criteria are runnable.

**Product intents.** `keryx product index` reads every flow and requirements package into a disposable index of stated intents. `keryx product open` lists the intents that were closed in code and never looked at again, split by whether an outcome criterion was stated and whether an outcome was observed. It gates nothing and calls no model.

**Retention.** `keryx retention status` shows the size and age of the stores keryx bounds (the compact-output raw logs and summaries under `data/gdctx/`, and write-conflict sidecars). `keryx retention sweep` is a dry run; `--apply` removes. `keryx ctx` also sweeps its own stores at most once a day after it writes an artifact. `KERYX_RETENTION_AUTO=0` turns that off. A sweep never touches content already relayed to an agent, copies exported elsewhere, or git history.

**Forgetting.** `keryx forgetting trail` and `keryx forgetting lookup "<ref-or-path>"` read the deletion trail: what was removed, when, at whose request, on what basis, and which layers a record names as untouched. The trail is a read-only record; it is not a promise that every copy of the content is gone.

**Dashboard.** `keryx dashboard build` writes `.metaproject/keryx-dashboard.html`, one self-contained page with the project's health, graph, testing, wiki and memory state, and `keryx dashboard open` opens it. `init` and `update` also rebuild it.

## Common tasks

| I want to… | Command or page |
|---|---|
| See spend and confirmations for one flow | `keryx governance report --flow <id>` |
| Reprint the last report | `keryx governance show` |
| Report across all my projects | `keryx governance report --all-projects` |
| List work that shipped and was never checked | `keryx product index`, then `keryx product open` |
| Preview what retention would remove | `keryx retention sweep` |
| Remove it | `keryx retention sweep --apply` |
| See what was deleted and why | `keryx forgetting trail` |
| Build the dashboard | `keryx dashboard build` |

## Status

Stable and read-mostly. `governance`, `product`, `forgetting` and `dashboard` only read and write their own artifacts inside `.metaproject/`: the dashboard page is `.metaproject/keryx-dashboard.html`, the rest is under `.metaproject/data/`. `retention sweep` deletes only with `--apply`. The governance report cannot show what was never recorded, which is why it says so.

## Reference

- CLI reference: [governance](../cli-reference.md#governance), [product](../cli-reference.md#product), [retention](../cli-reference.md#retention), [forgetting](../cli-reference.md#forgetting), [dashboard](../cli-reference.md#dashboard-and-dash)
- [Module reference: governance](../modules.md#governance), [product](../modules.md#product)
- [Workspace and lifecycle](../workspace-and-lifecycle.md)
- [Managed work: flows, jobs, review](managed-work.md)
