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
#   install                 under dash with no terminal (dash is /bin/sh on Debian and Ubuntu);
#                           healthy, owner-only secrets, no token in the install log or in argv
#   refusals                no terminal to confirm on, an image without a digest, newlines in
#                           inputs, a lock held by another operation, a project named by the shell
#   backup / restore        online backup, checksum, weekly copy, restore of an older state,
#                           restore OVER a corrupted database, and a restore the Hub cannot start
#                           on (the data it replaced must come back, on a stopped Hub)
#   agent keys              issue (needs a terminal), use, list, rotate, revoke
#   schedule                the cron entry (through a crontab stand-in; yours is not touched),
#                           and that two installs whose paths share a prefix keep their own lines
#   upgrade / rollback      a clean upgrade, rollback with and without the data
#   failed upgrades         a new image that dies at start (caught by the trial, nothing
#                           changes) and one that only dies with a network (caught after the
#                           switch: automatic rollback with the pre-upgrade data restored)
#
# Everything it creates is removed at the end, including the throwaway compose projects and their
# volumes. It never touches another compose project, and it does not run `crontab` for real.
# No secret is put on a command line here: tokens travel through files and pipes.
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
tags="kth-e2e-$run-v2 kth-e2e-$run-dies kth-e2e-$run-nonet kth-e2e-$run-old-reader"

cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  # Only this run's own projects and images.
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
# refuses_saying <description> <fragment> <command...>: the command must fail AND say the fragment,
# so a refusal for the wrong reason (or a silent exit) does not pass.
refuses_saying() {
  d=$1; frag=$2; shift 2
  echo "--- $d" >> "$steps"
  if out=$("$@" 2>&1); then fail "$d (it succeeded)"; fi
  printf '%s\n' "$out" >> "$steps"
  case $out in *"$frag"*) pass "$d" ;; *) fail "$d (it failed, but not saying '$frag')" ;; esac
}
count_files() { n=0; for f in "$@"; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# Secrets never go on a command line here (a command line is world-readable in ps): a secret that has to
# be looked for or sent travels in a file this function writes with a shell builtin.
secret_file=$E/.secret
has_secret() { # has_secret <file> <secret>: does the file contain the secret?
  printf '%s\n' "$2" > "$secret_file"
  grep -qF -f "$secret_file" "$1"
}
count_secret() { printf '%s\n' "$2" > "$secret_file"; grep -cF -f "$secret_file" "$1" || true; }
output_has_secret() { # output_has_secret <secret> <command...>
  printf '%s\n' "$1" > "$secret_file"; shift
  "$@" 2>&1 | grep -qF -f "$secret_file"
}
bearer_header() { printf 'Authorization: Bearer %s\n' "$1" > "$E/.header"; }

# A shell for the cases that matter on Debian and Ubuntu, where /bin/sh is dash, and a way to run
# a command with no controlling terminal whatever terminal this script was started from.
dash_bin=$(command -v dash || command -v sh)
notty() { python3 -c 'import subprocess, sys
sys.exit(subprocess.run(sys.argv[1:], stdin=subprocess.DEVNULL, start_new_session=True).returncode)' "$@"; }
# pty <out file> <command...>: run on a pseudo-terminal, keep its output in the file, return its exit status.
pty() {
  out=$1; shift
  python3 -c 'import os, pty, sys
sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))' "$@" > "$out" 2>&1 </dev/null
}

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

# An actual old-writer gate, independently of the candidate application version.
mkdir -p "$E/old-reader"
cat > "$E/old-reader/check.sh" <<'OLDREADER'
#!/bin/sh
set -eu
bun -e 'import { Database } from "bun:sqlite"; import { existsSync } from "node:fs";
if (existsSync("/data/hub.sqlite")) { const db = new Database("/data/hub.sqlite", { readonly: true });
if (db.query("SELECT name FROM sqlite_master WHERE name=?").get("remote_schema_version")) {
 const row = db.query("SELECT version FROM remote_schema_version").get();
 if (row?.version > 2) { console.error("Unsupported remote schema version"); process.exit(42); }
} db.close(); }'
exec bun run src/hub/main.ts
OLDREADER
printf 'FROM %s\nCOPY --chmod=0444 check.sh /app/old-reader.sh\nCMD ["sh","/app/old-reader.sh"]\n' "$image" > "$E/old-reader/Dockerfile"
docker build -q -t "kth-e2e-$run-old-reader" "$E/old-reader" >/dev/null
publish 0.0.5 "kth-e2e-$run-old-reader"

