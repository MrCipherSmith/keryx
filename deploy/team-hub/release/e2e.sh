#!/bin/sh
# End-to-end proof of install.sh and hubctl against a real Docker daemon.
#
#   sh deploy/team-hub/release/e2e.sh <hub image> [--platform linux/amd64]
#
# Uses the given Hub image as "v0.0.1" and retags it as a second release, so it needs no
# registry and no network beyond Docker itself. It serves fake releases from a local
# directory through KERYX_HUB_RELEASE_BASE_URL (file://), installs in `local` mode into a
# temporary directory under a throwaway compose project, and then exercises, in order:
#
#   install                 healthy, owner-only secrets, no token in the install log
#   backup / restore        online backup, checksum, weekly copy, restore of an older state
#   agent keys              issue (needs a terminal), use, list, revoke
#   schedule                the cron entry (through a crontab stand-in; yours is not touched)
#   upgrade / rollback      a clean upgrade, then rollback
#   failed upgrades         a new image that dies at start (caught by the trial, nothing
#                           changes) and one that only dies with a network (caught after the
#                           switch: automatic rollback with the pre-upgrade data restored)
#
# Everything it creates is removed at the end, including the throwaway compose project and its
# volume. It never touches another compose project, and it does not run `crontab` for real.
set -eu
umask 077

[ $# -ge 1 ] || { echo "usage: e2e.sh <hub image> [--platform <p>]" >&2; exit 2; }
image=$1
shift
platform=
while [ $# -gt 0 ]; do
  case $1 in
    --platform) [ $# -ge 2 ] || { echo "e2e: --platform needs a value" >&2; exit 2; }; platform=$2; shift ;;
    *) echo "e2e: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
deploy=$(CDPATH='' cd -- "$here/.." && pwd -P)
run=$$
E=$(mktemp -d "${TMPDIR:-/tmp}/team-hub-e2e.XXXXXX")
project=kth-e2e-$run
port=$(( 20000 + ($$ * 7919) % 20000 ))
base=http://127.0.0.1:$port
log=$E/install.log
tags="kth-e2e-$run-v2 kth-e2e-$run-dies kth-e2e-$run-nonet"

cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  # Only this run's own project and images.
  for pr in "$project" "${project}b"; do
    docker ps -aq --filter "label=com.docker.compose.project=$pr" | xargs docker rm -f >/dev/null 2>&1 || true
    docker volume rm -f "${pr}_hub-data" >/dev/null 2>&1 || true
    docker network rm "${pr}_default" >/dev/null 2>&1 || true
  done
  for t in $tags; do docker rmi -f "$t" >/dev/null 2>&1 || true; done
  [ "$rc" -eq 0 ] || echo "e2e: FAILED (exit $rc); the install log is kept at $log" >&2
  [ "$rc" -eq 0 ] && rm -rf "$E"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

steps=$E/steps.log
pass() { echo "e2e: ok: $*"; }
fail() {
  echo "e2e: FAIL: $*" >&2
  echo "e2e: the last output of the failing step:" >&2
  tail -n 40 "$steps" >&2 2>/dev/null || true
  exit 1
}
assert() { # assert <description> <command...>
  d=$1; shift
  echo "--- $d" >> "$steps"
  if "$@" >>"$steps" 2>&1; then pass "$d"; else fail "$d"; fi
}
eq() { # eq <description> <actual> <expected>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', wanted '$3')"; fi
}
refuse() { # refuse <description> <command...>: the command must fail
  d=$1; shift
  echo "--- $d" >> "$steps"
  if "$@" >>"$steps" 2>&1; then fail "$d (it succeeded)"; else pass "$d"; fi
}
count_files() { n=0; for f in "$@"; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

if [ -n "$platform" ]; then DOCKER_DEFAULT_PLATFORM=$platform; export DOCKER_DEFAULT_PLATFORM; fi

# --- fake releases ------------------------------------------------------------------------------
# A second tag of the same image, a copy that dies at start, and one that dies only when it has a network.
docker tag "$image" "kth-e2e-$run-v2"
printf 'FROM %s\nCMD ["bun","-e","process.exit(1)"]\n' "$image" | docker build -q -t "kth-e2e-$run-dies" - >/dev/null
printf 'FROM %s\nCMD ["sh","-c","if [ -d /sys/class/net/eth0 ]; then echo network-present; exit 1; fi; exec bun run src/hub/main.ts"]\n' "$image" \
  | docker build -q -t "kth-e2e-$run-nonet" - >/dev/null

publish() { # publish <version> <image>
  d=$E/releases/v$1
  mkdir -p "$d"
  sh "$here/bundle.sh" "$d" "$1" >/dev/null
  printf '%s\n' "$2" > "$d/team-hub-image.txt"
  ( cd "$d" && for f in team-hub-install.tar.gz team-hub-image.txt team-hub-install.sh; do
      if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f"; else shasum -a 256 "$f"; fi
    done > SHA256SUMS )
}
publish 0.0.1 "$image"
publish 0.0.2 "kth-e2e-$run-v2"
publish 0.0.3 "kth-e2e-$run-dies"
publish 0.0.4 "kth-e2e-$run-nonet"

KERYX_HUB_RELEASE_BASE_URL=file://$E/releases
KERYX_HUB_PROJECT=$project
export KERYX_HUB_RELEASE_BASE_URL KERYX_HUB_PROJECT

# A crontab stand-in: the real crontab is never read or written.
mkdir "$E/bin"
cat > "$E/bin/crontab" <<EOF
#!/bin/sh
f="$E/crontab.txt"
case "\${1:-}" in
  -l) [ -f "\$f" ] && cat "\$f" || { echo "no crontab for user" >&2; exit 1; } ;;
  -) cat > "\$f" ;;
  *) exit 2 ;;
