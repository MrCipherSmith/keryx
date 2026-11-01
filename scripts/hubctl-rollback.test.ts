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
trial_running_data target-image "$ROOT/target-release"
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