# The served images are local tags with no digest. install.sh and hubctl refuse that unless this
# test-only variable says otherwise; the refusal itself is checked below.
KERYX_HUB_ALLOW_UNPINNED_IMAGE=1
# A failure injection should not wait the production two minutes for "healthy".
KERYX_HUB_VERIFY_SECONDS=60
KERYX_HUB_RELEASE_BASE_URL=file://$E/releases
KERYX_HUB_PROJECT=$project
export KERYX_HUB_ALLOW_UNPINNED_IMAGE KERYX_HUB_VERIFY_SECONDS KERYX_HUB_RELEASE_BASE_URL KERYX_HUB_PROJECT

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

# --- install: dash, no terminal -----------------------------------------------------------------------
notty "$dash_bin" "$deploy/install.sh" --version 0.0.1 --dir "$hub" --mode local --port "$port" > "$log" 2>&1 || { cat "$log" >&2; fail "install.sh failed under $dash_bin with no terminal"; }
pass "install.sh runs under $dash_bin with no terminal"
operator=$(env_value KERYX_HUB_OPERATOR_TOKEN)
agent=$(env_value KERYX_HUB_AGENT_TOKEN)
assert "the Hub answers /healthz on the loopback port" curl -fsS --max-time 5 "$base/healthz"
refuse "the install log does not contain the operator token" has_secret "$log" "$operator"
refuse "the install log does not contain the bootstrap agent token" has_secret "$log" "$agent"
eq "the operator token is 64 characters" "${#operator}" 64
[ "$operator" != "$agent" ] || fail "the operator and agent tokens are equal"
eq "hub.env is 0600" "$(mode_of "$hub/secrets/hub.env")" 600
eq "agents.json is 0600" "$(mode_of "$hub/secrets/agents/agents.json")" 600
eq "current -> releases/v0.0.1" "$(readlink "$hub/current")" releases/v0.0.1
refuse "install.sh refuses to run over the install" sh "$deploy/install.sh" --version 0.0.1 --dir "$hub" --mode local --port "$port"
assert "hubctl status works" hubctl status
refuse "hubctl has no down" hubctl down
refuse "hubctl rollback has nothing to roll back to" hubctl rollback --yes
assert "hubctl restage validates and applies" hubctl restage

