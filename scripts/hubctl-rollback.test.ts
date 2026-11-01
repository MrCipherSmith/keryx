import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function libraryFixture(program: string, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hub-rollback-'));
  fixtures.push(directory);
  const library = readFileSync('deploy/team-hub/hubctl', 'utf8').replace(/^main "\$@"\s*$/m, '');
  writeFileSync(join(directory, 'library.sh'), library);
  mkdirSync(join(directory, 'preflight'));
  writeFileSync(join(directory, 'probe.sh'), '. "$(dirname "$0")/library.sh"\n' + program);
  const result = Bun.spawnSync(['sh', join(directory, 'probe.sh')], { env: { ...process.env, ...env } });
  return { directory, result };
}

const preflightPorts = `
container_of() { printf live; }
new_tmp() { NEW_TMP="$ROOT/preflight"; }
docker() {
  case "$*" in
    'exec live stat -c %s /data/hub.sqlite') printf '%s\\n' "$DATABASE_BYTES" ;;
    'exec live sh -c '*) printf '%s\\n' "\${WAL_BYTES:-0}" ;;
    'exec live bun -e '*) printf serialized >> "$ROOT/serialize-called"; printf fixture ;;
    *) return 91 ;;
  esac
}
docker_locked() { printf archive; }
trial_start() { return 0; }
_vol=volume
_cur_image=current-image
trial_running_data target-image "$ROOT/target-release" volume current-image
`;

test('rollback preflight refuses an oversized database before serialization in the live container', () => {
  const { directory, result } = libraryFixture(preflightPorts, { DATABASE_BYTES: '157286401' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('online backup');
  expect(() => readFileSync(join(directory, 'serialize-called'))).toThrow();
});

test('rollback preflight refuses an unreadable size rather than treating it as zero', () => {
  const { directory, result } = libraryFixture(preflightPorts, { DATABASE_BYTES: 'unknown' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('database size');
  expect(() => readFileSync(join(directory, 'serialize-called'))).toThrow();
});

const rollbackPorts = `
mkdir -p "$ROOT/releases/v1" "$ROOT/releases/v2" "$ROOT/backups"
printf old-image > "$ROOT/releases/v1/image.ref"
printf new-image > "$ROOT/releases/v2/image.ref"
printf v2 > "$ROOT/selected"
need_install() { :; }; need_docker() { :; }; lock() { :; }
state_get() { [ "$1" != previous-release ] || printf v1; }
state_set() { :; }
current_release() { printf '%s/releases/v2' "$ROOT"; }
data_volume() { printf data-volume; }
container_of() { [ "$HUB_STATE" = missing ] || printf live; }
docker() {
  case "$*" in
    'inspect -f {{.State.Running}} {{.State.Restarting}} live') [ "$HUB_STATE" = restarting ] && printf 'true true' || printf 'false false' ;;
    *) printf 'unexpected Docker exec: %s\\n' "$*" >&2; return 91 ;;
  esac
}
pull_release_images() { :; }
confirm() { printf confirmed > "$ROOT/confirmed"; }
stop_hub_graceful() { printf stopped > "$ROOT/stopped"; }
backup_volume() { printf current-data > "$3"; }
trial_start() {
  [ -f "$ROOT/stopped" ] && [ "$(cat "$2")" = current-data ] || return 92
  [ "$COMPATIBLE" = yes ]
}
switch_current() { printf '%s' "$1" > "$ROOT/selected"; }
up_all() { printf started > "$ROOT/started"; }
verify_running() { return 0; }; sync_hubctl() { :; }; prune_safety_backups() { :; }
cmd_rollback --yes
`;

for (const state of ['stopped', 'missing', 'restarting']) {
  test(`rollback of a ${state} Hub trials a quiescent copy without requiring live exec`, () => {
    const { directory, result } = libraryFixture(rollbackPorts, { HUB_STATE: state, COMPATIBLE: 'yes' });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(directory, 'selected'), 'utf8')).toBe('v1');
    expect(readFileSync(join(directory, 'started'), 'utf8')).toBe('started');
  });
  test(`incompatible rollback of a ${state} Hub preserves current release and data`, () => {
    const { directory, result } = libraryFixture(rollbackPorts, { HUB_STATE: state, COMPATIBLE: 'no' });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(directory, 'selected'), 'utf8')).toBe('v2');
    expect(result.stderr.toString()).toContain('current data and release were preserved');
  });
}

