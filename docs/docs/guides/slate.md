# Slate for external agents

keryx's own shell, TUI, and `harness run` already keep a private, task-local
scratchpad while they work — Anchors, a live Course pointer, and
model-written Seeds, living in `slate.json` next to the session. Until now
that scratchpad was internal: only keryx's own runtime could open one.

Three MCP tools change that. Any MCP-connected harness — Claude Code, Codex,
or anything else that speaks MCP — can open a slate of its own,
`externalSessionId`-scoped and never shared with a different id, write draft
Seeds into it, and close it into the same Shared Agent Context propose /
review pipeline a keryx-native session already uses.

!!! note "Scope of this page"
    This covers the external-hand surface only — `slate.open` /
    `slate.writeSeed` / `slate.close` (module `slate`, `src/mcp/tools.ts`,
    storage in `src/session/external-slate.ts`). keryx's own internal Slate
    lifecycle (Anchors/Course/Seeds inside a `keryx shell` turn, `/goal`,
    `workspace catch-up`) predates this and isn't its own guide yet — see
    [`docs/requirements/slate/`](https://github.com/MrCipherSmith/keryx/tree/main/docs/requirements/slate)
    for the full spec (SLATE-1…21 shipped, this page covers SLATE-22…26).

## The three tools

Local stdio / in-process only, exactly like `sac.*` — a call over HTTP is
refused with `{ code: "slate_transport_denied" }` before it touches storage.

| Tool | Mutating |
|---|---|
| `slate.open` | yes |
| `slate.writeSeed` | yes |
| `slate.close` | yes |

### Open a slate

```json title="slate.open"
{
  "externalSessionId": "claude-code-task-8f2a",
  "anchors": { "root": "/repo/src/billing" }
}
```

```json title="→ ExternalSlate"
{
  "externalSessionId": "claude-code-task-8f2a",
  "workspaceId": "workspace-8e3d8fd0fb084497",
  "anchors": { "root": "/repo/src/billing" },
  "seeds": [],
  "lastWriteAt": "2026-08-21T17:46:48.263Z"
}
```

Executed against a fresh project with no existing workspace — `workspaceId`
was left out, so the same resolve-or-create judgment `/goal` already uses
ran on close, found nothing to bind to, and created one. Pass an explicit
`workspaceId` to skip that judgment call entirely.

`anchors` is stored exactly as sent — no tree walk, no worktree resolve,
nothing keryx infers for a process it doesn't control. A second `open` for
the same `externalSessionId` is a no-op: it returns the existing slate
unmodified, never a second file, never a re-resolved workspace.

### Write a Seed

```json title="slate.writeSeed"
{
  "externalSessionId": "claude-code-task-8f2a",
  "text": "Refund path double-charges on retry; idempotency key is never set.",
  "kind": "risk"
}
```

```json title="→ SlateSeed appended to the slate"
{
  "id": "seed-6bb27442-b191-48eb-b911-6b5cbe25c9d4",
  "text": "Refund path double-charges on retry; idempotency key is never set.",
  "ts": "2026-08-21T17:46:48.275Z",
  "kind": "risk",
  "origin": { "harness": "mcp-external" },
  "trust": "external-unverified"
}
```

`kind` is one of `decision` · `wiki-update` · `memory-entry` · `follow-up` ·
`contract-change` · `risk`; an untagged Seed defaults to `follow-up` at
review time. An unrecognized value is refused outright:

```json title="slate.writeSeed with an invalid kind → throws"
{ "threw": "slate.writeSeed: unrecognized 'kind' \"not-a-real-kind\"" }
```

`origin` and `trust` are written by the handler, not the caller — a
caller-supplied value for either is silently ignored. `text` is redacted for
secret-shaped substrings before it is ever persisted, capped at 4,000
characters, and a slate holds at most 200 Seeds before `writeSeed` starts
refusing them.

### Close a slate

```json title="slate.close"
{ "externalSessionId": "claude-code-task-8f2a" }
```

```json title="→"
{ "externalSessionId": "claude-code-task-8f2a", "closed": true }
```

If a `workspaceId` was bound — explicitly, or by resolve-or-create — its
Seeds go into a real SAC proposal through the same machine-evidence wrap-up
path a keryx-native session's autonomous dispatch already uses. If nothing
was ever bound, nothing is lost: Anchors and Seeds are written to a local
artifact and surface at the next `keryx workspace catch-up` as
`unbound-candidate`, never silently discarded and never proposed against a
guessed id.

A slate left untouched past the same stale-lock window `withFileLock`
already uses elsewhere is closed the same way — automatically, on the next
`slate.*` call that touches that project. There is no background timer;
keryx has none, and this doesn't add one.

## Trust model

Being precise about what's actually enforced matters more here than
anywhere else in this surface.

**Structurally enforced:**

- One `externalSessionId`'s file is never reachable through a different one
  — checked against the filesystem directly, not only against tool
  responses.
- `origin` and `trust` on a Seed are always server-written.
- `text` is redacted before it is ever persisted.
- Accepting a Seed into real knowledge still goes through the same
  human-present `confirm-review` gate as any other SAC proposal — nothing
  here adds a second, lighter acceptance path.

**Left open, by design:**

- `trust: "external-unverified"` is a label for the reviewer, not a filter.
  Nothing here scores it or blocks on it.
- A compromised or careless hand can still write a misleading Seed — the
  human review gate is what catches that, unchanged from before this
  surface existed.
- Deduping is exact-text only. Two hands writing near-duplicate Seeds about
  the same fact both surface at review, worded differently.

## On-disk layout

```text
.keryx/external-slates/<externalSessionId>.json
```

Project-scoped, `.gitignore`d, one file per id. There is no `slate.list` or
`slate.read` spanning multiple ids — that absence is what makes the
cross-hand isolation above structural rather than a policy check layered on
top of a shared store.

## Not shipped (do not treat as current)

- Sharing an open slate between clients — the pre-existing non-goal this
  surface was built to *not* violate. It extends who may open a private
  slate, never whether one is shared.
- Trust scoring, or any automated handling that treats
  `trust: "external-unverified"` as a signal to act on.
- `origin.harness` rendered in the CLI `workspace review` output or the TUI
  review modal — the field exists in the evidence today; the review-surface
  rendering of it is still open.

## Where to go next

- [Shared Agent Context](shared-agent-context.md) — the propose / review
  pipeline every closed slate with a bound workspace dispatches into.
- [Requirements: Slate](https://github.com/MrCipherSmith/keryx/tree/main/docs/requirements/slate) —
  full spec, acceptance criteria, and the SLATE-1…26 history.
