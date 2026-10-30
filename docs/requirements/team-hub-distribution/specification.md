# Self-hostable Team Hub: release, install, upgrade and backup

Status: draft for a Hub Flow. The owner creates the Flow from this text and freezes its criteria; freezing is a human action and this draft does not perform it.

## Problem

Team Hub runs in one place today: a private instance set up by hand. Its configuration is kept, scrubbed, in `deploy/team-hub/geekom/`, and everything that matters happened by hand over SSH: the image was built on the server from a copied source archive, upgrades were a sequence of commands typed from memory, and backups were taken when someone remembered. A team that wants its own Hub has to reproduce that from a runbook and a working knowledge of the maintainer's server.

The image has also shipped broken once. It was built without a module the Hub imports and exited at start, and every test was green, because the tests run the Hub from the checkout and the image is built from a different list of files.

## Expected Outcome

A team installs its own Hub on a server it controls with one documented command, keeps it current with one command, and can restore it from a backup the server has been making by itself. The Hub's image and install tooling are published by the same tag that publishes the CLI, and a change that would produce an image that cannot start fails a pull request instead of a user.

## Decisions already taken

- Distribution is its own change on top of `feat/team-hub-remote-sessions`.
- The Hub is versioned with the CLI: the existing `v*` tag also releases the Hub, with the same version.
- Three install modes: `local` (loopback only, reached by SSH tunnel or VPN), `https` (Caddy with Let's Encrypt, then an nginx edge, then the Hub; operator-token sign-in, no SSO) and `cloudflare` (Cloudflare Tunnel and Access, then the nginx edge, then the Hub).
- Backups are kept on the server: 14 daily and 8 weekly.
- Machines are enrolled by pairing code in the Hub web UI; MCP agent keys are issued with `hubctl agent-key`. Token administration is deliberately not exposed over MCP.

## Scope

- A Hub job in the release workflow: archive, Linux binaries, multi-architecture image with attestations, install bundle, checksums.
- A CI job that builds the image from the packaged archive, starts it, and validates every install mode.
- `install.sh` for the first install and `hubctl` for operation, upgrade, rollback, backup, restore and agent keys.
- Compose overlays and configs for the three modes.
- The deployment documentation page.

## Acceptance Criteria

Each criterion names how it is checked. "On a Docker host" means a Linux or macOS machine with Docker and Compose v2 and no other Hub installed.

### Release

1. Pushing a tag `v<version>` that passes the existing release job publishes `ghcr.io/mrciphersmith/keryx-team-hub:<version>` for `linux/amd64` and `linux/arm64`, with a provenance attestation and an SBOM attached to the image index (`docker buildx imagetools inspect` lists both platforms and the attestations). `latest` is tagged for a release version and is not moved by a prerelease version (one containing `-`).

2. The same run uploads to the GitHub Release: the source archive, the `linux-x64` server and client binaries, the install bundle, the standalone installer, a file naming the image by digest, and a `SHA256SUMS` whose every entry verifies (`sha256sum -c`). The image in that file is the one that was published: pulling it by digest with no credentials succeeds, and the container starts and answers `/healthz` with 200.

3. The image is built from the extracted source archive, not from the checkout. Removing from the archive a file the image needs makes the build or the start check fail.

4. The Hub job runs only after the existing job has succeeded, so a tag whose verification or npm publish fails publishes no Hub. The workflow still has no manual trigger. The job's permissions are `contents: write` and `packages: write` and no others, and every added third-party action is pinned to a commit.

### CI guard

5. A pull-request job builds the image from the packaged archive, starts it with throwaway tokens and fails unless `/healthz` returns 200. Introducing a Hub import that the archive or the Dockerfile omits turns the job red.

6. The same job runs `docker compose config` for `local`, `https`, `cloudflare` and `cloudflare` with the SSO overlay, and fails for any of them that does not validate. It also checks that nothing builds an image, that every image other than the Hub's is pinned by digest, and that the rendered nginx, Caddy and cloudflared configs are accepted by the pinned images they run on.

### Install

7. On a Docker host, `install.sh --mode local` installs and starts the Hub, and waits until it is healthy. The Hub listens on `127.0.0.1` of the host and on no other interface. `secrets/hub.env` is mode 0600 and holds two independent 64-hex-character tokens. The operator token is written to the terminal once, and does not appear in the installer's output, in any file other than `secrets/hub.env`, or in the process list (`ps`) at any time. With no terminal, the installer says that it did not print the token.

8. `install.sh` downloads the bundle and the image reference and verifies them against `SHA256SUMS` before it writes anything; a corrupted download aborts the install. It refuses to run over an existing install and over an existing Hub data volume, and a failure before the stack starts leaves nothing behind.

9. `install.sh --mode https --domain <name>` publishes ports 80 and 443 and no other port on a public interface. A request that did not arrive over TLS never reaches the Hub. Bursts of sign-in attempts from one client are answered 429 while other clients are unaffected. The security headers of the previous edge are present, and an idle browser WebSocket stays open for longer than 60 seconds. An `X-Forwarded-For` or `X-Forwarded-Proto` sent by a client does not change how the edge treats the request, because the proxy replaces both. A certificate is issued by Let's Encrypt for the domain (verified manually on a real domain).

10. `install.sh --mode cloudflare` opens no inbound port. A request that reaches the edge without the Access assertion header is answered 403. The rendered tunnel configuration is accepted by `cloudflared tunnel ingress validate`. A browser sign-in through Cloudflare Access reaches the Hub (verified manually against a real tunnel and Access application).

### Operation

11. `hubctl upgrade <version>` downloads and verifies the release, stops the Hub gracefully, takes a full backup of the data volume and checks that backup (`PRAGMA integrity_check` on an extracted copy), starts the new image on a copy of the data in a container with no network, switches `current` atomically, starts the release and verifies that it is healthy. After it, the Hub's data is unchanged (the same projects and Flows are listed), and a pre-upgrade backup exists.

12. If the new image cannot start on a copy of the data, `hubctl upgrade` leaves the old release as `current`, restarts the old Hub, and the data is unchanged. If the new release fails after the switch, `hubctl upgrade` re-points `current`, restores the pre-upgrade backup, starts the old release and verifies that it is healthy, without operator action. Both are demonstrated by an automated test that injects the failure.

13. `hubctl rollback` returns to the previous release and keeps the data; `hubctl rollback --restore-data` also restores the backup taken at the last upgrade, after confirmation, having first saved the data it replaces.

14. The nightly backup runs without stopping the Hub, checks the copy (integrity and the `hub_state` row), writes a checksum, renames atomically, and keeps the 14 newest daily and 8 newest weekly backups. Files are mode 0600. The cron entry is installed by default and not installed with `--no-backup`; installing it twice leaves one entry.

15. `hubctl restore <file>` verifies the file's checksum and the database before touching the Hub's data, refuses a file that does not match its checksum, saves the current data first, and leaves a healthy Hub with the restored state. An automated test restores an older backup and sees the older state.

16. `hubctl agent-key issue` prints the new key once, to the terminal, and refuses to run without one. Only the key's SHA-256 digest is stored. The file is replaced atomically with mode 0600, validated by the Hub's own validator first, and the previous version is kept as `agents.json.bak`. The new key is accepted by the running Hub without a restart and is limited to its projects and read-only flag; `revoke` makes it stop working on the next request; a duplicate id is refused. `list` shows ids, projects, access and a digest prefix, never a key.

17. `hubctl` has no command that removes volumes; `down` is refused. It serialises its own operations, so a nightly backup that starts during an upgrade skips its run and exits successfully.

### Hygiene and documentation

18. The scripts pass `sh -n` and `shellcheck`. No secret appears in any command line, log or file other than the owner-only env file and the agent key file. The repository contains no real hostname, e-mail address, account or tunnel identifier in anything added by this change.

19. `docs/docs/team-hub-deployment.md` exists, is linked from the documentation index and the site navigation, and passes the documentation link check. It covers the three modes and the security model of each, installation, upgrade, backup and restore, rollback, how machines are enrolled and agent keys are issued, and states plainly that single sign-on is not offered without Cloudflare.

20. Nothing in `deploy/team-hub/geekom/`, in the existing source-build `compose.yaml`, in `src/`, or in the packaging allowlist of `scripts/package-team-hub.ts` is changed by this work, and the existing packaging tests still pass.

## Out of Scope

- Single sign-on outside Cloudflare Access (OIDC, SAML, passwords, user accounts, per-person roles).
- High availability, replication, clustering, or a database other than the single SQLite file.
- A hosted Hub operated for other people, or a first-run wizard.
- Off-site or encrypted backup storage, and monitoring or alerting.
- Automatic upgrades.
- Creating Cloudflare tunnels, Access applications or DNS records.
- Token administration over MCP.
- Kubernetes or Helm packaging, Windows hosts, rootless Docker, and Linux users other than uid 1000 or root.
- Any change to the Hub's code or its protocol.
- Moving the existing private instance onto this tooling.
- Signing of release artifacts beyond checksums and image attestations.
