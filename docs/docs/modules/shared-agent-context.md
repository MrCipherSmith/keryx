# Shared Agent Context

Shared Agent Context is a file-backed workspace for one piece of work, with a bounded view of its facts, work and know-how, and a reviewed path that promotes a finished session into the wiki, memory or a skill. It removes the choice between losing what a session learned and letting an agent write straight into long-term knowledge. It is experimental and off by default.

## When to use it

- Several agent sessions touch one piece of work and you want them to start from the same evidence, not from a re-read of the repository.
- You want a session's conclusions to reach the wiki or memory only after a person reviews them.
- You want an agent to fetch a bounded overview with a token budget and see, in a ledger, what it was shown.
- You want to catch up on what unattended runs left behind: pending proposals, blocked runs, wrap-ups with no workspace.

## Quick example

The `keryx workspace` commands run in any project that has `.metaproject/`. The `sac` module itself is off by default (see Status). Run these from the project root:

```bash
keryx workspace create --title "Payments retry" --component ./src/payments
keryx workspace add-resource <workspace-id> --kind evidence --uri ./src/payments/retry.ts
keryx workspace overview <workspace-id> --max-items 5
```

```json
{
  "partial": false,
  "omittedOptional": [],
  "withheld": [],
  "manifest": {
    "workspaceId": "workspace-f450c05bdcac44a1",
    "facts": [
      {
        "statement": "Evidence reference ./src/payments/retry.ts",
        "freshness": "fresh"
      }
    ],
    "work": { "state": "unbound" },
    "knowHow": [],
    "freshness": "fresh"
  },
  "receipt": { "action": "overview", "decision": "allowed" }
}
```

The output is trimmed. `create` prints the workspace record, including its `id`; use that id in the later commands.

## How it works

**Three kinds of content.** A workspace never blurs them. Facts are evidence-linked, task-local, freshness-bound statements. Work is a read-only projection of an existing flow, or the explicit state `unbound` when none is linked. Know-how is accepted wiki, memory or skill items. A fact never becomes long-term knowledge silently, and the workspace stores workspace-relative references, not copies.

**Bounded reads.** `workspace overview` and `workspace read` take `--max-items` and `--max-tokens`. If a mandatory item cannot fit the budget the call returns a typed overflow instead of a truncated answer. Every allowed or denied read appends a metadata-only receipt to `.metaproject/context-operations/access-receipts.jsonl`; receipts hold no retrieved content.

**Propose and review.** `workspace propose` turns a completed shell session into a proposal (a decision, wiki update, memory entry, follow-up, contract change or risk). `workspace review --decision accepted` writes it to the owner (wiki, memory or project skills) and needs a confirmation token that only `workspace confirm-review` run by you in a terminal can mint. If the proposal's evidence trips the security scanner, `confirm-review` shows the findings and requires `--acknowledge-security`. A failed owner write leaves the proposal `stale`, never `accepted`. This is friction against agent mistakes, not a defence against a hostile agent; see [Limitations](../limitations.md).

**Where agents see it.** Editor agents reach workspaces through MCP `sac.*` tools over local stdio only; HTTP refuses them. A local `keryx shell` turn has `workspace_overview`, `workspace_read`, `workspace_list`, `workspace_show` and `workspace_create`. `keryx commands` deliberately omits the `workspace` verb.

**Subcommands.** `create`, `list`, `show`, `add-resource`, `remove-resource`, `rename`, `archive`, `overview`, `read`, `propose`, `list-proposals`, `confirm-review`, `review`, `dismiss-candidate`, `handoff`, `collaboration`, `policy-readiness` and `catch-up`. `keryx workspace --help` lists them with their flags.

## Common tasks

| I want to… | Command or page |
|---|---|
| Start a workspace for a task | `keryx workspace create --title "<t>" --component ./<path>` |
| Attach evidence or a flow | `keryx workspace add-resource <id> --kind <kind> --uri ./<path>` |
| Give an agent a bounded briefing | `keryx workspace overview <id> --max-tokens 2000` |
| Capture what a session learned | `keryx workspace propose <id> --kind wiki-update --session <session-id>` |
| Accept or reject a proposal | `keryx workspace confirm-review`, then `keryx workspace review` |
| See what unattended runs left | `keryx workspace catch-up` |
| Full walkthrough | [Shared Agent Context guide](../guides/shared-agent-context.md) |

## Status

Experimental and opt-in. The `sac` module is off by default; `keryx modules enable sac` records it in the manifest so that `keryx serve-mcp` offers the `sac.*` tools to editor agents, while the `keryx workspace` commands run either way. The registry, bounded reads, propose and review, owner writers and the access-receipt ledger work today. A learned candidate policy exists behind a kill switch that is on by default, and only synthetic fixtures back it. Proposing from a flow wrap-up, SAC over HTTP, and public collaboration writers are not shipped. Reading workspace files needs POSIX `openat`, so it works on macOS and Linux only.

## Reference

- [Shared Agent Context guide](../guides/shared-agent-context.md)
- CLI reference: [workspace](../cli-reference.md#workspace), [modules](../cli-reference.md#modules)
- [Module reference: sac](../modules.md#sac)
- [Managed work: flows, jobs, review](managed-work.md)
