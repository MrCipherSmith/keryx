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
when both files below exist and are valid. With neither file it prints
`channels ready: connect Telegram from the shell with /channels` and serves exactly
as before, offering only the local `/channels` routes that connect it. A config that
is invalid, or a start Telegram refused, prints `remote control is off: <reason>`
instead. And a shell only mirrors a session after you type `/remote-control <name>`
in it.

### Connect from the shell (recommended)

Make a separate bot with BotFather and a supergroup with topics enabled, then run
`keryx serve` and, in any `keryx shell`, type `/channels` and choose **Connect**.

1. Paste the bot token. The field is hidden and the token goes only into
   `remote/bot-token` (mode 600), written by the shell; it is never sent to `serve`.
2. The modal shows a one-time code and the bot's name. Send the code to the bot in
   a private chat. The first message that carries it adds your Telegram user id to
   the allowlist; the code expires after 10 minutes and works once, so someone else
   writing to the bot cannot claim it.
3. Add the bot to your group as an administrator with the manage topics right. The
   group id is taken from that event, and a bot that is already in the group is
   picked up too. This step has its own 10 minutes, counted from the moment the
   code is accepted, and the modal shows how many are left. If the group has no
   topics or the bot lacks the right, the modal says which. Turning Topics on
   turns a basic group into a supergroup with a new id; the pairing follows that
   move by itself.
4. A test message arrives in the group's General topic and the channel reads
   Connected. `serve` starts using it without a restart.

A pairing that is finished while the modal is closed is not lost: reopen `/channels`
and **Resume** connects it. A mistyped token on a second Connect is refused and
leaves a pairing that is already open, with its code, untouched.

**Test** sends another message naming this machine. When the files are saved but
`serve` could not start Telegram (the modal reads "configured, but not running"),
**Retry** starts it again from them without erasing anything. **Disconnect** asks `serve` to
delete every topic and stop polling, then erases the token and the config; if
`serve` is not running it erases the files and says that the existing topics stay in
the group. The connection belongs to the machine: any shell can connect or
disconnect it, and sessions still opt in one by one with `/remote-control`. Use one
bot per machine, because Telegram allows one poller per token; the group can be
shared. The seven `/v1/remote/channels-*` routes (`status`, `pair`, `pairing`,
`cancel`, `reload`, `test`, `disconnect`) take the shell token like the other
`/v1/remote/*` routes and carry no secret: a pairing code, ids and a machine name
only.

### Setup by hand

The shell does this for you; the files are the same. All three inputs are needed. The files live in the user-global keryx directory
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
  `deregister`, `heartbeat`, `reply`, `approval`, `approval-ack`, `ack`, and `GET stream`) accept
  the shell token only, from a loopback connection. The serve bearer token does
  not reach them, and the shell token reaches nothing else. The shell token is
  new every time `serve` starts and the shell re-reads it on each request, so
  restarting `serve` needs nothing from you; a shell will not send it to an
  endpoint whose `serve` process is no longer running, and says remote control
  is unreachable instead.
- **`serve` proves it is `serve`.** The shell never sends the raw token: each
  request carries a fresh random nonce and an HMAC of it made with the token, and
  `serve` answers every shell route with a proof (the header
  `x-keryx-serve-proof`) over the nonce, the route, the status and the body. A shell
  that gets no proof, or a wrong one, from whatever listens on the port refuses the
  answer, writes nothing (no allowlist entry, no group id) and says to restart
  `keryx serve`. That also covers a `serve` from before this check. A process that
  took over the port after a crashed `serve` therefore cannot make the shell save
  its own Telegram id as the operator; the bearer it saw is useless after the next
  `serve` start.
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
  each message renders on its own; words and emoji are not cut.
