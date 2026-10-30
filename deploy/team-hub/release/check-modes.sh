#!/bin/sh
# Validate every Team Hub install mode from the bundle that ships.
#
#   sh deploy/team-hub/release/check-modes.sh <team-hub-install.tar.gz> [--no-images]
#
# For local, https and cloudflare (and cloudflare with the optional SSO overlay) it builds a
# throwaway install root, stages a release with the bundle's own hubctl (which renders the
# configs and runs `docker compose config`), and then checks the pieces the compose
# validation cannot see: that nothing builds, that everything but the Hub image is pinned by
# digest, that nginx accepts the rendered edge config, that Caddy accepts the Caddyfile and
# that cloudflared accepts the ingress rules. The last three run the pinned images and so need
# to pull them; --no-images skips them (offline use only; CI never does).
#
# Nothing is started and nothing is published. The tokens are random and exist only for this run.
set -eu
umask 077

[ $# -ge 1 ] || { echo "usage: check-modes.sh <team-hub-install.tar.gz> [--no-images]" >&2; exit 2; }
bundle_tar=$1
images=1
[ "${2:-}" != --no-images ] || images=0

tmp=$(mktemp -d "${TMPDIR:-/tmp}/team-hub-modes.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bundle"
tar -xzf "$bundle_tar" -C "$tmp/bundle" --strip-components=1
bundle=$tmp/bundle
failures=0
fail() { echo "check-modes: FAIL: $*" >&2; failures=$((failures + 1)); }
ok() { echo "check-modes: ok: $*"; }

# --- statics over the shipped files ---------------------------------------------------------
for f in "$bundle"/compose.*.yaml; do
  if grep -Eq '^[[:space:]]+build:' "$f"; then fail "$(basename -- "$f") builds an image; an install must not build"; fi
  # Every image except the Hub's own (supplied by the release's image.ref) is pinned by digest.
  unpinned=$(grep -E '^[[:space:]]+image:' "$f" | grep -v 'KERYX_HUB_IMAGE' | grep -v '@sha256:[0-9a-f]\{64\}' || true)
  [ -z "$unpinned" ] || fail "$(basename -- "$f") has an image that is not pinned by digest: $unpinned"
done
sh -n "$bundle/hubctl" && sh -n "$bundle/install.sh" && ok "hubctl and install.sh parse"
if sh "$bundle/hubctl" down >/dev/null 2>&1; then fail "hubctl accepted 'down'"; else ok "hubctl refuses 'down'"; fi

image_of() { sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$1" | grep "$2" | head -n 1; }
run_image() { # run_image <what> <docker run args...>
  what=$1; shift
  if out=$(docker run --rm "$@" 2>&1); then ok "$what"; else fail "$what: $out"; fi
}

for mode in local https cloudflare; do
  root=$tmp/$mode
  mkdir -p "$root/secrets/agents"
  printf '{"agents":[]}\n' > "$root/secrets/agents/agents.json"
  cp "$bundle/hubctl" "$root/hubctl"
  chmod 755 "$root/hubctl"
  {
    printf 'KERYX_HUB_OPERATOR_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'KERYX_HUB_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'KERYX_HUB_REVIEWER_TOKEN=\n'
    printf 'KERYX_HUB_MODE=%s\n' "$mode"
    printf 'HUB_PORT=8787\n'
    printf 'KERYX_HUB_PROJECT=team-hub-ci-%s\n' "$mode"
    case $mode in
      local) printf 'KERYX_HUB_PUBLIC_ORIGIN=\nHUB_DOMAIN=\nACME_EMAIL=\nCF_TUNNEL_ID=\nCF_ACCESS_TEAM=\nCF_ACCESS_AUD=\n' ;;
      https) printf 'KERYX_HUB_PUBLIC_ORIGIN=https://hub.example.com\nHUB_DOMAIN=hub.example.com\nACME_EMAIL=ops@example.com\nCF_TUNNEL_ID=\nCF_ACCESS_TEAM=\nCF_ACCESS_AUD=\n' ;;
      cloudflare)
        printf 'KERYX_HUB_PUBLIC_ORIGIN=https://hub.example.com\nHUB_DOMAIN=hub.example.com\nACME_EMAIL=\n'
        printf 'CF_TUNNEL_ID=00000000-0000-4000-8000-000000000000\nCF_ACCESS_TEAM=example-team\nCF_ACCESS_AUD=%s\n' "$(openssl rand -hex 32)"
        ;;
    esac
  } > "$root/secrets/hub.env"
  printf '{}\n' > "$root/secrets/tunnel.json"

  if sh "$root/hubctl" _stage "$bundle" 0.0.0-ci team-hub-ci:0 >"$tmp/stage.log" 2>&1; then
    ok "$mode: release staged, configs rendered, docker compose config validates"
  else
    fail "$mode: staging failed: $(cat "$tmp/stage.log")"
    continue
  fi
  ln -s releases/v0.0.0-ci "$root/current"
  rel=$root/releases/v0.0.0-ci

  # The optional SSO overlay joins the cloudflare chain as the operator's compose.override.yaml.
  if [ "$mode" = cloudflare ]; then
    mkdir -p "$root/secrets/access"
    cp "$rel/compose.access.example.yaml" "$root/compose.override.yaml"
    if sh "$root/hubctl" config >"$tmp/config.log" 2>&1; then ok "cloudflare + SSO overlay: docker compose config validates"; else fail "cloudflare + SSO overlay: $(cat "$tmp/config.log")"; fi
    rm -f "$root/compose.override.yaml"
  fi

  [ "$images" = 1 ] || continue
  case $mode in
    https|cloudflare)
      nginx=$(image_of "$rel/compose.$mode.yaml" nginx)
      run_image "$mode: nginx accepts the rendered edge.conf" --add-host hub:127.0.0.1 \
        -v "$rel/edge.conf:/etc/nginx/nginx.conf:ro" "$nginx" nginx -t
      ;;
  esac
  case $mode in
    https)
      caddy=$(image_of "$rel/compose.https.yaml" caddy)
      run_image "https: Caddy accepts the rendered Caddyfile" -v "$rel/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy" caddy validate --config /etc/caddy/Caddyfile
      ;;
    cloudflare)
      cloudflared=$(image_of "$rel/compose.cloudflare.yaml" cloudflared)
      run_image "cloudflare: cloudflared accepts the rendered ingress" -v "$rel/tunnel.yml:/etc/cloudflared/config.yml:ro" \
        "$cloudflared" tunnel --config /etc/cloudflared/config.yml ingress validate
      ;;
  esac
done

if [ "$failures" -ne 0 ]; then
  echo "check-modes: $failures check(s) failed" >&2
  exit 1
fi
echo "check-modes: every install mode validates"
