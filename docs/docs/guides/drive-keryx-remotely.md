# Drive keryx from a bot or another product

`keryx serve` is a second door into the same agent harness `keryx shell` uses —
a loopback HTTP listener, so a Telegram bot or a browser workspace becomes a
client of one surface instead of a second integration with its own copy of
session state.

**It is off until you configure and start it.** Every command below was
executed; the output is from those runs.

## Read this before you point anything at it

- **Approvals are asynchronous and fail closed.** A turn whose policy decision is
  `ask` raises a durable pending approval and detaches; it runs the call only
  after a person answers `allow`, once, for that call. Unanswered means denied.
  See [Answer a remote approval](answer-remote-approvals.md). Today the stock
  listener registers no tools, so it raises none; approvals apply once a tool
  registry is injected.
- **The remote policy profile may never be weaker than the local one.** It is
  compared per turn and a weaker profile is refused.
- **The prompt is scanned but reaches the provider unredacted.** Only outbound
  content is redacted.
- **No route accepts a secret.**

## 1. Configure

```console
$ keryx serve config show
  no serve configuration was found. Run `keryx serve config init` to create one.

$ keryx serve config init
  ✓ wrote ~/.local/share/keryx/serve.json
  enabled:    true
  bind:       127.0.0.1:7377
  profile:    remote-restricted
  credential: auth-json ref …
  approvals:  expire after 300s, max 4 pending per session
  non-loopback acknowledged: false
  No credential yet. Run `keryx serve token issue` — the token is printed once and never again.
```

The configuration is **user-global**, not per project — one listener serves the
projects in your registry.

## 2. See the state machine refuse

```console
$ keryx serve status
  state:      refused
  bind:       127.0.0.1:7377 (loopback)
  profile:    remote-restricted
  credential: absent
  pending approvals: 0

  • no serve credential exists. Run `keryx serve token issue` …
```

`refused` is **terminal and binds no socket**. It is never a degraded listen:
a listener that cannot satisfy its configuration does not open a port.

## 3. Issue a token

```console
$ keryx serve token issue
  token: <printed once>
  • This is shown once. It is stored only as a salted hash and cannot be recovered.
  the serve configuration now references this credential

$ keryx serve status
  state:      configured
  credential: present (fingerprint 70d73561)
```

`rotate` replaces it; `revoke` removes it and the state returns to `refused`.

## 4. Register the projects it may serve

```console
$ keryx projects list
```

`keryx init` registers a project automatically. A request naming an
unregistered project is refused — there is no fallback to "some other project".

## 5. Start it

```console
$ keryx serve
```

Routes. Every one is authenticated, but not with the same secret: the six below
take the serve bearer token, and the `/v1/remote/*` routes (next section) take
only the local shell token and refuse the bearer.

| Route | Purpose |
|---|---|
| `GET /v1/status` | listener state |
| `GET /v1/projects` | the projects this listener accepts turns for |
| `POST /v1/turns` | submit a turn; takes an idempotency key **scoped per project** |
| `GET /v1/turns/<id>` | the durable turn record and its SSE stream |
| `GET /v1/approvals` | pending approvals a person can answer |
| `POST /v1/approvals/<id>` | answer one: `{"decision":"allow"\|"deny"}` |

## The properties your integration can rely on

- **Authentication runs before routing.** One fixed `401` on every path and
  method, so an unauthenticated caller cannot tell a known route from an
  unknown one — and cannot even cause a request body to be read.
- **Bearer tokens are compared in constant time**, and only a salted hash is
  stored.
- **Idempotency keys are scoped per project**, so two projects cannot collide
  on one key.
- **Repeated authentication failures are throttled**, per peer.

And one absence: **`GET /health` does not exist.** There is no PID file either,
so `keryx serve status` reports *configuration* state only — a listener running
in another process is not visible to it. Liveness is authenticated-only, over
`GET /v1/status`.

## Verify

```console
$ keryx serve status
```

`configured` means it will bind when started. `refused` means it will not, and
the reason is printed underneath it — read that line rather than retrying.

## Remote control from Telegram

`/remote-control` in a running `keryx shell` mirrors that session into its own
topic of a Telegram supergroup. A line you send in the topic runs in the shell as
if you had typed it there (it shows as `tg ❯` in the transcript, and `[tg]` in the
queue panel), and the reply, plus any approval question with Allow and Deny
buttons, comes back to the same topic. It is a client of this listener, not a
second bot runtime: the shell never talks to Telegram.

