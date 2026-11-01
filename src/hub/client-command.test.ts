import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { hubCommand } from './client-command';

test('context-only client cannot start a server while the full CLI can inject its server handler', async () => {
    await expect(hubCommand(['serve'])).rejects.toThrow('Server commands require');
    let starts=0;
    await hubCommand(['serve'],undefined,'help',async()=>{starts++;});
    expect(starts).toBe(1);
    await expect(hubCommand(['serve','--unexpected'],undefined,'help',async()=>{starts++;})).rejects.toThrow('Unknown or repeated');
    expect(starts).toBe(1);
});
test('compiled standalone context client excludes the server and generated browser assets', async () => {
    const built=await Bun.build({entrypoints:[resolve(import.meta.dir,'client-main.ts')],target:'bun'});
    expect(built.success).toBe(true);
    const bundle=await built.outputs[0]!.text();
    expect(bundle.includes('function startHub(')).toBe(false);
    expect(bundle.includes('// src/hub/server.ts')).toBe(false);
    expect(bundle.includes('var webAssets')).toBe(false);
});
