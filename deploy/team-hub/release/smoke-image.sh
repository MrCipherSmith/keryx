#!/bin/sh
# Start a Team Hub image with throwaway tokens and fail unless /healthz answers 200.
#
#   sh deploy/team-hub/release/smoke-image.sh <image> [--platform linux/amd64]
#
# This is the check that the image was once missing: it shipped without a module the Hub
# imports and exited at start, and nothing noticed until someone ran it. It asserts what a
# user depends on before anything is published: the process stays up, /healthz answers 200,
# and the embedded web app is served. It runs the image the way the install runs it
# (non-root, read-only root filesystem, no capabilities), with fresh random tokens and
# nothing mounted from the host.
set -eu
umask 077

[ $# -ge 1 ] || { echo "usage: smoke-image.sh <image> [--platform <platform>]" >&2; exit 2; }
image=$1
shift
platform=
while [ $# -gt 0 ]; do
  case $1 in
    --platform) [ $# -ge 2 ] || { echo "smoke: --platform needs a value" >&2; exit 2; }; platform=$2; shift ;;
    *) echo "smoke: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/team-hub-smoke.XXXXXX")
name=team-hub-smoke-$$
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Two independent throwaway values, never reused outside this run.
{
  printf 'KERYX_HUB_OPERATOR_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'KERYX_HUB_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)"
} > "$tmp/env"

# shellcheck disable=SC2086 # --platform is either empty or one word plus its value
docker run -d --name "$name" ${platform:+--platform "$platform"} \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
  --user 1000:1000 --env-file "$tmp/env" -p 127.0.0.1::8787 "$image" >/dev/null

port=
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != true ]; then
    echo "smoke: the container exited before /healthz answered:" >&2
    docker logs "$name" >&2 2>&1 || true
    exit 1
  fi
  port=$(docker port "$name" 8787/tcp 2>/dev/null | head -n 1 | sed 's/.*://')
  if [ -n "$port" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/healthz" || true)" = 200 ]; then
    break
  fi
  port=
  sleep 1
done
if [ -z "$port" ]; then
  echo "smoke: /healthz did not answer 200 within 90 s:" >&2
  docker logs "$name" >&2 2>&1 || true
  exit 1
fi

body=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz")
[ "$body" = '{"ok":true}' ] || { echo "smoke: /healthz answered 200 with an unexpected body: $body" >&2; exit 1; }
page=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/")
printf '%s' "$page" | grep -qi '<html' || { echo "smoke: / did not serve the embedded web app" >&2; exit 1; }
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/hub/v1/projects")" != 401 ]; then
  echo "smoke: the API answered an unauthenticated request with something other than 401" >&2
  exit 1
fi

# A start that dies a moment later (a lazily imported module, a failed migration) is not a start.
sleep 3
if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
  echo "smoke: the container exited after answering /healthz:" >&2
  docker logs "$name" >&2 2>&1 || true
  exit 1
fi
echo "smoke: $image started, /healthz answered 200, the web app is served, the API refuses anonymous requests"