- **Replies are formatted.** Messages go out as Telegram HTML (`parse_mode`
  `HTML`): `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, fenced blocks (with
  their language), headings, `>` quotes, `-` bullets and `[text](https://...)`
  links render as such. Only `http` and `https` links become links. Anything
  ambiguous or unclosed (`snake_case_name`, `a*b*c`, a lone `**`) stays as the
  literal text, and `&`, `<` and `>` in a reply are escaped, so a reply can never
  inject a tag. Telegram's 4096-character limit counts the text after it parses
  the markup, so tags do not use it up. If Telegram still refuses a message's
  markup (400 "can't parse entities"), that one message is sent again as plain
  text and `serve` records a `format-fallback` event. Approval prompts are sent as
  a code block, so what you approve is shown exactly. Tables, numbered and nested
  lists, task items and rules, and the `remote.rendering` setting that picks
  between HTML and native rich messages, are covered in
  [how replies look in Telegram](#how-replies-look-in-telegram).
- **Orphans and limits.** If a session stops sending heartbeats, its topic gets a
  notice and is deleted after 10 minutes (`orphanMs`); a heartbeat inside that
  window brings it back. A run started from Telegram has no time limit by default;
  set `runTimeoutMs` to a positive number of milliseconds and a run is interrupted
  after that long and the topic is told (`0`, or leaving it out, means no limit).
  Send `/stop` in the topic to end a run yourself. Both keys are optional integers
  in `config.json`, in milliseconds.
- **History.** A session that was driven from a topic records the topic and each
  span in its history: `keryx sessions list` shows a `⇄ remote <topic>` line under
  it, `--json` carries a `remote` field, and the `keryx shell -r` picker marks it
`⇄ remote`.

### How replies look in Telegram

A reply is rendered when it is sent, in one of four modes. The mode is the optional
`rendering` key of `remote/config.json` (`auto`, `rich`, `html` or `plain`; the default is
`auto`). Any other value is refused with a message that names the valid ones. Change it from
the shell with the **Telegram rendering** row of `/settings` or with `/rendering <mode>`; the
next message part picks it up, with no restart.

| Mode | What goes out |
|------|---------------|
| `auto` | A reply that holds a table goes as a native rich message (Bot API 10.1 and later, `sendRichMessage`); every other reply goes as HTML, exactly as before. |
| `rich` | Every reply goes as a rich message. |
| `html` | Telegram HTML (`parse_mode` `HTML`), the formatting described above. |
| `plain` | Plain text with the markup stripped. |

What each construct becomes:

- **Links** whose visible text reads as a web address for another host than the target show
  that host after the link, for example `https://mybank.example (→ evil.example)`, in HTML and
  in a rich message, so a label cannot pass for a different site. Any other link is unchanged.
- **Tables** are never sent as raw pipes. In HTML a table is an aligned `<pre>` block with the
  separator row dropped; in a rich message it is a native table block with a header row.
- **Ordered lists** keep their numbers, **nested bullets** keep their indentation, **task items**
  show a box or a ticked box, and a **rule** (`---`) shows as a line, in HTML and in rich.
- Text that holds none of these renders byte for byte as it did before.

Long replies are still split into numbered `(i/n)` parts within the limit of the mode in use
(4096 characters for HTML and plain, 32768 characters and 500 blocks for a rich message). A table is
never cut inside a row, and its header row is repeated at the top of the next part.

**The fallback chain.** A rich message is sent only where the Bot API accepts it, and the
shell does not assume it does. If Telegram refuses a rich message with a 4xx, the same text is
sent once as HTML; if Telegram then refuses the HTML markup (400 "can't parse entities"), it is
sent once as plain text. A reply is never dropped because of its format. A 403, 404 or 405 on the
rich call also pauses rich messages for ten minutes, so a bot that cannot use them does not pay a
failed call for every message. Network errors, 5xx and 429 are not a refusal of the format: they
are retried by the durable queue. An edit follows the same chain through `editMessageText` with
`rich_message`. Each fallback is recorded with its step, its reason (the bot token is never in
it) and the time; `/channels` shows the mode in effect and the last fallback.

To see what a mode produces without sending anything, run `keryx remote format-sample`. It
prints a fixed sample reply (a table, an ordered and a nested list, task items and a rule) as it
goes out in each mode, with no network call; `--mode <mode>` narrows it, `--full` prints the rich
message itself, and `--json` prints it for a script. The Bot API facts the rich path was built
against are in the spike note, `docs/requirements/keryx-telegram-rendering/spike.md`. Rich
messages have been checked against a fake Bot API only; the live check with a real bot is
pending.

### Permissions in a topic

A turn started from Telegram runs like a turn in the shell in `trust` mode: ordinary
commands inside the project run without a question, and every line that runs this way
is recorded as an `approval` event with the Telegram user id of the person who sent
the message. The things that always ask still ask, exactly as in a shell `trust` turn:
destructive commands, privilege escalation, downloaders, an agent's credential files,
a flow or acceptance confirmation, a git publish lease, a hook that asks, untrusted
content, a destructive `apply_patch`, and any MCP `use_tool`. `/plan` still refuses
mutations, and `apply_patch` outside the project root is refused in every mode. There
is no extra Telegram-only floor for network or outside-project commands.

When something asks, the question goes to the topic as `Allow | Always: <pattern> |
Deny`. The **Always** button is offered only when the same rules as the shell dock
accept the pattern, and it saves it to `permissions.json`; the topic then says
`Remembered: <pattern>`. A press from someone who is not allowed, a press after the
question expired, and a second press of the same button save nothing and approve
nothing. A saved or session pattern approves a matching command without a question,
with the same exclusions as the dock.

The question waits 15 minutes by default (`approvalTimeoutMs`, 30000 to 3600000
milliseconds, in `remote/config.json`). When it runs out the command is refused, and
the message says so. This wait is for Telegram only; the HTTP serve approval expiry
(`approval.expirySeconds` in `serve.json`) is unchanged.

Three optional keys of `remote/config.json` set the defaults, and `/remote-policy` in
the shell (or the **Telegram** group of `/settings`) changes them:

| Key | Default | Meaning |
|---|---|---|
| `permissionMode` | `trust` | `ask` or `trust`. With `ask`, the shell's own prompt rules apply to a Telegram turn. |
| `runTimeoutMs` | none | A positive number stops a run after that long. `0` or absent means no limit. |
| `approvalTimeoutMs` | `900000` | How long a question waits, 30000 to 3600000. |

To go back to the old behaviour set `"permissionMode": "ask"`, `"runTimeoutMs":
1800000` and `"approvalTimeoutMs": 300000`.

**One permission mode.** The shell has one permission mode. The config's
`permissionMode` applies to Telegram turns until `/mode` changes the mode in this
session; after that the shell's mode wins. `/mode ask` from the topic runs directly;
`/mode trust` and `/mode auto` keep their Yes / No button. `auto` is never taken from
the config. The shell shows which one is in force, `trust (Telegram default)` or `ask
(shell /mode)`, and `keryx serve status` says when the shell overrides the default.
`/remote-policy [mode ask|trust] [limit none|<minutes>] [wait <minutes>]` changes
the saved defaults and the running shell's copy only, not the mode you set with
`/mode`; a `serve` that is already running hands new values to shells that register
after its own restart or reload.

**Seeing and removing rules.** `keryx permissions list` and `keryx permissions remove
<number|pattern>` (or `/permissions` in the shell) show and take back what Always
saved. A rule is never added or removed from a topic. In the full-screen shell the
sidebar shows a posture line while remote control is on, and a click on it opens the
`/permissions` modal. `keryx serve status` (and `--json`) prints the posture with the
number of allowed users and no ids or secrets.

### Commands from the topic

A line that starts with `/` in the topic is not sent to the model. It goes through a
gateway that knows exactly which commands a topic may run; everything else is
refused with the reason, in the topic. Only an allowed sender can use any of it (see
the allowlist above), and the commands run in the shell, so they obey the same
policy as when typed there. The output that comes back is redacted the same way as a
reply, and a command never takes a secret as an argument or prints one.

Type `/` in the topic and Telegram's menu lists the same set (`/help` lists it too).
Telegram menu names cannot contain a hyphen, so `/external-agents` shows as
`/external_agents`; both are accepted.

| Kind | Commands | What happens |
|---|---|---|
| Text | `/status`, `/doctor`, `/new`, `/clear`, `/compact`, `/think auto\|expand\|hide`, `/goal`, `/queue`, `/reasoning`, `/theme <name>`, `/jevrules`, `/staledocs`, `/opencomments`, `/contract`, `/triage`, `/risk`, `/scenarios` | Runs in the shell as typed; the output comes back as a reply. Whether it worked is taken from the command itself, not from its wording. |
| Buttons | `/model`, `/connect`, `/resume` | Replies with a picker; the press does the switch. `/connect` shows providers that are already connected, then their models. No key or address is shown. |
| Built in | `/help`, `/sessions` | Answered without running anything in the shell. |
| Stop | `/stop` | Ends the run that is going in this topic. The topic gets `Stopped by you.` when the turn has ended. Nothing else is touched. |
| Asks first | `/mode`, `/plan`, `/delegate`, `/external`, `/external-agents` | See the confirmation rule below. |

**The confirmation rule.** A command that raises trust or sends work outside the
machine runs only after a Yes press in the topic:

- `/mode trust`, `/mode auto` and `/plan off` ask **Yes / No**. Reading the mode,
  `/mode ask`, bare `/plan` (it shows the mode) and `/plan on` do not ask.
- `/delegate <agent> <task>`, `/external on|off` and `/external-agents on|off` ask a
  question that names the agent, says it is an **external** agent and that the work
  is **paid**. The button reads `Yes, send to <agent> (paid)`. The step that applies
  an external patch, `/external apply <hash>`, is not available here: the hash is
  typed in the shell.
- **No**, or no press before the question expires, changes nothing. The shell's
  `/remote-control` panel (Commands tab) lists a question that is still waiting.
- The message you typed keeps its "running" reaction until the question is answered
  or has expired. If the delegated task is longer than 200 characters the question
  shows it shortened and says so, with the full length; the full task is what runs.

**Pickers and buttons.** A button carries a short single-use token, never a command
or a name, so it cannot be forged or replayed. It is bound to the session, the
message and the person it was sent to, expires, and is never mixed up with an
approval button. After a press, the message is edited in place to show what was
chosen and the buttons go away; approval messages are edited the same way.

**Approval answers are confirmed by the shell.** When you press Allow or Deny,
`serve` writes the answer to the shell's stream and waits 5 seconds for the shell
to post `approval-ack`. The ack says whether the answer was applied to a question the
shell was still waiting on. With an applied ack, the message ends "Allowed by user N at ..." or
"Denied by user N at ..." and the short reply is "Approval granted." or "Approval
denied.". If the shell had no question waiting for that id (it timed out, or the
session reconnected), the ack says so and the message ends "Not applied at <time>: the
shell was no longer waiting for this question, so the Allow from user N changed
nothing."; the shell's transcript says the same and never says it allowed anything.
A shell older than this field sends an ack without it, which means only that the frame
was received, and the message ends "Allowed" as before. Without it the message ends "Sent to the shell at <time>, not confirmed;
the shell denies by itself if it did not receive it." and the short reply says the
answer was sent but not confirmed. That wording is about an answer the shell never
received: its own approval question then times out as a denial. An Allow that the
shell received after the 5 seconds is still applied there, and the topic keeps
saying not confirmed, because a late ack changes nothing. Pressing again during the wait does nothing, a
closed stream stops the wait at once, and an ack that arrives after the wait is
accepted and changes nothing. The shell acks every approval frame, including a
repeat of one it already handled, and does not apply a repeat twice. While an ack
has not gone through, `/remote-control` shows "Approvals not confirmed: N" and the
sidebar row reads "<topic> · N unconfirmed".

**These commands stay in the shell.** `/exit`, `/quit`, `/channels`, `/provider`,
`/search-provider`, `/search-connect`, `/remote-control`, `/integrate`, `/copy`,
`/game`, `/setup`, `/mcp`, `/guard`, `/route`, `/editguard`, `/settings`, `/bus`,
`/review`, `/reviews`, `/product`, `/governance`, `/expand`, `/interrupt` (use `/stop`),
`/permissions`, `/remote-policy`, `/demote`, `/models`, `/external-diff`, `/flows`, `/ac`, `/workspace`,
`/approvals`, `/decisions`, `/triggers`, `/routing`, `/schedules`, `/jevprofile`, `/schedule`,
`/rewind`, `/conform` and `/ci`. Bare `/theme` and bare `/think` (and `/think
collapse`) are refused too; use `/theme <name>` or `/think auto|expand|hide`. They
ask for a key, change a safety guard or where work is routed, edit another tool's
configuration, open a panel, a form or a picker that exists only in the shell, or
would close the shell. `/mcp trust`, `/guard`,
`/route` and `/editguard` are deliberately local. The topic is told which command
was refused and why.

**While a turn runs.** The shell refuses `/new`, `/clear`, `/resume`, `/sessions`,
`/compact`, `/model` and `/connect`, and the topic says
`main is busy: command deferred`; nothing is queued behind it. A command that runs is answered with a
short notice if it takes a while. A command from the topic never cancels the turn
you are running in the shell: one that outlasts the limit is only no longer waited
for, the topic is told it is still running in the shell, and it is left alone.

**`/new` and `/clear` keep the topic.** The topic stays bound to the running shell,
gets one separator line (`--- new session ---`), and the session history records
the change. No second topic is created and none is deleted. `/resume` offers the
earlier sessions as buttons and returns to the one you press
(`--- resumed session ---`). Typing `/new` in the shell still ends remote control
as before.

**Message state.** Each message you send shows its state as a reaction on the
message: received (eyes), accepted into the session (thinking), running
(lightning), finished (thumbs up), refused or failed (thumbs down; Telegram does
not allow a cross mark as a reaction). A new state replaces the old one. While a
turn runs the topic also shows "typing", refreshed about every 4 seconds, and it
stops when the turn ends. If the bot is not allowed to react in the group, the
reactions turn off for good with one `reactions-unavailable` event in `serve`, and
the typing indicator still works. A failed reaction call never delays or blocks a
message.

In the full-screen shell, the `/remote-control` modal has a **Commands** tab with
the recent commands from the topic, including refused ones and confirmations nobody
has answered yet. A command that came from Telegram is echoed in the transcript as
`tg ❯ /model`.

Out of scope for now: voice, files and photos, entering credentials, several shells
in one topic, and the shell's games and editors.

### What is not verified

This was built and tested against a fake Bot API, in process. It has not been run
against real Telegram: topic creation, the supergroup permissions, the button
callbacks and the 409 behaviour are as the Bot API documents them, not as observed.
Run it with a throwaway bot and group first.

## Where to go next

- [Architecture › Remote entry](../architecture.md) — the ordered decision path,
  drawn, because the order is the control.
- [CLI reference › serve](../cli-reference.md) — every subcommand and flag.
