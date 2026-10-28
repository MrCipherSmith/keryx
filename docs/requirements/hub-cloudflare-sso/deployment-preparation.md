# Geekom SSO deployment preparation

## Scope and prepared configuration

Target: the existing private test prototype at `https://hub.example.com`.
Compose project: `keryx-team-hub`; installation root:
`/home/<user>/keryx-team-hub`. No other application, system cloudflared service,
DNS record, Access policy, or tunnel credential needs changing.

These instructions do not constitute evidence that activation occurred.
Record the actual release, checks, and browser smoke separately.

- `deploy/team-hub/geekom/compose.access.yaml` is optional. Copying it to the
  physical release root enables SSO when the updated `hubctl` runs.
- `hubctl` derives a unique image tag from the physical release directory,
  preserving the previous release's image. Base deployments without this
  overlay remain SSO-disabled.
- Host directory `secrets/access` mounts read-only at `/run/keryx-access`.
  Mounting the directory makes atomic replacements of `roles.json` visible.
  Compose refuses to create a missing host directory automatically.
- `edge.conf` applies the login throttle to both `/hub/v1/session` and
  `/hub/v1/session/cloudflare`, preserving Authorization so the Hub can enforce
  Bearer precedence. Native Cloudflare Access verification and the edge JWT
  presence guard remain enabled; no public Access bypass is introduced.

## Package and stage without activation

Use an exact committed candidate. The source packager reads the current files,
so check that the runtime inputs match that commit before packaging.
The source archive excludes Geekom overlays and these SSO documents; transfer
the overlays separately as shown.

On the Mac, from the prototype checkout:

```sh
release_id="$(git rev-parse --short=12 HEAD)-sso"
release_out="/tmp/keryx-hub-$release_id"
bun scripts/package-team-hub.ts --out "$release_out"
ssh <server> "mkdir -p ~/keryx-team-hub/releases/$release_id"
scp "$release_out/team-hub-prototype-source.tar.gz" \
  "$release_out/SHA256SUMS" \
  "<server>:keryx-team-hub/releases/$release_id/"
scp deploy/team-hub/geekom/compose.geekom.yaml \
  deploy/team-hub/geekom/compose.access.yaml \
  deploy/team-hub/geekom/edge.conf \
  deploy/team-hub/geekom/tunnel.yml \
  "<server>:keryx-team-hub/releases/$release_id/"
scp deploy/team-hub/geekom/hubctl \
  <server>:keryx-team-hub/hubctl.sso-candidate
```

On Geekom, substitute the exact candidate directory name printed above:

```sh
hub_root="$HOME/keryx-team-hub"
release_id="REPLACE_WITH_CANDIDATE_DIRECTORY"
candidate="$hub_root/releases/$release_id"
cd "$candidate"
sha256sum -c SHA256SUMS
tar -xzf team-hub-prototype-source.tar.gz --strip-components=1
export KERYX_HUB_RELEASE_TAG="$release_id"
docker compose --project-directory "$candidate" -p keryx-team-hub \
  --env-file "$hub_root/secrets/hub.env" \
  -f "$candidate/deploy/team-hub/compose.yaml" \
  -f "$candidate/compose.geekom.yaml" \
  -f "$candidate/compose.access.yaml" build hub
```

Do not run `up` yet. Do not print expanded `docker compose config` or container
environment values: they include bootstrap credentials. `config --quiet` is safe.

## Roles and configuration

On Geekom, create only the dedicated role mapping. This contains no login token:

```sh
install -d -m 700 "$HOME/keryx-team-hub/secrets/access"
python3 - <<'PY'
import json, os, pathlib
directory = pathlib.Path.home() / "keryx-team-hub/secrets/access"
temporary = directory / "roles.json.new"
temporary.write_text(json.dumps([
    {"email": "owner@example.com", "role": "operator"}
]) + "\n")
os.chmod(temporary, 0o600)
temporary.replace(directory / "roles.json")
PY
```

The current server user and container runtime user are UID/GID 1000. Preserve
directory mode 700 and file mode 600; do not loosen permissions to fix a mount.
Future role changes use the same atomic replacement procedure. The Hub rereads
the mapping on authenticated requests; invalid or missing mappings fail closed.

The optional overlay fixes the trusted issuer and application audience:

