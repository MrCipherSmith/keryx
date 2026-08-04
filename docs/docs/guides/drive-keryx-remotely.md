# Drive keryx from a bot or another product

`keryx serve` is a second door into the same agent harness `keryx shell` uses —
a loopback HTTP listener, so a Telegram bot or a browser workspace becomes a
client of one surface instead of a second integration with its own copy of
session state.

**It is off until you configure and start it.** Every command below was
executed; the output is from those runs.

## Read this before you point anything at it

- **Approvals are not implemented.** A turn whose policy decision is `ask`
  terminates in a **recorded denial**. It is never auto-approved. If your
  product needs a human in the loop today, this is not ready for it.
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

Routes, all authenticated:

| Route | Purpose |
|---|---|
| `GET /v1/status` | listener state |
| `GET /v1/projects` | the projects this listener accepts turns for |
| `POST /v1/turns` | submit a turn; takes an idempotency key **scoped per project** |
| `GET /v1/turns/<id>` | the durable turn record and its SSE stream |

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

## Where to go next

- [Architecture › Remote entry](../architecture.md) — the ordered decision path,
  drawn, because the order is the control.
- [CLI reference › serve](../cli-reference.md) — every subcommand and flag.