# --- refusals -----------------------------------------------------------------------------------------------
# No terminal to confirm on: dash used to exit silently here. The question names the project and volume.
refuses_saying "a confirmation without a terminal says it needs one (dash, no tty)" "needs a terminal" notty "$dash_bin" "$hub/hubctl" upgrade 0.0.2
refuses_saying "the confirmation names the project and the volume" "project $project (volume ${project}_hub-data)" notty "$dash_bin" "$hub/hubctl" upgrade 0.0.2
eq "an unconfirmed upgrade changed nothing" "$(readlink "$hub/current")" releases/v0.0.1
# An image without a digest is refused by install and by upgrade; nothing is created or changed.
refuses_saying "install.sh refuses an image without a digest" "without a digest" env -u KERYX_HUB_ALLOW_UNPINNED_IMAGE KERYX_HUB_PROJECT="${project}c" sh "$deploy/install.sh" --version 0.0.1 --dir "$E/hub-nodigest" --mode local --port "$((port + 5))"
if [ -e "$E/hub-nodigest" ]; then fail "the refused install created $E/hub-nodigest"; else pass "and left nothing behind"; fi
refuses_saying "hubctl upgrade refuses an image without a digest" "without a digest" env -u KERYX_HUB_ALLOW_UNPINNED_IMAGE "$hub/hubctl" upgrade 0.0.2 --yes
eq "and current is unchanged" "$(readlink "$hub/current")" releases/v0.0.1
# Values are matched as a whole: a newline must not let the good line through.
refuses_saying "install.sh rejects a newline in --domain" "lower-case DNS name" sh "$deploy/install.sh" --version 0.0.1 --dir "$E/hub-nl" --mode https --domain "$(printf 'hub.example.com\nevil.example.org')"
refuses_saying "hubctl rejects a newline in an agent id" "an agent id is" notty "$dash_bin" "$hub/hubctl" agent-key issue "$(printf 'ok-id\nBAD')" --project p1
refuses_saying "agent-key issue without a terminal says so (dash, no tty)" "none here" notty "$dash_bin" "$hub/hubctl" agent-key issue e2e-agent --project p1
# A lock held by a live operation stops anything that would start or stop the stack; a stale one does not.
ln -s "$$" "$hub/state/lock"
refuses_saying "up waits for the operation that holds the lock" "another hubctl operation is running" hubctl up
refuses_saying "stop does too" "another hubctl operation is running" hubctl stop
refuses_saying "and so does revoking an agent key" "another hubctl operation is running" hubctl agent-key revoke some-agent
assert "a nightly backup that meets the lock skips with a warning and exits 0" sh -c "'$hub/hubctl' backup --quiet 2>&1 | grep -q 'skipped'"
rm -f "$hub/state/lock"
ln -s 999999 "$hub/state/lock"
assert "a lock whose owner is gone is replaced" hubctl up
if [ -e "$hub/state/lock" ] || [ -L "$hub/state/lock" ]; then fail "the lock was left behind"; else pass "and released afterwards"; fi
# A service that is no longer part of the stack is removed, not left running. The operator's
# compose.override.yaml is the way to add one, and removing the file is the way to drop it.
printf 'services:\n  ghost:\n    image: %s\n    entrypoint: ["sleep", "3600"]\n' "$image" > "$hub/compose.override.yaml"
hubctl up >>"$steps" 2>&1 || fail "hubctl up with a compose.override.yaml failed"
ghosts() { docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=ghost; }
if [ -z "$(ghosts)" ]; then fail "compose.override.yaml was not applied"; else pass "compose.override.yaml adds a service to the stack"; fi
rm -f "$hub/compose.override.yaml"
hubctl up >>"$steps" 2>&1 || fail "hubctl up failed"
if [ -n "$(ghosts)" ]; then fail "an orphan survived hubctl up"; else pass "up --remove-orphans removed a service that is no longer in the stack"; fi

