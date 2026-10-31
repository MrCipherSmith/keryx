# Self-hosting the Team Hub

The Team Hub is the shared server a team's Keryx installations connect to: projects, specifications, Flows, evidence and the remote-session control plane. It is one process with one SQLite file, shipped as a container image. This page installs it, upgrades it, backs it up and rolls it back with two scripts: `install.sh` (once) and `hubctl` (every day after that).

The Hub is released with the CLI. The `v<version>` tag that publishes the CLI also publishes the Hub, and the same `<version>` is the Hub's version.

## Choose a mode

| Mode | Reachable from | TLS | Who signs in | Choose it when |
|---|---|---|---|---|
| `local` | `127.0.0.1` of the server only | none (loopback) | operator token | you try the Hub, or already run SSH tunnels or a VPN |
| `https` | the internet, ports 80 and 443 | Caddy, Let's Encrypt | operator token | you have a DNS name and want no third party in front |
| `cloudflare` | Cloudflare only; no inbound port | Cloudflare | Cloudflare Access, then the operator token (optionally SSO) | the server sits behind NAT, or your team already uses Cloudflare Access |

```text
local        browser/CLI --SSH tunnel--> 127.0.0.1:8787 --> hub

https        internet --> caddy :80/:443 --> edge (nginx :8080) --> hub
                          (TLS, certificates)  (rate limits, headers, sockets)

cloudflare   Cloudflare Access --> tunnel (cloudflared) --> edge (nginx :8080) --> hub
                                   (validates the Access JWT)
```

In every mode the Hub also listens on `127.0.0.1:<port>` of the host (8787 by default). That is the recovery path over SSH, and the path for the CLI and agents that run on the same host. Only the `https` mode publishes anything on a public interface.

## What you need

- A Linux server (amd64 or arm64) with Docker Engine and Docker Compose v2 (`docker compose version`). macOS with Docker Desktop or OrbStack works for the `local` mode.
- On Linux, install as **uid 1000 or as root**. The container runs as uid 1000 and the Hub refuses a credentials file it cannot read; root hands the files over to uid 1000 itself. Other uids are refused on Linux. In a root install that hand-over has a consequence: **any account or process on the host that runs as uid 1000 has the Hub's own access** to `secrets/agents/` (it can issue or revoke agent keys) and, in `cloudflare` mode, to `secrets/tunnel.json`. Do not give uid 1000 to a user you would not give those to.
- `curl`, `tar`, `openssl`, and `sha256sum` or `shasum`.
- `https` mode: a DNS name pointing at the server and ports 80 and 443 free.
- `cloudflare` mode: a tunnel and an Access application you created in Cloudflare Zero Trust (the installer does not create them): the tunnel UUID and its credentials JSON, the team name, and the application's audience tag.

## Install

Download the installer and the release checksums, check them, then run it. Replace `<version>` with a release that contains the Hub.

```sh
base=https://github.com/MrCipherSmith/keryx/releases/download/v<version>
curl -fsSLO "$base/team-hub-install.sh"
curl -fsSLO "$base/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS      # macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
```

**Local:**

```sh
sh team-hub-install.sh --version <version> --mode local
```

**HTTPS with Caddy:**

```sh
sh team-hub-install.sh --version <version> --mode https \
  --domain hub.example.com --acme-email ops@example.com
```

**Cloudflare Tunnel:**

```sh
sh team-hub-install.sh --version <version> --mode cloudflare \
  --domain hub.example.com \
  --tunnel-id 00000000-0000-4000-8000-000000000000 \
  --tunnel-credentials ./tunnel-credentials.json \
  --access-team example-team \
  --access-aud <64-character audience tag of the Access application>
```

Other options: `--dir` (default `~/keryx-team-hub`), `--port` (the loopback port, default 8787), `--no-backup` (do not install the nightly backup cron entry) and `--version latest` (the default).

The installer checks Docker and Compose first and **refuses to run over an existing install or over an existing `<project>_hub-data` volume**. It then:

1. downloads the release bundle and the image reference and verifies both against the release's `SHA256SUMS`;
2. generates two independent tokens with `openssl rand -hex 32` into `secrets/hub.env` (mode 0600), and an empty `secrets/agents/agents.json`;
3. writes the compose files and configs for the mode into `releases/v<version>/` and points `current` at it;
4. pulls every image of the release (the Hub's **by digest**: an install refuses a release that names its image any other way), starts the stack, and waits until Docker reports it healthy;
5. installs `hubctl` and the nightly backup cron entry;
6. shows the **operator token once, on the terminal (`/dev/tty`)**, and never in a log. When there is no terminal it says so instead of printing it. The token is also in `secrets/hub.env`, which is owner-only; that file is what the Hub reads.

If it fails before starting anything it removes what it created. If it fails after the start it removes nothing and tells you how to look (`hubctl ps`, `hubctl logs`) and how to stop (`hubctl stop`).

### What is on disk

```text
~/keryx-team-hub/
  hubctl                       the operator tool (a copy of the current release's)
  current -> releases/v<x.y.z> the release that runs
  releases/v<x.y.z>/           compose files, rendered edge/Caddy/tunnel configs, image.ref
  secrets/hub.env              tokens and this install's settings          (0600)
  secrets/agents/agents.json   named agent keys, digests only              (0600, owner uid 1000)
  secrets/tunnel.json          cloudflare mode: the tunnel credential      (0400)
  backups/daily|weekly|upgrade-*|pre-restore-*
  state/ log/ tmp/
```

The data itself lives in the Docker volume `<project>_hub-data`: the SQLite database, and the Git state the Hub keeps under `/data/git` for delivery: bare caches of the remotes it delivered to, which grow with use and are rebuilt by fetching, and a small receipt per delivery operation (if one is missing, the Hub recovers the outcome from the operation marker on the remote). All of it is part of the volume, so of the full-volume backups; none of it is in the nightly online backups, which hold only the database. The project is `keryx-team-hub` unless the installer was run with `KERYX_HUB_PROJECT` set; it is recorded in `secrets/hub.env` and read **only from there**, so a variable left in your shell can never point `hubctl` at another install's volume. Every destructive prompt names the project and the volume it will act on.

## After the install

1. Open the URL the installer printed and sign in with the operator token.
2. Create a project.
3. **Machines → New pairing** gives a one-use, expiring code. On the developer's machine, with the full Keryx installed:

   ```sh
   KERYX_PAIR_CODE=<code> keryx hub machine pair --url https://hub.example.com --code-env KERYX_PAIR_CODE
   ```

   In `local` mode the URL is `http://127.0.0.1:8787` through an SSH tunnel (`ssh -N -L 8787:127.0.0.1:8787 <server>`). The Hub accepts remote-control traffic over plain HTTP only when it is reached as `localhost`.
4. Agents that talk to the Hub over the API or MCP get their own key, see below.
5. `~/keryx-team-hub/hubctl status` shows the release, the service health and the last backup.

## Security model per mode

What every mode shares: the Hub container runs as uid 1000 with a read-only root filesystem, no capabilities, `no-new-privileges`, memory and process limits, and rotating logs. Secrets are files with mode 0600 under a 0700 directory, never in argv and never in a log. Everything except the Hub image is pinned by digest. The Hub still enforces its own rules in every mode: human-only freeze and acceptance, project-scoped agent keys, idempotency, and TLS for remote control.

**`local`.** Nothing but the host can reach the Hub, so the server's own users and its SSH configuration are the perimeter. There is no TLS, which is why only loopback access works: use an SSH tunnel, or a VPN that you then terminate TLS for yourself. The operator token is only as safe as the account that owns `secrets/hub.env` and root on that host.

**`https`.** The Hub is on the internet behind two layers you can see. Caddy terminates TLS and renews the certificate. The nginx edge adds rate limits (20 requests/s per client, 5 sign-in attempts/minute per client with a burst of 10), `nosniff`, `no-referrer`, HSTS and `X-Frame-Options: DENY`, and a separate location for the machine and browser WebSockets with a one-hour timeout. The edge trusts `X-Forwarded-For` and `X-Forwarded-Proto` only from the private address ranges of the compose network, where its only client is Caddy, and Caddy overwrites whatever a client sent. The only sign-in is the operator token (with a second reviewer token if you set one), so treat it like a root password and keep it long and out of chat. There is **no SSO** in this mode and no second factor.

**`cloudflare`.** No inbound port is open. Cloudflare Access decides who reaches the Hub at all; `cloudflared` validates the Access JWT's signature, issuer and audience before the request leaves the tunnel; the edge refuses a request without the assertion header, applies the same rate limits and headers, and the Hub then asks for the operator token (or, with the optional overlay below, recognises the Access identity). The rate limit is keyed on the visitor's address (`CF-Connecting-IP`, believed only from the compose network, where `cloudflared` is the edge's one client). One limit to know: the CLI and machines cannot present a browser Access cookie, so connect them through the loopback port (SSH tunnel) or give them a Service Auth policy that you configure and verify yourself. The Hub does not configure Cloudflare for you.

## Keys and credentials

| Credential | Who holds it | How it is issued |
|---|---|---|
| Operator token | the people who sign in to the web UI | generated at install; the Hub reads it from `secrets/hub.env` |
| Machine enrolment | a developer's machine running the full Keryx | Machines → New pairing in the UI: a one-use, expiring code, then `keryx hub machine pair` |
| Agent key | one MCP or API client | `hubctl agent-key issue` |
| Bootstrap agent token | nobody | generated at install and kept only in `secrets/hub.env`; it is unscoped, so do not hand it out |
| Reviewer token | a second human reviewer | optional; add `KERYX_HUB_REVIEWER_TOKEN` (32+ characters, different from the others) to `secrets/hub.env` and run `hubctl up` |

### Agent keys

```sh
hubctl agent-key issue laptop-codex --project <project-id>[,<project-id>]   # add --read-only for a reader
hubctl agent-key list
hubctl agent-key issue laptop-codex --rotate      # a new key, same id, projects and access
hubctl agent-key revoke laptop-codex
```

`issue` prints the new key **once, on the terminal**, and refuses to run where there is none. Only its SHA-256 digest is stored. Give the key to that client as `KERYX_HUB_TOKEN` (see [Connecting clients to Hub MCP](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-mcp/clients.md)). The change is made inside a throwaway container of the Hub image, so the file is written by the Hub's own uid and checked by the Hub's own validator before it replaces the old one; the old file is kept as `agents.json.bak`. The Hub reads the file on every request: a new key works and a revoked one stops without a restart. The MCP surface offers no token administration; this is the only way keys are issued.

### Rotating the operator token

Replace the value of `KERYX_HUB_OPERATOR_TOKEN` in `secrets/hub.env` with a new `openssl rand -hex 32`, run `hubctl up`, and sign in again.

## Day to day

```sh
hubctl status                       # release, mode, service health, last backup
hubctl ps | logs [args] | stop | restart | up [service...]
hubctl config                       # validate the compose files (prints no secret)
hubctl schedule on|off|status       # the nightly backup entry in this user's crontab
```

`hubctl` has no `down`: removing the stack's volumes would delete the data. One operation at a time: `up`, `stop`, `restart`, `restage`, `backup`, `restore`, `upgrade`, `rollback` and `agent-key issue|revoke` take a lock, so none of them can start or stop the stack underneath another. A nightly backup that meets the lock skips its run and logs a warning.

Change the domain or the mode by editing `secrets/hub.env` and running `hubctl restage`. It re-renders the configs, checks that the compose files validate before changing anything, and applies the result: the Hub is updated if its settings changed, and the edge, proxy and tunnel containers are **recreated** (a config file that is replaced is not seen by a container that already has the old one mounted). `hubctl up` removes services that the current mode no longer defines, so leaving `https` for `local` takes Caddy off ports 80 and 443. To add your own compose settings, put them in `compose.override.yaml` beside `hubctl`; it is added to every call when it exists.

## Upgrade

```sh
~/keryx-team-hub/hubctl upgrade <version>        # or: latest
```

`upgrade` confirms (`--yes` skips the question), then:

1. downloads the release and verifies it against its `SHA256SUMS`, stages it under `releases/`, validates its compose files and **pulls every image it runs** (the edge, proxy and tunnel images as well as the Hub's), so a registry problem costs nothing;
2. stops the Hub gracefully (`docker compose stop`; a clean exit checkpoints the write-ahead log) — browser sessions and machine connections drop from here until the Hub is back, about a minute;
3. takes a **full backup of the data volume**, extracts it and runs `PRAGMA integrity_check` on the copy;
4. starts the **new image on a copy of the data** in a container with no network, a read-only root and throwaway tokens, and waits for Docker's `healthy` and a `200` from `/healthz`;
5. switches `current` with an atomic rename, starts the new release and verifies it the same way;
6. on success installs that release's `hubctl`.

If anything fails, it puts the old release back by itself. A failure before the switch just restarts the old Hub on its untouched data. A failure after the switch re-points `current`, makes sure the Hub container is **stopped**, **restores the full backup into the volume**, recreates the Hub on the old release and verifies it. Recovery runs with Ctrl-C ignored, so it cannot be cut off between emptying the volume and refilling it. The backup is kept as `backups/upgrade-<time>-<from>-to-<to>/hub-data.tar`; the backup that `rollback --restore-data` follows is changed only by an upgrade that finished. Run upgrades when nobody is mid-task.

## Rollback

```sh
hubctl rollback                    # back to the previous release; the data stays as it is
hubctl rollback --restore-data     # also restore the backup taken at the last upgrade (only straight after it)
```

A release's data changes are additive (new `remote_*` tables); an older release ignores tables it does not know, so a plain rollback keeps everything written since the upgrade. `--restore-data` throws that work away. It only follows a backup that was taken when leaving the release you are rolling back to, checks that backup before touching anything, asks you to confirm (the question names the project and volume), and first saves the data it replaces to `backups/pre-rollback-<time>/`. A release that stored data an older one would misread is the exception: the release notes say so, and then a plain rollback is the wrong tool. Once any rollback has run, `--restore-data` has nothing to restore; the upgrade's `hub-data.tar` can still be restored by hand with `hubctl restore`. If a rollback fails part-way, `hubctl` puts the release and the data back as they were.

## Backup and restore

The installer schedules `hubctl backup --quiet` at 03:17 server time (skip it with `--no-backup`; add it later with `hubctl schedule on`). Each run takes an online backup **without stopping the Hub**: SQLite serialises a consistent image, `hubctl` checks it (`PRAGMA integrity_check` and the `hub_state` row), compresses it, writes its SHA-256, renames it into place atomically, and rotates.

- **Kept on the server:** the 14 newest daily backups in `backups/daily/` and the 8 newest weekly ones in `backups/weekly/` (one per ISO week, the last of that week). Change the counts with `KERYX_HUB_BACKUP_DAILY` and `KERYX_HUB_BACKUP_WEEKLY` in `secrets/hub.env`.
- **They are on the same machine as the data.** A lost disk loses both. Copy `backups/` somewhere else on a schedule you own.
- They hold every project's content and the Hub's session records, though not the tokens. Files are mode 0600. The safety backups an upgrade, restore or rollback takes (`upgrade-*`, `pre-restore-*`, `pre-rollback-*`, full copies of the volume) are kept: the three newest, and **any younger than 14 days however many there are**, because the newest can be the only copy of the newest data. They are the big ones; remove older ones yourself when disk gets tight. `manual-*` backups are never pruned.
- An online backup holds the database in the Hub container's memory (limit 512 MB). Above about 150 MB `hubctl backup` refuses; use `hubctl backup --offline`, which stops the Hub and saves the whole volume as `backups/manual-<time>/hub-data.tar`.

Restore:

```sh
hubctl restore ~/keryx-team-hub/backups/daily/hub-20261030T031700Z.sqlite.gz
```

`restore` accepts a `.sqlite.gz` or `.sqlite` backup or the `.tar` of a full-volume backup. It verifies the checksum next to the file, decompresses it once and checks **that file** before touching anything, asks you to confirm (the question names the project and volume), stops the Hub and confirms it is stopped, saves the current data to `backups/pre-restore-<time>/hub-data.tar`, replaces the volume's contents from the checked file, recreates the Hub and verifies it. If any step fails, or the restored Hub does not become healthy, it stops the Hub again, puts the data it replaced back and starts the Hub.

You can restore over a damaged database, which is the case a restore is for: the copy of the current data is taken whatever state it is in. If that copy fails its integrity check, `hubctl` says so loudly, keeps it unchanged, and asks for one more confirmation (`--yes` gives it).

## Cloudflare SSO (optional, `cloudflare` mode only)

With the overlay the Hub recognises the Cloudflare Access identity, so an authorised person opens it without typing the operator token. Roles are an explicit email-to-role file on the server; an email that is not listed gets no session. See the [SSO requirements](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/hub-cloudflare-sso/specification.md) for the full rules.

```sh
cd ~/keryx-team-hub
mkdir -m 700 secrets/access
printf '[{"email":"owner@example.com","role":"operator"}]\n' > secrets/access/roles.json
chmod 600 secrets/access/roles.json
# as root, hand them to the Hub's uid:  chown -R 1000:1000 secrets/access
cp current/compose.access.example.yaml compose.override.yaml
./hubctl up
```

The issuer and audience come from `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` in `secrets/hub.env` (the values you gave the installer). To turn SSO off again, delete `compose.override.yaml` and run `hubctl up`; sign-in by operator token keeps working in both states.

## What is not offered

- **SSO without Cloudflare.** The `https` and `local` modes have the operator token and nothing else: no OIDC, SAML, passwords, user accounts or per-person roles. If you need single sign-on, use the `cloudflare` mode, or put your own authenticating proxy in front and accept that the Hub does not know it is there.
- **High availability.** One process, one SQLite file, one host. There is no replica and no clustering.
- **Off-site backups and monitoring.** Backups stay on the server; alerting is yours.
- **Automatic upgrades.** An upgrade happens when you run it.
- **Creating the Cloudflare tunnel or Access application.** The installer takes their identifiers.
- **Hosts other than Linux or macOS with Docker, and Linux users other than uid 1000 or root.** Rootless Docker is not tested.

## Releasing (maintainers)

Pushing a `v*` tag runs the existing release job first (the whole suite and gates, npm publish, the GitHub Release). The Hub job then runs after it, using the same version:

- packages the source archive and the Linux x64 binaries (`scripts/package-team-hub.ts`) and builds the image **from the extracted archive**, not the checkout;
- runs the image smoke, `docker compose config` for every mode, the rendered-config checks and the install/upgrade/rollback end-to-end script before publishing;
- pushes `ghcr.io/mrciphersmith/keryx-team-hub:<version>` (and `latest`, for non-prerelease versions) for `linux/amd64` and `linux/arm64`, with BuildKit provenance and SBOM attestations, then pulls the pushed digest anonymously and starts it;
- uploads `team-hub-prototype-source.tar.gz`, the two binaries, `team-hub-install.tar.gz`, `team-hub-install.sh`, `team-hub-image.txt` (the image reference pinned by digest) and `SHA256SUMS` to the Release.

`SHA256SUMS` guards against a corrupt or mismatched download. It does not prove who published the release, because it comes from the same place as the files; the image digest it covers is what the install then pins, and the attestations are visible with `docker buildx imagetools inspect ghcr.io/mrciphersmith/keryx-team-hub:<version>`.

The first time the package is published to GitHub Container Registry it may be private. The job fails at its anonymous-pull step in that case; make the package public once in its settings and re-run the job.

CI (`team-hub-distribution` in `ci.yml`) builds the image from the packaged archive on every pull request and runs the same checks, so a change that breaks the image fails before a tag does.
