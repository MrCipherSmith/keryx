#!/bin/sh
# install.sh — first install of a self-hosted Keryx Team Hub.
#
#   curl -fsSLO https://github.com/MrCipherSmith/keryx/releases/download/v<version>/team-hub-install.sh
#   curl -fsSLO https://github.com/MrCipherSmith/keryx/releases/download/v<version>/SHA256SUMS
#   sha256sum -c --ignore-missing SHA256SUMS      # shasum -a 256 -c on macOS
#   sh team-hub-install.sh --version <version> --mode local
#
# What it does: checks Docker, downloads the release bundle and verifies it against the
# release's SHA256SUMS, generates independent tokens into an owner-only env file, writes
# the compose files and configs for the mode, pulls the image BY DIGEST, starts the Hub,
# waits until it is healthy, installs `hubctl` and the nightly backup entry, and prints
# what to do next.
#
# What it never does: run over an existing install (upgrades are `hubctl upgrade`),
# print a secret to a log, build anything, or remove a Docker volume.
set -eu
umask 077

RELEASE_REPO=MrCipherSmith/keryx

usage() {
  cat <<'EOF'
Usage: sh install.sh [options]

  --version <x.y.z|latest>   release to install (default: latest)
  --dir <path>               install directory (default: ~/keryx-team-hub)
  --mode local|https|cloudflare
                             local       the Hub on 127.0.0.1 only; reach it by SSH tunnel or VPN (default)
                             https       Caddy (Let's Encrypt) -> nginx edge -> Hub, on a public DNS name
                             cloudflare  Cloudflare Tunnel + Access -> nginx edge -> Hub, no inbound port
  --domain <name>            public DNS name (https, cloudflare)
  --acme-email <address>     Let's Encrypt contact (https; optional)
  --port <n>                 the Hub's loopback port on the host (default: 8787)
  --no-backup                do not install the nightly backup cron entry
  cloudflare mode also needs:
  --tunnel-id <uuid>         the tunnel's UUID
  --tunnel-credentials <file>  the tunnel's credentials JSON (one tunnel, not an account certificate)
  --access-team <name>       the Cloudflare Zero Trust team name
  --access-aud <hex>         the Access application's audience tag (64 hex characters)
  -h, --help
EOF
}

say() { printf 'install: %s\n' "$*" >&2; }
warn() { printf 'install: warning: %s\n' "$*" >&2; }
die() { printf 'install: error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found in PATH"; }
have_tty() { { : >/dev/tty; } 2>/dev/null; }

version=latest
dir=${HOME:-}/keryx-team-hub
mode=local
domain=
acme_email=
port=8787
backup=1
tunnel_id=
tunnel_creds=
access_team=
access_aud=

arg_value() { [ "$1" -ge 2 ] || die "$2 needs a value"; }
while [ $# -gt 0 ]; do
  case $1 in
    --version) arg_value $# "$1"; version=$2; shift ;;
    --dir) arg_value $# "$1"; dir=$2; shift ;;
    --mode) arg_value $# "$1"; mode=$2; shift ;;
    --domain) arg_value $# "$1"; domain=$2; shift ;;
    --acme-email) arg_value $# "$1"; acme_email=$2; shift ;;
    --port) arg_value $# "$1"; port=$2; shift ;;
    --no-backup) backup=0 ;;
    --tunnel-id) arg_value $# "$1"; tunnel_id=$2; shift ;;
    --tunnel-credentials) arg_value $# "$1"; tunnel_creds=$2; shift ;;
    --access-team) arg_value $# "$1"; access_team=$2; shift ;;
    --access-aud) arg_value $# "$1"; access_aud=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# --- validate the request before touching anything ---------------------------------------------