esac
EOF
chmod 755 "$E/bin/crontab"
PATH="$E/bin:$PATH"; export PATH

hub=$E/hub
hubctl() { "$hub/hubctl" "$@"; }
env_value() { sed -n "s/^$1=//p" "$hub/secrets/hub.env" | tail -n 1; }

# --- install ----------------------------------------------------------------------------------------
sh "$deploy/install.sh" --version 0.0.1 --dir "$hub" --mode local --port "$port" > "$log" 2>&1 || { cat "$log" >&2; fail "install.sh failed"; }
operator=$(env_value KERYX_HUB_OPERATOR_TOKEN)
agent=$(env_value KERYX_HUB_AGENT_TOKEN)
assert "the Hub answers /healthz on the loopback port" curl -fsS --max-time 5 "$base/healthz"
refuse "the install log does not contain the operator token" sh -c "grep -q '$operator' '$log'"
refuse "the install log does not contain the bootstrap agent token" sh -c "grep -q '$agent' '$log'"
eq "the operator token is 64 characters" "${#operator}" 64
[ "$operator" != "$agent" ] || fail "the operator and agent tokens are equal"
eq "hub.env is 0600" "$(mode_of "$hub/secrets/hub.env")" 600
eq "agents.json is 0600" "$(mode_of "$hub/secrets/agents/agents.json")" 600
eq "current -> releases/v0.0.1" "$(readlink "$hub/current")" releases/v0.0.1
refuse "install.sh refuses to run over the install" sh "$deploy/install.sh" --version 0.0.1 --dir "$hub" --mode local --port "$port"
assert "hubctl status works" hubctl status
refuse "hubctl has no down" hubctl down
refuse "hubctl rollback has nothing to roll back to" hubctl rollback --yes