# --- data, backup, restore -----------------------------------------------------------------------------
cookie=
login() {
  printf '{"token":"%s"}' "$operator" > "$E/.login"
  cookie=$(curl -si --max-time 10 -X POST -H 'Content-Type: application/json' --data-binary @"$E/.login" "$base/hub/v1/session" \
    | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -n 1)
  [ -n "$cookie" ] || fail "operator login returned no session cookie"
}
create_project() { # create_project <name> -> prints the id (the session cookie is a credential: it goes in a file, not argv)
  printf 'Cookie: %s\n' "$cookie" > "$E/.cookie"
  curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' -H @"$E/.cookie" -H "Origin: ${hub_origin:-$base}" \
    -H "Idempotency-Key: e2e-$run-$1" -d "{\"name\":\"$1\"}" "$base/hub/v1/projects" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}
project_count() {
  bearer_header "$agent"
  curl -fsS --max-time 10 -H @"$E/.header" "$base/hub/v1/projects" | awk 'BEGIN{RS="\"id\":"} NR>1{n++} END{print n+0}'
}
status_of() { bearer_header "$1"; curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @"$E/.header" "$base/hub/v1/projects"; }
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

# Disaster recovery: the live database is destroyed, and a restore must still work (the safety copy of
# the broken data is kept and flagged, not a reason to refuse).
vol=${project}_hub-data
hubctl stop >>"$steps" 2>&1 || fail "hubctl stop failed"
docker run --rm --user 1000:1000 -v "$vol:/data" --entrypoint sh "$image" -c 'head -c 8192 /dev/urandom > /data/hub.sqlite; rm -f /data/hub.sqlite-wal /data/hub.sqlite-shm' >>"$steps" 2>&1 || fail "could not corrupt the database"
hubctl restore "$b2" --yes >>"$steps" 2>&1 || fail "restore over a corrupted database failed"
eq "a restore works over a corrupted database" "$(project_count)" 2
assert "and the damaged data was kept and flagged" sh -c "grep -q 'FAILS ITS INTEGRITY CHECK' '$steps'"

# A restore the Hub cannot start on: a database that passes its integrity check but names a schema
# version this Hub does not support. The Hub crash-loops; the data it replaced must come back, onto a
# Hub that is stopped first.
mkdir "$E/bad"; chmod 777 "$E/bad"
docker run --rm --user 1000:1000 -v "$E/bad:/out" --entrypoint bun "$image" -e 'import { Database } from "bun:sqlite";
const db = new Database("/out/bad.sqlite");
db.exec("CREATE TABLE hub_state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); INSERT INTO hub_state VALUES(1, \"{}\"); CREATE TABLE remote_schema_version(version INTEGER NOT NULL); INSERT INTO remote_schema_version VALUES(99)");
db.close();' >>"$steps" 2>&1 || fail "could not build the unusable database"
refuse "a restore the Hub cannot start on is reported as a failure" hubctl restore "$E/bad/bad.sqlite" --yes
assert "the Hub is healthy again after the failed restore" curl -fsS --max-time 10 "$base/healthz"
eq "and the data it replaced came back" "$(project_count)" 2
assert "the failed restore said it was putting the data back" sh -c "grep -q 'putting back the data it replaced' '$steps'"

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
key_from() { tr -d '\r' < "$1" | awk '/^  [0-9a-f]{64}$/ { gsub(/ /, ""); print; exit }'; }
pty "$E/key.txt" "$hub/hubctl" agent-key issue e2e-agent --project "$first" || fail "agent-key issue failed on a terminal"
key=$(key_from "$E/key.txt")
eq "a 64-character key was shown on the terminal" "${#key}" 64
rm -f "$E/key.txt"
eq "agents.json stays 0600" "$(mode_of "$hub/secrets/agents/agents.json")" 600
assert "agents.json.bak was kept" test -f "$hub/secrets/agents/agents.json.bak"
refuse "the raw key is not stored" has_secret "$hub/secrets/agents/agents.json" "$key"
eq "the new key works without a restart" "$(status_of "$key")" 200
assert "agent-key list shows it" sh -c "'$hub/hubctl' agent-key list 2>/dev/null | grep -q '^e2e-agent'"
refuse "agent-key list prints no key" output_has_secret "$key" "$hub/hubctl" agent-key list
if pty "$E/dup.txt" "$hub/hubctl" agent-key issue e2e-agent --project "$first"; then fail "a duplicate id was accepted"; fi
assert "a duplicate id is refused for the right reason" sh -c "grep -q 'already exists' '$E/dup.txt'"
pty "$E/rotate.txt" "$hub/hubctl" agent-key issue e2e-agent --rotate || fail "rotate failed"
rotated=$(key_from "$E/rotate.txt")
eq "rotation shows a new 64-character key" "${#rotated}" 64
[ "$rotated" != "$key" ] || fail "rotation returned the same key"
eq "the old key stops working after rotation" "$(status_of "$key")" 401
eq "the rotated key works" "$(status_of "$rotated")" 200
key=$rotated
hubctl agent-key revoke e2e-agent >>"$steps" 2>&1 || fail "revoke failed"
eq "a revoked key is refused" "$(status_of "$key")" 401

# --- upgrade, rollback ----------------------------------------------------------------------------------------------

# Release settings are install-owned; staging must not lose SSO or opt-in Work.
printf '\nKERYX_HUB_WORK_ENABLED=true\nKERYX_HUB_WORK_REPOSITORIES=[]\nKERYX_HUB_PUBLIC_ORIGIN=https://hub.example.test\nCF_ACCESS_TEAM=fixture\nCF_ACCESS_AUD=%s\n' "$(printf '%064d' 0)" >> "$hub/secrets/hub.env"
mkdir -p "$hub/secrets/access"
printf '[{"email":"operator@example.test","role":"operator"}]\n' > "$hub/secrets/access/roles.json"
chown 1000:1000 "$hub/secrets/access" "$hub/secrets/access/roles.json"
chmod 700 "$hub/secrets/access"; chmod 600 "$hub/secrets/access/roles.json"
cp "$deploy/selfhost/compose.access.example.yaml" "$hub/compose.override.yaml"
hubctl restage >>"$steps" 2>&1 || fail "could not apply Work and Access configuration"
hub_origin=https://hub.example.test
# Read-only inspection must not create install state or replace the running service.
check_cid=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hub)
check_pointer=$(readlink "$hub/current")
assert "update-check verifies the release" hubctl update-check 0.0.2 --json
assert "upgrade dry-run verifies without mutation" hubctl upgrade 0.0.2 --dry-run
eq "dry-run preserves the current release" "$(readlink "$hub/current")" "$check_pointer"
eq "dry-run preserves the running container" "$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hub)" "$check_cid"
hubctl upgrade 0.0.2 --yes >>"$steps" 2>&1 || fail "upgrade to 0.0.2 failed"
eq "upgraded: current -> releases/v0.0.2" "$(readlink "$hub/current")" releases/v0.0.2
assert "the Hub is healthy after the upgrade" curl -fsS --max-time 5 "$base/healthz"
eq "no data lost by the upgrade" "$(project_count)" 2
assert "a full pre-upgrade backup exists" sh -c "ls '$hub'/backups/upgrade-*-v0.0.1-to-v0.0.2/hub-data.tar"
assert "SSO override remains installation-owned" test -f "$hub/compose.override.yaml"
work_cid=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hub)
work_enabled=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$work_cid" | sed -n 's/^KERYX_HUB_WORK_ENABLED=//p')
eq "Work opt-in reaches the upgraded image" "$work_enabled" true
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
# The pre-upgrade backup of the last successful upgrade is not the failed upgrade's to overwrite.
refuse "an image that dies at start is refused" hubctl upgrade 0.0.3 --yes
eq "the failed upgrade left current alone" "$(readlink "$hub/current")" releases/v0.0.1
assert "the Hub is running after the abandoned upgrade" curl -fsS --max-time 10 "$base/healthz"
eq "the abandoned upgrade lost nothing" "$(project_count)" 3