case $dir in
  /*) ;;
  *) dir=$(pwd)/$dir ;;
esac
dir=${dir%/}
printf '%s' "$dir" | grep -Eq '^/[A-Za-z0-9._/-]+$' \
  || die "the install directory may contain only letters, digits and . _ - / (got: $dir)"
printf '%s' "$port" | grep -Eq '^[0-9]{1,5}$' && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "--port must be 1-65535"

valid_domain() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' \
    && ! printf '%s' "$1" | grep -Eq '^[0-9.]+$' \
    && { [ "$1" = localhost ] || printf '%s' "$1" | grep -q '\.'; }
}
case $mode in
  local)
    [ -z "$domain$acme_email$tunnel_id$tunnel_creds$access_team$access_aud" ] \
      || die "--domain, --acme-email and the Cloudflare options do not apply to --mode local"
    ;;
  https)
    [ -n "$domain" ] || die "--mode https needs --domain (a public DNS name that points at this server)"
    valid_domain "$domain" || die "--domain must be a lower-case DNS name such as hub.example.com"
    [ -z "$tunnel_id$tunnel_creds$access_team$access_aud" ] || die "the Cloudflare options do not apply to --mode https"
    if [ -n "$acme_email" ]; then
      printf '%s' "$acme_email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "--acme-email is not an email address"
    fi
    ;;
  cloudflare)
    [ -n "$domain" ] && [ -n "$tunnel_id" ] && [ -n "$tunnel_creds" ] && [ -n "$access_team" ] && [ -n "$access_aud" ] \
      || die "--mode cloudflare needs --domain, --tunnel-id, --tunnel-credentials, --access-team and --access-aud"
    valid_domain "$domain" && [ "$domain" != localhost ] || die "--domain must be a lower-case DNS name such as hub.example.com"
    [ -z "$acme_email" ] || die "--acme-email does not apply to --mode cloudflare (Cloudflare terminates TLS)"
    printf '%s' "$tunnel_id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || die "--tunnel-id is not a tunnel UUID"
    printf '%s' "$access_team" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' || die "--access-team is the team name only (the part before .cloudflareaccess.com)"
    printf '%s' "$access_aud" | grep -Eq '^[0-9a-f]{64}$' || die "--access-aud must be the 64-character audience tag of the Access application"
    [ -f "$tunnel_creds" ] || die "--tunnel-credentials: no such file: $tunnel_creds"
    grep -Fq "$tunnel_id" "$tunnel_creds" || die "--tunnel-credentials does not mention tunnel $tunnel_id"
    ;;
  *) die "--mode must be local, https or cloudflare" ;;
esac

# --- prerequisites ----------------------------------------------------------------------------------
for tool in curl tar openssl awk sed gzip mktemp docker; do need "$tool"; done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "sha256sum (or shasum) is required"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running, and may this user use it?)"
compose_version=$(docker compose version --short 2>/dev/null || true)
compose_version=${compose_version#v}
case ${compose_version%%.*} in
  ''|*[!0-9]*) die "Docker Compose v2 is required ('docker compose version' failed). Install the compose plugin." ;;
  0|1) die "Docker Compose v2 is required (found $compose_version)" ;;
esac

# The Hub container runs as uid 1000 and refuses a credentials file it cannot read. On
# Linux that means the installing user is uid 1000 or root (who then hands the files
# over); Docker Desktop and OrbStack on macOS do not enforce host ownership.
uid=$(id -u)
if [ "$(uname -s)" = Linux ] && [ "$uid" != 0 ] && [ "$uid" != 1000 ]; then
  die "run this as uid 1000 or as root: the Hub container runs as uid 1000 and must be able to read its credential files (you are uid $uid)"
fi
own_for_hub() { if [ "$uid" = 0 ]; then chown -R 1000:1000 "$@"; fi; }

project=${KERYX_HUB_PROJECT:-keryx-team-hub}
printf '%s' "$project" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || die "KERYX_HUB_PROJECT is not a valid compose project name"

# --- refuse to run over an existing install --------------------------------------------------------------
for existing in current releases secrets hubctl backups; do
  [ ! -e "$dir/$existing" ] || die "$dir already holds an install ($existing exists). Upgrade it with: $dir/hubctl upgrade <version>"
done
if docker volume inspect "${project}_hub-data" >/dev/null 2>&1; then
  die "the Docker volume ${project}_hub-data already exists: an earlier install's data is there, and this installer will not guess whether to adopt or replace it. Remove the volume yourself only if you are sure it holds nothing you need"
fi
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null)" ]; then
  die "containers of the compose project '$project' already exist"
fi

# --- clean up after a failure that happened before anything was started ----------------------------------------
tmp=$(mktemp -d "${TMPDIR:-/tmp}/keryx-hub-install.XXXXXX")
created=""
dir_created=0
started=0
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  rm -rf "$tmp"
  if [ "$rc" -ne 0 ]; then
    if [ "$started" = 0 ]; then
      for entry in $created; do rm -rf "$entry"; done
      [ "$dir_created" = 0 ] || rmdir "$dir" 2>/dev/null || true
      printf 'install: failed before anything was started; nothing was left behind.\n' >&2
    else
      printf 'install: failed after the stack was started. Nothing was removed.\n' >&2
      printf 'install: look with: %s/hubctl ps   and   %s/hubctl logs\n' "$dir" "$dir" >&2
      printf 'install: stop it with: %s/hubctl stop   (the data volume is kept)\n' "$dir" >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --- download and verify -------------------------------------------------------------------------------------
base=${KERYX_HUB_RELEASE_BASE_URL:-https://github.com/$RELEASE_REPO/releases/download}
fetch() { curl -fsSL --proto '=https,file' --proto-redir '=https' --retry 3 --retry-delay 2 --connect-timeout 20 -o "$2" "$1"; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

if [ "$version" = latest ]; then
  [ -z "${KERYX_HUB_RELEASE_BASE_URL:-}" ] || die "'latest' cannot be resolved against KERYX_HUB_RELEASE_BASE_URL; name the version"
  url=$(curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 20 -o /dev/null -w '%{url_effective}' "https://github.com/$RELEASE_REPO/releases/latest") \
    || die "could not look up the latest release"
  version=${url##*/}
