import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture(installed = '0.0.1') {
  const dir = mkdtempSync(join(tmpdir(), 'hub-release-check-')); fixtures.push(dir);
  const install = join(dir, 'install'), releases = join(dir, 'served');
  mkdirSync(join(install, 'secrets'), { recursive: true });
  mkdirSync(join(install, `releases/v${installed}`), { recursive: true });
  writeFileSync(join(install, 'secrets/hub.env'), 'KERYX_HUB_MODE=local\nKERYX_HUB_PROJECT=update-test\n');
  writeFileSync(join(install, `releases/v${installed}/image.ref`), `ghcr.io/example/hub@sha256:${'1'.repeat(64)}\n`);
  writeFileSync(join(install, `releases/v${installed}/VERSION`), `${installed}\n`);
  symlinkSync(`releases/v${installed}`, join(install, 'current'));
  copyFileSync(resolve('deploy/team-hub/hubctl'), join(install, 'hubctl'));
  const target = join(releases, 'v0.0.2'); mkdirSync(target, { recursive: true });
  const bundle = Bun.spawnSync(['sh', 'deploy/team-hub/release/bundle.sh', target, '0.0.2']);
  expect(bundle.exitCode).toBe(0);
  writeFileSync(join(target, 'team-hub-image.txt'), `ghcr.io/example/hub@sha256:${'2'.repeat(64)}\n`);
  const sums = ['team-hub-install.tar.gz', 'team-hub-image.txt'].map(name => `${digest(join(target, name))}  ${name}\n`).join('');
  writeFileSync(join(target, 'SHA256SUMS'), sums);
  const run = (...args: string[]) => Bun.spawnSync(['sh', join(install, 'hubctl'), ...args], {
    env: { ...process.env, KERYX_HUB_RELEASE_BASE_URL: `file://${releases}` },
  });
  const snapshot = (base = install): unknown => Object.fromEntries(readdirSync(base).sort().map(name => {
    const file = join(base, name);
    return [name, statSync(file).isDirectory() ? snapshot(file) : readFileSync(file).toString('base64')];
  }));
  return { install, target, run, snapshot };
}

test('update-check validates a complete pinned release without changing the install or requiring Docker', () => {
  const f = fixture(), before = f.snapshot();
  const result = f.run('update-check', '0.0.2', '--json');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ installedVersion: '0.0.1', targetVersion: '0.0.2', updateAvailable: true });
  expect(f.snapshot()).toEqual(before);
});

test('upgrade dry-run validates artifacts and stays read-only', () => {
  const f = fixture(), before = f.snapshot();
  const result = f.run('upgrade', '0.0.2', '--dry-run');
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain('dry-run');
  expect(f.snapshot()).toEqual(before);
});

test('check and dry-run refuse incomplete, tampered or mutable release data before touching the install', () => {
  const f = fixture(), before = f.snapshot();
  writeFileSync(join(f.target, 'team-hub-image.txt'), 'ghcr.io/example/hub:latest\n');
  const result = f.run('upgrade', '0.0.2', '--dry-run');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('checksum mismatch');
  expect(f.snapshot()).toEqual(before);
  const missing = f.run('update-check', '0.0.3');
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain('could not download');
  expect(missing.stderr.toString()).toContain('v0.0.3/SHA256SUMS');
  expect(f.snapshot()).toEqual(before);
});

test('a checksummed mutable image is still refused', () => {
  const f = fixture(), before = f.snapshot();
  writeFileSync(join(f.target, 'team-hub-image.txt'), 'ghcr.io/example/hub:latest\n');
  writeFileSync(join(f.target, 'SHA256SUMS'), ['team-hub-install.tar.gz', 'team-hub-image.txt'].map(name => `${digest(join(f.target, name))}  ${name}\n`).join(''));
  const result = f.run('update-check', '0.0.2');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('without a digest');
  expect(f.snapshot()).toEqual(before);
});

test('an explicit downgrade through upgrade is refused before Docker or any install mutation', () => {
  const f = fixture('0.0.3'), before = f.snapshot();
  const result = f.run('upgrade', '0.0.2', '--yes');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('use rollback');
  expect(result.stderr.toString()).not.toContain('Docker daemon');
  expect(f.snapshot()).toEqual(before);
  expect(f.run('upgrade', '0.0.2', '--dry-run').stderr.toString()).toContain('use rollback');
});