**It is off by default**, at two levels. `keryx serve` starts remote control only
when both files below exist and are valid; without them it prints
`remote control is off: <reason>` and serves exactly as before. And a shell only
mirrors a session after you type `/remote-control <name>` in it.

### Setup

All three inputs are needed. The files live in the user-global keryx directory
(`~/.local/share/keryx/` on Linux and macOS, `%APPDATA%\keryx` on Windows), under
`remote/`.

1. **A separate bot.** Make a new bot with BotFather, not one you already use for
   something else. Put its token on one line in `remote/bot-token` and run
   `chmod 600` on it. A token file readable by anyone else, or one that does not
   look like a token, is refused, and the message names the file, never the token.
2. **The allowlist.** `remote/config.json` holds the Telegram user ids whose
   messages and button presses are accepted:

   ```json
   {
     "schemaVersion": 1,
     "chatId": -1001234567890,
     "allowedUserIds": [123456789]
   }
   ```

   Anyone else is ignored. The ignored sender's id and the time go to
   `remote/rejected.jsonl`; what they wrote is not stored. The schema is closed:
   an unknown key, including a token pasted into the wrong file, is an error.
3. **A supergroup with topics.** Enable topics in the group, add the bot as an
   administrator and give it the manage topics right. `chatId` above is that
   group's id.

Start `keryx serve` and the shell as usual. In the shell, `/remote-control
<name>` creates the topic (the name defaults to `<project>-<short session id>`),
`/remote-control status` shows its state and recent events, and
`/remote-control off` removes it. In the full-screen shell the same control is the
sidebar row and the `/remote-control` modal. The readline shell can only report
that it is off.

### How it behaves

- **One poller.** The Telegram transport is a single long-poll loop inside
  `keryx serve`. Shells reach it over loopback with the local shell token, which
  `serve` creates; a shell cannot poll Telegram. A second `keryx serve` on the
  same token meets a conflict from Telegram and stops polling for good instead of
  taking updates from the first.
- **Two secrets, two route tables.** The `/v1/remote/*` routes (`register`,
  `deregister`, `heartbeat`, `reply`, `approval`, `ack`, and `GET stream`) accept
  the shell token only, from a loopback connection. The serve bearer token does
  not reach them, and the shell token reaches nothing else. The shell token is
  new every time `serve` starts and the shell re-reads it on each request, so
  restarting `serve` needs nothing from you; a shell will not send it to an
  endpoint whose `serve` process is no longer running, and says remote control
  is unreachable instead.
- **Nothing is replayed or lost across a restart of `serve`.** No Telegram offset
  is stored; `serve` drops an update id it has already seen, and a lower id than
  ones seen (Telegram restarted its numbering) is delivered, not swallowed. At most
  500 lines can wait undelivered in one topic; past that the topic gets a status
  line with the count.
- **Only the final answer goes to the topic.** Text the model writes before a tool
  call is narration and stays in the shell.
- **Turning it off is explicit about what is dropped.** Queued Telegram lines are
  removed from the shell queue, the shell prints which, and the topic is told
  before it is deleted. Removing one queued line with `/queue` tells its topic
  too; `/queue edit` keeps its origin so the answer still goes to Telegram.
- **Long replies are split.** A reply over 4096 characters (Telegram's limit,
  counted in UTF-16 units) goes out as numbered messages, `(1/3)`, `(2/3)`, ...,
  in order. A fenced code block that crosses a boundary is closed and reopened, so
  each message renders on its own; words and emoji are not cut. Messages carry no
  parse mode, so plain text is sent and nothing is escaped.
- **Orphans and limits.** If a session stops sending heartbeats, its topic gets a
  notice and is deleted after 10 minutes (`orphanMs`); a heartbeat inside that
  window brings it back. A run started from Telegram is interrupted after 30
  minutes (`runTimeoutMs`) and the topic is told. Both are optional integers in
  `config.json`, in milliseconds.
- **History.** A session that was driven from a topic records the topic and each
  span in its history: `keryx sessions list` shows a `⇄ remote <topic>` line under
  it, `--json` carries a `remote` field, and the `keryx shell -r` picker marks it
`⇄ remote`.

### What is not verified

This was built and tested against a fake Bot API, in process. It has not been run
against real Telegram: topic creation, the supergroup permissions, the button
callbacks and the 409 behaviour are as the Bot API documents them, not as observed.
Run it with a throwaway bot and group first.

## Where to go next

- [Architecture › Remote entry](../architecture.md) — the ordered decision path,
  drawn, because the order is the control.
- [CLI reference › serve](../cli-reference.md) — every subcommand and flag.