fi
version=${version#v}
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "'$version' is not a version (expected 1.2.3)"

say "installing Team Hub v$version, mode $mode, into $dir"
release_url=$base/v$version
mkdir "$tmp/dl"
fetch "$release_url/SHA256SUMS" "$tmp/dl/SHA256SUMS" \
  || die "could not download $release_url/SHA256SUMS — does v$version include the Hub?"
for asset in team-hub-install.tar.gz team-hub-image.txt; do
  fetch "$release_url/$asset" "$tmp/dl/$asset" || die "could not download $release_url/$asset"
  want=$(awk -v n="$asset" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }' "$tmp/dl/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS has no entry for $asset"
  [ "$want" = "$(sha256_of "$tmp/dl/$asset")" ] || die "checksum mismatch for $asset: refusing to install"
done
say "checksums match"
if tar -tzf "$tmp/dl/team-hub-install.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "the install bundle contains an unsafe path"; fi
mkdir "$tmp/dl/bundle"
tar -xzf "$tmp/dl/team-hub-install.tar.gz" -C "$tmp/dl/bundle" --strip-components=1
[ "$(cat "$tmp/dl/bundle/VERSION" 2>/dev/null || true)" = "$version" ] || die "the install bundle is not the bundle of v$version"
image=$(cat "$tmp/dl/team-hub-image.txt")
printf '%s' "$image" | grep -Eq '^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$' || die "team-hub-image.txt does not hold an image reference"
case $image in
  *@sha256:*) ;;
  *) warn "the image reference has no digest ($image); a release should pin one" ;;
esac

# --- lay out the install ------------------------------------------------------------------------------------------
if [ ! -d "$dir" ]; then mkdir -p "$dir"; dir_created=1; fi
for sub in secrets secrets/agents releases backups state log; do
  mkdir "$dir/$sub"
  chmod 700 "$dir/$sub"
done
created="$dir/secrets $dir/releases $dir/backups $dir/state $dir/log"

# Independent random values; the operator token is the human sign-in, the agent token is the
# Hub's unscoped bootstrap credential (clients get named, project-scoped keys instead).
operator_token=$(openssl rand -hex 32)
agent_token=$(openssl rand -hex 32)
[ "$operator_token" != "$agent_token" ] || die "the random generator returned the same value twice"
case $mode in
  local) origin= ;;
  *) origin=https://$domain ;;
esac
{
  printf '# Written by install.sh for Team Hub v%s. Owner-only. See hub.env.example in the release for every key.\n' "$version"
  printf 'KERYX_HUB_OPERATOR_TOKEN=%s\n' "$operator_token"
  printf 'KERYX_HUB_AGENT_TOKEN=%s\n' "$agent_token"
  printf 'KERYX_HUB_REVIEWER_TOKEN=\n'
  printf 'KERYX_HUB_MODE=%s\n' "$mode"
  printf 'KERYX_HUB_PUBLIC_ORIGIN=%s\n' "$origin"
  printf 'HUB_DOMAIN=%s\n' "$domain"
  printf 'ACME_EMAIL=%s\n' "$acme_email"
  printf 'HUB_PORT=%s\n' "$port"
  printf 'CF_TUNNEL_ID=%s\n' "$tunnel_id"
  printf 'CF_ACCESS_TEAM=%s\n' "$access_team"
  printf 'CF_ACCESS_AUD=%s\n' "$access_aud"
  printf 'KERYX_HUB_BACKUP_DAILY=14\n'
  printf 'KERYX_HUB_BACKUP_WEEKLY=8\n'
  if [ "$project" != keryx-team-hub ]; then printf 'KERYX_HUB_PROJECT=%s\n' "$project"; fi
} > "$dir/secrets/hub.env.new"
mv "$dir/secrets/hub.env.new" "$dir/secrets/hub.env"

