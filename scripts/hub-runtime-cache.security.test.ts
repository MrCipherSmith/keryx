import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPreparedRuntimeCache } from './hub-runtime-cache.test-support';

async function cacheFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-cache-security-'));
  const cache = join(root, 'cache'), lock = join(root, 'bun.lock');
  await mkdir(cache);
  await writeFile(lock, JSON.stringify({ packages: { pkg: ['pkg@1.2.3', '', {}] } }));
  return { root, cache, lock };
}

test('prepared cache rejects a matching entry whose symlink escapes the private cache', async () => {
  const f = await cacheFixture();
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.2.3' }));
    await symlink(outside, join(f.cache, 'pkg@1.2.3@@@fixture'));
    await expect(assertPreparedRuntimeCache(f.cache, f.lock)).rejects.toThrow('Runtime cache entry escapes its private directory');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('prepared cache rejects matching entry names with wrong package identity', async () => {
  const f = await cacheFixture();
  try {
    const entry = join(f.cache, 'pkg@1.2.3@@@fixture'); await mkdir(entry);
    for (const metadata of [{ name: 'other', version: '1.2.3' }, { name: 'pkg', version: '9.0.0' }]) {
      await writeFile(join(entry, 'package.json'), JSON.stringify(metadata));
      await expect(assertPreparedRuntimeCache(f.cache, f.lock)).rejects.toThrow('Pinned runtime dependency is not cached: pkg@1.2.3');
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function prepareFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-prepare-security-'));
  const cache = join(root, 'cache'), marker = join(root, 'installer-called'), preload = join(root, 'installer-seam.ts');
  await mkdir(cache);
  // Intercept only the installer child: the CLI itself runs unmodified. The fake
  // child never invokes an installer, a registry, or a host dependency cache.
  await writeFile(preload, `import { writeFileSync } from 'node:fs';\nconst spawn = Bun.spawn;\nBun.spawn = ((args, options) => { writeFileSync(${JSON.stringify(marker)}, 'called'); return spawn([process.execPath, '-e', 'process.exit(37)'], options); }) as typeof Bun.spawn;\n`);
  const run = async (first: string) => {
    const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, 'prepare-team-hub-runtime-cache.ts'), first, '--cache', cache], { env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, invoked: await readFile(marker, 'utf8').then(() => true, () => false) };
  };
  return { root, cache, run };
}

test('preparation CLI requires explicit network permission before installer invocation', async () => {
  const f = await prepareFixture();
  try {
    const result = await f.run('--no-network');
    expect(result.code).toBe(2); expect(result.stderr).toContain('Usage:'); expect(result.invoked).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preparation CLI refuses a populated private cache before installer invocation', async () => {
  const f = await prepareFixture();
  try {
    await writeFile(join(f.cache, 'existing'), 'untouched');
    const result = await f.run('--allow-network');
    expect(result.code).not.toBe(0); expect(result.stderr).toContain('Runtime integration cache must be empty'); expect(result.invoked).toBe(false);
    expect(await readFile(join(f.cache, 'existing'), 'utf8')).toBe('untouched');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preparation CLI reports a failed installer and never reports success', async () => {
  const f = await prepareFixture();
  try {
    const result = await f.run('--allow-network');
    expect(result.invoked).toBe(true); expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Pinned runtime cache preparation failed: 37');
    expect(result.stdout).not.toContain('Prepared isolated runtime cache');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