# --- data, backup, restore -----------------------------------------------------------------------------
cookie=
login() {
  cookie=$(curl -si --max-time 10 -X POST -H 'Content-Type: application/json' -d "{\"token\":\"$operator\"}" "$base/hub/v1/session" \
    | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -n 1)
  [ -n "$cookie" ] || fail "operator login returned no session cookie"
}
create_project() { # create_project <name> -> prints the id
  curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' -H "Cookie: $cookie" -H "Origin: $base" \
    -H "Idempotency-Key: e2e-$run-$1" -d "{\"name\":\"$1\"}" "$base/hub/v1/projects" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}
project_count() { curl -fsS --max-time 10 -H "Authorization: Bearer $agent" "$base/hub/v1/projects" | awk 'BEGIN{RS="\"id\":"} NR>1{n++} END{print n+0}'; }
login
first=$(create_project "e2e first")
[ -n "$first" ] || fail "could not create a project"
[ "$(project_count)" = 1 ] || fail "expected 1 project, got $(project_count)"

hubctl backup >>"$steps" 2>&1 || fail "hubctl backup failed"
# shellcheck disable=SC2012 # the names are timestamps this script just caused
b1=$(ls "$hub"/backups/daily/hub-*.sqlite.gz | head -n 1)
assert "the backup has a checksum file" test -f "$b1.sha256"
assert "the backup is gzip of a SQLite file" sh -c "gunzip -c '$b1' | head -c 15 | grep -q 'SQLite format 3'"
eq "the backup is 0600" "$(mode_of "$b1")" 600
assert "a weekly copy exists" sh -c "ls '$hub'/backups/weekly/hub-*.sqlite.gz"
sleep 1
create_project "e2e second" >/dev/null
eq "two projects before the second backup" "$(project_count)" 2
hubctl backup >>"$steps" 2>&1 || fail "second backup failed"
eq "two daily backups" "$(count_files "$hub"/backups/daily/hub-*.sqlite.gz)" 2

hubctl restore "$b1" --yes >>"$steps" 2>&1 || fail "restore failed"
eq "restore brought back the state of the first backup" "$(project_count)" 1
assert "a pre-restore safety backup was kept" sh -c "ls '$hub'/backups/pre-restore-*/hub-data.tar"
printf 'tampered' >> "$b1"
refuse "restore refuses a backup that does not match its checksum" hubctl restore "$b1" --yes
# shellcheck disable=SC2012
b2=$(ls "$hub"/backups/daily/hub-*.sqlite.gz | sort | tail -n 1)
hubctl restore "$b2" --yes >>"$steps" 2>&1 || fail "restore of the second backup failed"
eq "restored the later state too" "$(project_count)" 2

hubctl backup --offline >>"$steps" 2>&1 || fail "hubctl backup --offline failed"
assert "an offline backup holds the whole volume" sh -c "tar -tf '$hub'/backups/manual-*/hub-data.tar | grep -q 'hub.sqlite'"
assert "the Hub is healthy after an offline backup" curl -fsS --max-time 10 "$base/healthz"
eq "the offline backup lost nothing" "$(project_count)" 2

# --- schedule ----------------------------------------------------------------------------------------------
hubctl schedule on >>"$steps" 2>&1 || fail "schedule on"
hub_physical=$(CDPATH='' cd -P -- "$hub" && pwd -P)
assert "cron entry installed" sh -c "grep -q 'keryx-team-hub-backup:$hub_physical' '$E/crontab.txt' && grep -q 'backup --quiet' '$E/crontab.txt'"
hubctl schedule on >>"$steps" 2>&1
eq "scheduling twice leaves one entry" "$(grep -c keryx-team-hub-backup "$E/crontab.txt")" 1
hubctl schedule off >>"$steps" 2>&1
refuse "cron entry removed" sh -c "grep -q keryx-team-hub-backup '$E/crontab.txt'"

# --- agent keys (a key is shown on the terminal only) ------------------------------------------------------------
refuse "agent-key issue refuses without a terminal" hubctl agent-key issue e2e-agent --project "$first" </dev/null
# pty <out file> <command...>: run on a pseudo-terminal, keep its output in the file, return its exit status.
pty() {
  out=$1; shift
  python3 -c 'import os, pty, sys
sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))' "$@" > "$out" 2>&1 </dev/null
}
key_from() { tr -d '\r' < "$1" | awk '/^  [0-9a-f]{64}$/ { gsub(/ /, ""); print; exit }'; }
status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $1" "$base/hub/v1/projects"; }
pty "$E/key.txt" "$hub/hubctl" agent-key issue e2e-agent --project "$first" || fail "agent-key issue failed on a terminal: $(cat "$E/key.txt")"
key=$(key_from "$E/key.txt")
eq "a 64-character key was shown on the terminal" "${#key}" 64
rm -f "$E/key.txt"
eq "agents.json stays 0600" "$(mode_of "$hub/secrets/agents/agents.json")" 600
assert "agents.json.bak was kept" test -f "$hub/secrets/agents/agents.json.bak"
refuse "the raw key is not stored" sh -c "grep -q '$key' '$hub/secrets/agents/agents.json'"
eq "the new key works without a restart" "$(status_of "$key")" 200
assert "agent-key list shows it" sh -c "'$hub/hubctl' agent-key list 2>/dev/null | grep -q '^e2e-agent'"
refuse "agent-key list prints no key" sh -c "'$hub/hubctl' agent-key list 2>&1 | grep -q '$key'"
if pty "$E/dup.txt" "$hub/hubctl" agent-key issue e2e-agent --project "$first"; then fail "a duplicate id was accepted"; fi
assert "a duplicate id is refused for the right reason" sh -c "grep -q 'already exists' '$E/dup.txt'"
pty "$E/rotate.txt" "$hub/hubctl" agent-key issue e2e-agent --rotate || fail "rotate failed: $(cat "$E/rotate.txt")"
rotated=$(key_from "$E/rotate.txt")
eq "rotation shows a new 64-character key" "${#rotated}" 64
[ "$rotated" != "$key" ] || fail "rotation returned the same key"
eq "the old key stops working after rotation" "$(status_of "$key")" 401
eq "the rotated key works" "$(status_of "$rotated")" 200
key=$rotated
hubctl agent-key revoke e2e-agent >>"$steps" 2>&1 || fail "revoke failed"
eq "a revoked key is refused" "$(status_of "$key")" 401