# An image that only dies with a network passes the trial (network-less), then fails after the switch:
# the upgrade preserves current data and returns to a compatible old image.
create_project "e2e fourth" >/dev/null
eq "four projects before the last upgrade" "$(project_count)" 4
refuse "an image that fails after the switch is refused" hubctl upgrade 0.0.4 --yes
eq "automatic rollback: current is back on v0.0.1" "$(readlink "$hub/current")" releases/v0.0.1
assert "the Hub is healthy after the automatic rollback" curl -fsS --max-time 10 "$base/healthz"
eq "automatic recovery preserved all current data" "$(project_count)" 4

# A writer3 database must reject the simulated old-writer image BEFORE stopping the live Hub.
hubctl upgrade 0.0.2 --yes >>"$steps" 2>&1 || fail "upgrade for writer compatibility test failed"
bearer_header "$operator"
cp "$here/work-command.json" "$E/work-command.json"
assert "managed write succeeds through released settings" curl -fsS --max-time 10 -H "@$E/.header" -H 'Content-Type: application/json' -H 'Idempotency-Key: release-e2e-work-activation' --data-binary "@$E/work-command.json" "$base/hub/work/v1/projects/$first/commands"
mkdir "$E/old-reader-bundle"
tar -xzf "$E/releases/v0.0.5/team-hub-install.tar.gz" -C "$E/old-reader-bundle" --strip-components=1
hubctl _stage "$E/old-reader-bundle" 0.0.5 "kth-e2e-$run-old-reader" >>"$steps" 2>&1 || fail "could not stage old-reader fixture"
printf 'v0.0.5\n' > "$hub/state/previous-release"
# Count retention is the documented contract: three newest plus a referenced upgrade copy.
# Capture the actual retained set AFTER the successful upgrade has legitimately pruned it.
find "$hub/backups" -mindepth 1 -maxdepth 1 -type d \( -name 'upgrade-*' -o -name 'pre-restore-*' -o -name 'pre-rollback-*' \) > "$E/retained-safety-backups"
safety=$(wc -l < "$E/retained-safety-backups" | tr -d ' ')
[ "$safety" -ge 1 ] && [ "$safety" -le 4 ] || fail "safety retention must keep a bounded recoverable set: $safety"
IFS= read -r protected_backup < "$hub/state/last-upgrade-backup"
[ -d "$protected_backup" ] || fail "the explicitly referenced pre-upgrade backup was pruned"
check_cid=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hub)
refuses_saying "writer3 downgrade refuses before stopping current" "current Hub and release are unchanged" hubctl rollback --yes
# A broken fixture must not masquerade as the writer-version incompatibility being tested.
tail -n 30 "$steps" | grep -q 'Unsupported remote schema version' || fail "old-reader trial did not exercise its schema writer gate"
eq "refused downgrade keeps the current release" "$(readlink "$hub/current")" releases/v0.0.2
eq "refused downgrade does not replace the live container" "$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hub)" "$check_cid"
assert "live Hub remains healthy after incompatible downgrade" curl -fsS --max-time 5 "$base/healthz"
assert "managed metadata remains readable" curl -fsS --max-time 10 -H "@$E/.header" "$base/hub/work/v1/projects/$first/flows"

