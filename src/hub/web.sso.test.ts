/** React authentication behavior lives in apps/hub-web/tests/auth.case.tsx.
 * This Bun gate verifies the shipped embedded distribution and HTTP boundary. */
import { describe,expect,test } from 'bun:test';
import { createHash,randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webAssets } from './web';
import { webAssetDigests,webInputDigest } from './web-assets.generated';
import { createHubApplication } from './server';
describe('embedded React distribution and authenticated HTTP boundary',()=>{
 test('ships exact same-origin module/CSS assets without inline scripts or external services',()=>{
  const html=webAssets['/']!.body;expect(html).toContain('type="module"');expect(html).not.toMatch(/<script[^>]*>[^<]+/);expect(html).not.toMatch(/(?:src|href)="https?:/);
  const references=[...html.matchAll(/(?:src|href)="(\/[^"?]+)"/g)].map(match=>match[1]!);
  expect(references.some(path=>path.endsWith('.js'))).toBe(true);expect(references.some(path=>path.endsWith('.css'))).toBe(true);
  for(const path of references)expect(webAssets[path]).toBeDefined();
 });
 test('every embedded asset has a matching immutable content digest and source provenance',()=>{
  expect(webInputDigest).toMatch(/^[a-f0-9]{64}$/);for(const[path,asset]of Object.entries(webAssets)){expect(createHash('sha256').update(asset.body).digest('hex')).toBe(webAssetDigests[path]!);expect(path).not.toContain('..');expect(path).not.toEndWith('.map');}
 });
 test('Bun serves generated and query-parameter entry points with CSP and exact MIME, not arbitrary routes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hub-react-assets-'));const app=createHubApplication({dataDir:dir,operatorToken:randomBytes(32).toString('hex'),agentToken:randomBytes(32).toString('hex')});
  try{for(const[path,asset]of Object.entries(webAssets)){const result=await app.fetch(new Request('https://hub.example'+path));expect(result.status).toBe(200);expect(result.headers.get('content-type')).toBe(asset.contentType);expect(await result.text()).toBe(asset.body);expect(result.headers.get('content-security-policy')).not.toContain('unsafe-inline');expect(result.headers.get('content-security-policy')).not.toContain('unsafe-eval');}
   expect((await app.fetch(new Request('https://hub.example/?project=p&view=flows&flow=f'))).status).toBe(200);expect((await app.fetch(new Request('https://hub.example/arbitrary/file'))).status).toBe(404);
  }finally{app.close();rmSync(dir,{recursive:true,force:true});}
 });
});
