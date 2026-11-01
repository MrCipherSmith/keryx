import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubApplication } from '../src/hub/server';

test('legacy adoption safety boundaries use only disposable fixtures', () => {
  const result = Bun.spawnSync(['python3', 'deploy/team-hub/release/migrate-legacy-boundaries.test.py'], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toMatch(/Ran [1-9][0-9]* tests/);
  expect(result.stderr.toString()).toContain('OK');
});

async function workHttpFixture(run: (base: string, project: string, token: string, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'hub-adoption-http-'));
  const token = 'migration-fixture-operator-' + 'o'.repeat(40);
  const app = createHubApplication({ dataDir: directory, operatorToken: token,
    agentToken: 'migration-fixture-agent-' + 'a'.repeat(40), workManagement: { enabled: true } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
  const base = server.url.origin;
  try {
    const response = await fetch(base + '/hub/v1/projects', { method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': 'migration-fixture-project',
    }, body: JSON.stringify({ name: 'Adoption fixture' }) });
    expect(response.status).toBe(200);
    const project = await response.json() as { id: string };
    await run(base, project.id, token, directory);
    const listed = await fetch(base + '/hub/work/v1/projects/' + project.id + '/flows', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const body = await listed.json() as { records: unknown[] };
    expect(body.records.length).toBe(1);
  } finally {
    server.stop(true); app.close(); rmSync(directory, { recursive: true, force: true });
  }
}

test('the actual migration rehearsal probe submits a schema-valid idempotent command to the real API', async () => {
  await workHttpFixture(async (base, project, token) => {
    const child = Bun.spawn(['bun', '--no-env-file', 'deploy/team-hub/release/migrate-probe.js', project, base], {
      env: { ...process.env, KERYX_HUB_OPERATOR_TOKEN: token, KERYX_HUB_WORK_ENABLED: 'true' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
  });
});

test('the actual Docker E2E curl command carries the matching idempotency header', async () => {
  const source = readFileSync('deploy/team-hub/release/e2e.sh', 'utf8');
  const line = source.split('\n').find(value => value.startsWith('assert "managed write succeeds through released settings"'));
  const body = readFileSync('deploy/team-hub/release/work-command.json', 'utf8');
  expect(line).toBeDefined();
  if (!line) throw new Error('Missing production E2E activation probe');
  await workHttpFixture(async (base, project, token, directory) => {
    writeFileSync(join(directory, '.header'), 'Authorization: Bearer ' + token + '\n', { mode: 0o600 });
    writeFileSync(join(directory, 'work-command.json'), body);
    const child = Bun.spawn(['sh', '-c', 'assert() { shift; "$@"; }; E=$1; base=$2; first=$3; ' + line, 'probe', directory, base, project], {
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
  });
});
