# Answer a remote approval from a bot or another product

A turn submitted over `keryx serve` cannot wait for a keypress. When its policy
decision is `ask`, the listener writes a **durable pending approval**, the turn
detaches (`202`), and a person answers somewhere else: a chat bridge over HTTP,
or `keryx approvals` / `/approvals` on the machine that runs the listener.

This page is the contract a chat bridge speaks. It does not cover rendering the
approval as a Telegram card or a web page; that is the client's job.

## Read this before you build on it

- **An answer is one call, once.** `allow` lets exactly the pending call run, one
  time. It is never a session grant and never trusts the tool for later calls.
- **A floor means "ask again every time".** A call that is destructive, uses a
  credential, or was put to a hook's `ask` carries that floor on its record.
  An `allow` covers this one call only; the next identical call asks again.
  A policy denial is decided before the approver runs and no answer overrides it.
- **Silence is a denial.** An approval nobody answers resolves to `expired` (a
  denial) at its expiry, and the turn continues with that denial.
- **A delivery failure denies at once.** With no consumer attached (see below)
  the approval resolves as `undeliverable` immediately, not at expiry.
- **Production `keryx serve` registers no tools today.** It runs turns against a
  denying executor, so a stock listener never raises an approval. The routes,
  store and broker are live; approvals become reachable when a tool registry is
  injected into the turn.

## The lifecycle

| State | Meaning |
|---|---|
| `pending` | Waiting for an answer, inside its window. |
| `allowed` | Answered `allow`. The waiting call may run once. |
| `denied` | Answered `deny`. The waiting call does not run. |
| `expired` | The window elapsed unanswered; recorded as a denial. |
| `undeliverable` | No consumer was attached, or the record could not be written. |

The state is derived from files under `<config>/approvals/`: a request file, a
resolution file created exclusively (so exactly one writer wins across
concurrent answers and across processes), and a consumed marker created
exclusively (so a call runs at most once, restarts included). The records are
durable, but a turn does not survive a listener restart: on startup every
`pending` record is resolved as `expired` (reason `turn-not-running-at-startup`),
an `allowed` record that was never consumed is closed as abandoned, and the
stranded turn is finished as `expired`. Nothing is re-executed.

## List

```console
$ curl -s -H "Authorization: Bearer $KERYX_SERVE_TOKEN" \
    http://127.0.0.1:7377/v1/approvals
{
  "schemaVersion": "1.0.0",
  "approvals": [
    {
      "schemaVersion": "1.0.0",
      "approvalId": "0b6f2c1e-4a53-4e0e-9d55-6f1f3f3c9a10",
      "turnId": "…",
      "sessionId": "…",
      "summary": "Run tool \"write_note\" (risk: write)",
      "scope": "This one call to \"write_note\" only.",
      "consequence": "Changes files in the project.",
      "createdAt": "2026-09-29T12:00:00.000Z",
      "expiresAt": "2026-09-29T12:05:00.000Z",
      "state": "pending",
      "correlationId": "…"
    }
  ]
}
```

- Default is pending approvals only; `?state=all` adds the most recent resolved
  ones (bounded to 50 entries).
- The entry never carries the call's arguments and never the fingerprint. What
  you render is the summary, scope, consequence and expiry.
- **Listing is what counts as a consumer being attached.** Poll it. A consumer
  is considered attached for 60 seconds after its last list, event-stream read
  or streaming turn submission. This is a heuristic, not a delivery receipt:
  the listener cannot know a human saw the card.

## Answer

```console
$ curl -s -X POST \
    -H "Authorization: Bearer $KERYX_SERVE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"decision":"allow"}' \
    http://127.0.0.1:7377/v1/approvals/0b6f2c1e-4a53-4e0e-9d55-6f1f3f3c9a10
{
  "schemaVersion": "1.0.0",
  "approvalId": "0b6f2c1e-4a53-4e0e-9d55-6f1f3f3c9a10",
  "state": "allowed",
  "replay": false
}
```

The body is **exactly** `{"decision":"allow"}` or `{"decision":"deny"}`, as
`application/json`, at most 1 KiB. Any other field is refused with `400`, because
an extra field is how a caller would ask for a session grant or different
arguments, and an answer is neither.

| Status | Meaning |
|---|---|
| `200` | Answered. `state` is the outcome. `replay: true` means someone answered first and this is the **original** outcome, returned again; nothing executed. |
| `400` | Malformed body, a field other than `decision`, or a wrong content type. No state changed. |
| `403` | The `x-keryx-turn` header names the turn that raised the approval. A turn may not answer its own approval. |
| `404` | Unknown id, not an id, or not visible to this token. These cases are indistinguishable. |
| `410` | The approval expired and was denied. It cannot be revived. |
| `413` | Body over the bound. |

A second answer, allow or deny, gets `200` with the first answer's outcome. The
first valid answer applies once; later ones cannot change it.

## Bound to one call

The approval stores a fingerprint of the exact call (tool name plus canonical
input). When the turn resumes, the call it is about to run must match that
fingerprint, and the consumed marker must not exist. A different call, a changed
argument or a second execution finds no usable approval and is denied. The
fingerprint is compared and never displayed.

## Expiry and limits

Configured in `serve.json` under `approval` (see
`keryx serve config show`):

| Key | Default | Effect |
|---|---|---|
| `expirySeconds` | `300` | Window before an unanswered approval denies. |
| `maxPendingPerSession` | `4` | Beyond it, new asks are refused, never silently dropped. |
| `requireConsumer` | `true` | When true, an ask with no attached consumer is `undeliverable` at once. |

## What the self-grant check does and does not do

The token is one credential. The `403` fires when the caller **declares** the
turn's id in `x-keryx-turn`; it cannot stop a caller that lies about who it is.
What keeps the rule true is that a turn's own tools hold no serve token. The
local path is separate: a process that can run `keryx approvals allow` or write
the approvals store on this machine answers without a token and without this
check, so the store's directory is as sensitive as the token.

## Answering locally

The same store answers from the machine that runs the listener:

```console
$ keryx approvals list
$ keryx approvals allow <id>
$ keryx approvals deny <id>
```

In `keryx shell`, `/approvals` opens a modal with summary, scope, consequence,
expires-in and state, and `a` / `d` then `y` to answer. The sidebar shows a
single row with the pending count only while something is pending. Without the
TUI, `/approvals [list | allow <id> | deny <id>]` prints the same text.

`keryx approvals allow` does not ask for a TTY: it is an operator command,
excluded from the agent-callable descriptors, and shell calls by an agent remain
policy-gated.

## Not covered

- The Telegram or web card that renders an approval.
- Session-wide grants from a remote answer. A remote `allow` never sets one.
- Approvals for unattended trigger runs.

## Where to go next

- [Drive keryx from a bot](drive-keryx-remotely.md) — configure, token, start.
- [CLI reference › approvals](../cli-reference.md) — the local commands.
- [Choose an approval mode](permission-modes.md) — how `ask` arises at all.
