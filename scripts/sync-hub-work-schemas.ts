/** Regenerate browser protocol copies from the canonical shipped JSON schemas. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['command', 'domain', 'event'] as const;
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(argument => argument !== '--check')) {
  throw new Error('Usage: bun scripts/sync-hub-work-schemas.ts [--check]');
}
for (const name of names) {
  const canonical = resolve(root, `docs/requirements/hub-work-management/schemas/${name}.schema.json`);
  const browser = resolve(root, `apps/hub-web/src/features/managed-work/${name}-schema.json`);
  const source = await readFile(canonical, 'utf8');
  if (check) {
    if (await readFile(browser, 'utf8') !== source) throw new Error(`Stale generated ${name} schema: run bun scripts/sync-hub-work-schemas.ts`);
  } else {
    await writeFile(browser, source);
  }
}
console.log('Hub browser schemas match the canonical protocol');
