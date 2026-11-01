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