# --- upgrade, rollback ----------------------------------------------------------------------------------------------
hubctl upgrade 0.0.2 --yes >>"$steps" 2>&1 || fail "upgrade to 0.0.2 failed"
eq "upgraded: current -> releases/v0.0.2" "$(readlink "$hub/current")" releases/v0.0.2
assert "the Hub is healthy after the upgrade" curl -fsS --max-time 5 "$base/healthz"
eq "no data lost by the upgrade" "$(project_count)" 2
assert "a full pre-upgrade backup exists" sh -c "ls '$hub'/backups/upgrade-*-v0.0.1-to-v0.0.2/hub-data.tar"
eq "the Hub container runs the new release's image" "$(docker inspect -f '{{.Config.Image}}' "$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hub)")" "kth-e2e-$run-v2"

# rollback --restore-data: back to the release AND the data from before the upgrade.
create_project "e2e written after the upgrade" >/dev/null
eq "three projects before the rollback" "$(project_count)" 3
hubctl rollback --restore-data --yes >>"$steps" 2>&1 || fail "rollback --restore-data failed"
eq "rolled back: current -> releases/v0.0.1" "$(readlink "$hub/current")" releases/v0.0.1
assert "the Hub is healthy after the rollback" curl -fsS --max-time 10 "$base/healthz"
eq "--restore-data brought back the data from before the upgrade" "$(project_count)" 2
assert "the data it replaced was saved first" sh -c "ls '$hub'/backups/pre-rollback-*/hub-data.tar"
refuse "a second --restore-data has no upgrade backup to restore" hubctl rollback --restore-data --yes

# A plain rollback keeps the data written since the upgrade.
hubctl upgrade 0.0.2 --yes >>"$steps" 2>&1 || fail "second upgrade to 0.0.2 failed"
eq "upgraded again: current -> releases/v0.0.2" "$(readlink "$hub/current")" releases/v0.0.2
create_project "e2e kept by a plain rollback" >/dev/null
eq "three projects before the plain rollback" "$(project_count)" 3
hubctl rollback --yes >>"$steps" 2>&1 || fail "rollback failed"
eq "rolled back: current -> releases/v0.0.1" "$(readlink "$hub/current")" releases/v0.0.1
assert "the Hub is healthy after the plain rollback" curl -fsS --max-time 10 "$base/healthz"
eq "a plain rollback keeps the data" "$(project_count)" 3

# An image that dies at start is caught by the trial: nothing changes and the Hub keeps running.
refuse "an image that dies at start is refused" hubctl upgrade 0.0.3 --yes
eq "the failed upgrade left current alone" "$(readlink "$hub/current")" releases/v0.0.1
assert "the Hub is running after the abandoned upgrade" curl -fsS --max-time 10 "$base/healthz"
eq "the abandoned upgrade lost nothing" "$(project_count)" 3

# An image that only dies with a network passes the trial (network-less), then fails after the switch:
# the upgrade rolls itself back and restores the pre-upgrade data.
create_project "e2e fourth" >/dev/null
eq "four projects before the last upgrade" "$(project_count)" 4
refuse "an image that fails after the switch is refused" hubctl upgrade 0.0.4 --yes
eq "automatic rollback: current is back on v0.0.1" "$(readlink "$hub/current")" releases/v0.0.1
assert "the Hub is healthy after the automatic rollback" curl -fsS --max-time 10 "$base/healthz"
eq "the automatic rollback restored the pre-upgrade data" "$(project_count)" 4

# --- the operator token is shown on a terminal, once ------------------------------------------------------------
# A second install into its own directory and compose project, run on a pseudo-terminal.
KERYX_HUB_PROJECT=${project}b; export KERYX_HUB_PROJECT
hub2=$E/hub2
pty "$E/tty-install.txt" sh "$deploy/install.sh" --version 0.0.1 --dir "$hub2" --mode local --port "$((port + 1))" --no-backup \
  || fail "the install on a terminal failed: $(cat "$E/tty-install.txt")"
operator2=$(sed -n 's/^KERYX_HUB_OPERATOR_TOKEN=//p' "$hub2/secrets/hub.env")
eq "the operator token appears once in what a terminal shows" "$(grep -c "$operator2" "$E/tty-install.txt")" 1
KERYX_HUB_PROJECT=$project; export KERYX_HUB_PROJECT

echo "e2e: every check passed"