for (const wal of ['157286401', 'unreadable']) {
  test(`online rollback refuses WAL budget ${wal} before serialization`, () => {
    const { directory, result } = libraryFixture(preflightPorts, { DATABASE_BYTES: '4096', WAL_BYTES: wal });
    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(join(directory, 'serialize-called'))).toThrow();
  });
}

test('upgrade rechecks installed version under the acquired lock before staging', () => {
  const { result } = libraryFixture(`
mkdir -p "$ROOT/releases/current"
printf '0.4.4' > "$ROOT/releases/current/VERSION"
current_release() { printf '%s/releases/current' "$ROOT"; }
need_install() { :; }; need_docker() { :; }; need() { :; }
lock() { printf '0.4.6' > "$ROOT/releases/current/VERSION"; }
cmd_upgrade 0.4.5 --yes
`);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('v0.4.5 is not newer than v0.4.6');
});

test('frequent safety backups are count bounded while retaining the explicit restore pointer', () => {
  const { directory, result } = libraryFixture(`
mkdir -p "$ROOT/backups"
for n in 1 2 3 4 5 6 7 8; do mkdir "$ROOT/backups/upgrade-$n"; done
state_get() { printf '%s/backups/upgrade-1' "$ROOT"; }
prune_safety_backups
find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d > "$ROOT/remaining"
`);
  expect(result.exitCode).toBe(0);
  const remaining = readFileSync(join(directory, 'remaining'), 'utf8').trim().split('\n');
  expect(remaining.length).toBeLessThanOrEqual(4);
  expect(remaining).toContain(join(directory, 'backups/upgrade-1'));
});

test('rollback refuses to silently drop a legacy per-release Access overlay', () => {
  const program = rollbackPorts.replace('cmd_rollback --yes', 'printf access > "$ROOT/releases/v2/compose.access.yaml"\ncmd_rollback --yes');
  const { directory, result } = libraryFixture(program, { HUB_STATE: 'stopped', COMPATIBLE: 'yes' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('previous release lacks the current Access overlay');
  expect(readFileSync(join(directory, 'selected'), 'utf8')).toBe('v2');
  expect(() => readFileSync(join(directory, 'stopped'))).toThrow();
});

test('stale adoption marker names the exact files requiring inspection', () => {
  const { result } = libraryFixture(`
mkdir -p "$ROOT/state"
ln -s 999999999 "$ROOT/state/legacy-adoption.lock"
need_install
`);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('stale legacy adoption');
  expect(result.stderr.toString()).toContain('legacy-adoption.token');
});

test('online preflight excludes changing SQLite files and tolerates tar file-changed status', () => {
  const program = preflightPorts.replace('docker_locked() { printf archive; }', `docker_locked() {
    case "$*" in *--exclude=./hub.sqlite*--exclude=./hub.sqlite-wal*--exclude=./hub.sqlite-shm*) printf archive; return 1 ;; *) return 92 ;; esac
  }`);
  const { result } = libraryFixture(program, { DATABASE_BYTES: '4096', WAL_BYTES: '0' });
  expect(result.exitCode).toBe(0);
});

test('new Hub runtime settings cannot override installation configuration through the caller environment', () => {
  const { result } = libraryFixture('test -z "${KERYX_HUB_FUTURE_RUNTIME_SETTING:-}"\n', { KERYX_HUB_FUTURE_RUNTIME_SETTING: 'external-override' });
  expect(result.exitCode).toBe(0);
});