# Verify actual backup identities rather than assuming failed preflights create backups.
while IFS= read -r retained; do
  [ -d "$retained" ] || fail "a failed preflight removed an existing safety backup: $retained"
done < "$E/retained-safety-backups"
pass "bounded safety copies and the protected upgrade backup survive refused rollback"

# --- the operator token is shown on a terminal, once; two installs side by side ------------------------------------
# A second install into a directory whose name starts with the first one's, in its own compose project.
KERYX_HUB_PROJECT=${project}b; export KERYX_HUB_PROJECT
hub2=${hub}2
pty "$E/tty-install.txt" sh "$deploy/install.sh" --version 0.0.1 --dir "$hub2" --mode local --port "$((port + 1))" --no-backup \
  || fail "the install on a terminal failed"
operator2=$(sed -n 's/^KERYX_HUB_OPERATOR_TOKEN=//p' "$hub2/secrets/hub.env")
eq "the operator token appears once in what a terminal shows" "$(count_secret "$E/tty-install.txt" "$operator2")" 1
# The project comes from each install's own hub.env, never from the shell: this shell now names the
# SECOND install's project, and the first install must still act on its own.
out=$("$hub/hubctl" status 2>&1)
case $out in *"project     : $project"*) pass "hubctl names its own project, not the one in the environment" ;; *) fail "hubctl status ignored its own hub.env: $out" ;; esac
case $out in *"project     : ${project}b"*) fail "hubctl followed KERYX_HUB_PROJECT from the environment" ;; esac
KERYX_HUB_PROJECT=$project; export KERYX_HUB_PROJECT
# Two installs whose paths share a prefix keep their own cron lines.
hubctl schedule on >>"$steps" 2>&1
"$hub2/hubctl" schedule on >>"$steps" 2>&1
eq "two installs, two cron lines" "$(grep -c keryx-team-hub-backup "$E/crontab.txt")" 2
hubctl schedule off >>"$steps" 2>&1
eq "turning one off leaves the other (one path is a prefix of the other)" "$(grep -c keryx-team-hub-backup "$E/crontab.txt")" 1
assert "and it is the other install's" sh -c "grep -q 'keryx-team-hub-backup:.*hub2\$' '$E/crontab.txt'"
"$hub2/hubctl" schedule off >>"$steps" 2>&1

echo "e2e: every check passed"