```text
KERYX_HUB_ACCESS_ENABLED=true
KERYX_HUB_ACCESS_ISSUER=https://example-team.cloudflareaccess.com
KERYX_HUB_ACCESS_AUDIENCE=<CLOUDFLARE_ACCESS_AUD>
KERYX_HUB_ACCESS_ROLES_FILE=/run/keryx-access/roles.json
```

The audience is a public identifier. Bootstrap tokens remain in the existing
protected `secrets/hub.env`; do not copy them into a release or a report.

## Activation and checks

Before changing `current`, save its resolved path and the installed `hubctl`.
Stop only Hub briefly for a consistent SQLite directory backup, including WAL
files; do not remove the volume. Keep edge and tunnel running.

```sh
hub_root="$HOME/keryx-team-hub"
backup="$hub_root/backups/sso-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup/data"
readlink -f "$hub_root/current" > "$backup/previous-release.txt"
cp "$hub_root/hubctl" "$backup/hubctl"
"$hub_root/hubctl" stop hub
docker cp keryx-team-hub-hub-1:/data/. "$backup/data/"
ln -s "$candidate" "$hub_root/current.sso-next"
mv -Tf "$hub_root/current.sso-next" "$hub_root/current"
install -m 700 "$hub_root/hubctl.sso-candidate" "$hub_root/hubctl"
"$hub_root/hubctl" config --quiet
"$hub_root/hubctl" up -d --no-build hub edge
"$hub_root/hubctl" ps
```

`candidate` must still name the verified physical candidate release. If an
intermediate step fails while Hub is stopped, preserve the backup and restore
service before continuing. Never use `down -v`, force-reset data, or restart the
system cloudflared service.

Verify, recording status codes without logging secrets:

1. Loopback `/healthz` returns 200 and `/hub/v1/auth/config` enables SSO.
2. A fake Access assertion cannot establish a Hub session.
3. Existing agent Bearer requests through loopback/SSH still work.
4. Anonymous public requests still redirect to Cloudflare Access.
5. The existing authenticated browser enters Hub without a second token and
   shows the mapped email and role. A legacy token session should be signed out
   to exercise the actual SSO exchange.
6. Invalid Bearer plus a human cookie does not fall back to the human identity.
7. Review-bundle Select/Delivery requests return
   `409 review-bundle-not-deliverable` and invoke no Git publication.
8. Logout clears the Hub session and reaches the fixed Cloudflare logout URL.

The browser's real Access credential is not an application fixture. Do not copy
it from browser storage, print it, or fabricate a successful production smoke.

## Recovery and rollback

Keep Cloudflare's outer policy and native tunnel verification enabled.
Use existing human Bearer API access through SSH/loopback for recovery, not an
SSO-enabled browser token form.

Preferred rollback disables SSO on the **new runtime**, preserving the review
bundle safety guards. Create a separate override in the candidate release:

```sh
cat > "$candidate/compose.access.off.yaml" <<'YAML'
services:
  hub:
    environment:
      KERYX_HUB_ACCESS_ENABLED: "false"
YAML
"$hub_root/hubctl" -f "$candidate/compose.access.off.yaml" up -d --no-build hub
```

Record this override and continue including it on subsequent commands until SSO
is repaired. This restores the original Hub token login behind Cloudflare.
Existing SSO sessions fail closed while SSO is disabled.

Do not downgrade to the original runtime after review bundles have been stored:
that runtime ignores `purpose` and could treat a bundle as an integration tree.
A code rollback must retain the bundle guards or first establish a separately
reviewed safe recovery plan. Restoring an old database would discard later user
work and is not a routine rollback step.

## Preparation verification

- `sh -n deploy/team-hub/geekom/hubctl`: passed.
- Base + Geekom + SSO overlay `docker compose config --quiet` with dummy
  credentials and a unique candidate image tag: passed.
- Updated Nginx configuration tested using `nginx -t` in the existing pinned
  edge image with a temporary `/tmp` file, then removed: passed. No reload or
  live configuration replacement occurred during this check.
- Live services remained healthy during preparation.

Routing audit: `graph_used: yes` (navigation only; graph predates concurrent
source additions), `wiki_used: yes` (index; no Hub deployment page),
`ctx_used: yes`, `raw_rg_used: no`.