test('configured trial settings preserve Work and SSO but exclude authentication credentials', () => {
  const result = Bun.spawnSync(['bun', '--no-env-file', 'deploy/team-hub/release/trial-settings.js'], { stdin: Buffer.from(JSON.stringify({ services: { hub: {
    environment: {
      KERYX_HUB_WORK_ENABLED: 'true', KERYX_HUB_WORK_REPOSITORIES: '[]',
      KERYX_HUB_FUTURE_RUNTIME_SETTING: 'new-setting',
      KERYX_HUB_ACCESS_ENABLED: 'true', KERYX_HUB_ACCESS_ROLES_FILE: '/run/access/roles.json',
      KERYX_HUB_ACCESS_ISSUER: 'https://fixture.cloudflareaccess.com', KERYX_HUB_ACCESS_AUDIENCE: 'fixture',
      KERYX_HUB_OPERATOR_TOKEN: 'never-retain-this-authentication-secret',
    }, volumes: [{ type: 'bind', source: '/install/secrets/access', target: '/run/access', read_only: true }],
  } } })) });
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain('E|KERYX_HUB_WORK_ENABLED=true');
  expect(output).toContain('E|KERYX_HUB_FUTURE_RUNTIME_SETTING=new-setting');
  expect(output).toContain('E|KERYX_HUB_ACCESS_ROLES_FILE=/run/access/roles.json');
  expect(output).toContain('M|/install/secrets/access|/run/access');
  expect(output).not.toContain('never-retain');
  expect(output).not.toContain('KERYX_HUB_OPERATOR_TOKEN');
});

test('trial parser rejects a missing Access role mount rather than disabling SSO silently', () => {
  const result = Bun.spawnSync(['bun', '--no-env-file', 'deploy/team-hub/release/trial-settings.js'], { stdin: Buffer.from(JSON.stringify({ services: { hub: {
    environment: { KERYX_HUB_ACCESS_ENABLED: 'true', KERYX_HUB_ACCESS_ROLES_FILE: '/run/access/roles.json' }, volumes: [],
  } } })) });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Unsupported Access role mount');
});

for (const [installed, target, newer] of [
  ['0.4.4-rc.2', '0.4.4-rc.10', true],
  ['0.4.4-rc.1', '0.4.4-rc.2', true],
  ['0.4.4-alpha', '0.4.4-rc.1', true],
  ['0.4.4-rc.1', '0.4.4-rc.1.1', true],
  ['0.4.4-rc.10', '0.4.4-rc.2', false],
  ['0.4.4-rc.1', '0.4.4', true],
  ['0.4.4', '0.4.4-rc.1', false],
  ['0.4.4-alpha.1', '0.4.4-beta.1', true],
  ['0.4.4-alpha', '0.4.4-alpha.1', true],
  ['0.4.4', '0.4.4', false],
] as const) {
  test(`semantic version ordering: ${target} newer than ${installed} is ${newer}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-semver-')); fixtures.push(directory);
    const library = readFileSync('deploy/team-hub/hubctl', 'utf8').replace(/^main "\$@"\s*$/m, '');
    writeFileSync(join(directory, 'library.sh'), library);
    writeFileSync(join(directory, 'probe.sh'), '. "$(dirname "$0")/library.sh"\nversion_newer "$1" "$2"\n');
    const result = Bun.spawnSync(['sh', join(directory, 'probe.sh'), target, installed]);
    expect(result.exitCode).toBe(newer ? 0 : 1);
  });
}

test('release bundle ships the directly tested runtime probe programs', () => {
  const f = fixture();
  const contents = Bun.spawnSync(['tar', '-tzf', join(f.target, 'team-hub-install.tar.gz')]);
  expect(contents.exitCode).toBe(0);
  for (const name of ['trial-settings.js', 'migrate-probe.js']) {
    expect(contents.stdout.toString()).toContain('team-hub-install/release/' + name);
  }
});