# An empty named-agent list: the Hub refuses to start when it is configured with a file that is missing.
printf '{"agents":[]}\n' > "$dir/secrets/agents/agents.json"
chmod 600 "$dir/secrets/agents/agents.json"
own_for_hub "$dir/secrets/agents"

if [ "$mode" = cloudflare ]; then
  cp "$tunnel_creds" "$dir/secrets/tunnel.json"
  chmod 400 "$dir/secrets/tunnel.json"
  own_for_hub "$dir/secrets/tunnel.json"
fi

cp "$tmp/dl/bundle/hubctl" "$dir/hubctl"
chmod 755 "$dir/hubctl"
created="$created $dir/hubctl"
"$dir/hubctl" _stage "$tmp/dl/bundle" "$version" "$image"
ln -s "releases/v$version" "$dir/current"
created="$created $dir/current"

if ! docker image inspect "$image" >/dev/null 2>&1; then
  say "pulling $image"
  docker pull --quiet "$image" >/dev/null || die "could not pull $image"
fi

# --- start and wait ---------------------------------------------------------------------------------------------------
say "starting the Hub"
started=1
"$dir/hubctl" up
"$dir/hubctl" _wait 180 || die "the Hub did not become healthy"

if [ "$backup" = 1 ]; then
  "$dir/hubctl" schedule on || warn "the nightly backup was not scheduled; run '$dir/hubctl backup' from your own scheduler"
else
  say "no nightly backup (--no-backup). 'hubctl schedule on' turns it on later; 'hubctl backup' works at any time."
fi

# --- the operator token, once, on the terminal and nowhere else ----------------------------------------------------------
if have_tty; then
  {
    printf '\nOperator token (the sign-in for the Hub web UI; shown here once):\n\n  %s\n\n' "$operator_token"
    printf 'It is also stored, owner-only, in %s/secrets/hub.env. Do not paste it into a ticket or chat.\n\n' "$dir"
  } >/dev/tty
else
  say "no terminal here, so the operator token was not printed. Read KERYX_HUB_OPERATOR_TOKEN from $dir/secrets/hub.env (owner-only)."
fi

case $mode in
  local) url=http://127.0.0.1:$port ;;
  *) url=$origin ;;
esac
cat >&2 <<EOF

Team Hub v$version is running ($mode mode).

Next:
  1. Open $url and sign in with the operator token.
EOF
case $mode in
  local) printf '     From another machine: ssh -N -L %s:127.0.0.1:%s <this server>, then open http://127.0.0.1:%s there.\n' "$port" "$port" "$port" >&2 ;;
  https) printf '     The first certificate is issued on the first request; DNS for %s must point at this server and ports 80 and 443 must be open.\n' "$domain" >&2 ;;
  cloudflare) printf '     Cloudflare Access asks you to sign in first, then the Hub asks for the operator token.\n' >&2 ;;
esac
cat >&2 <<EOF
  2. Create a project, then Machines -> New pairing. It gives a one-use, expiring code. On the
     developer's machine:
       KERYX_PAIR_CODE=<code> keryx hub machine pair --url $url --code-env KERYX_PAIR_CODE
  3. For an agent that talks to the Hub over MCP or the API, issue it its own key:
       $dir/hubctl agent-key issue <agent-id> --project <project-id>
  4. $dir/hubctl status       shows the release, service health and the last backup.
     $dir/hubctl upgrade <version>   upgrades with a backup and an automatic rollback.
EOF
if [ "$backup" = 1 ]; then
  printf '  5. Backups are kept on THIS server (14 daily, 8 weekly) in %s/backups. Copy them off the server too.\n' "$dir" >&2
fi
