import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireCheckoutLease, captureBaseline, verifyBaseline } from './checkout-lease';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true }); });
function repo() { const d = mkdtempSync(path.join(tmpdir(), 'machine-checkout-')); dirs.push(d); for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fixture']])
    expect(Bun.spawnSync(['git', '-C', d, ...args]).exitCode).toBe(0); writeFileSync(path.join(d, 'a.txt'), 'baseline'); Bun.spawnSync(['git', '-C', d, 'add', '.']); const commit = Bun.spawnSync(['git', '-C', d, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']); expect(commit.stderr.toString()).toBe(''); expect(commit.exitCode).toBe(0); return d; }
test('Git admin nonce lease excludes a different Hub and cannot be released by a foreign owner', () => {
    const cwd = repo();
    const a = acquireCheckoutLease(cwd, { hubId: 'hub-a', runId: 'run-a', daemonId: 'daemon-a' });
    expect(() => acquireCheckoutLease(cwd, { hubId: 'hub-b', runId: 'run-b', daemonId: 'daemon-b' })).toThrow('checkout-busy');
    expect(() => a.release('foreign')).toThrow('owner');
    a.release(a.nonce);
    const b = acquireCheckoutLease(cwd, { hubId: 'hub-b', runId: 'run-b', daemonId: 'daemon-b' });
    b.release(b.nonce);
});
test('initial dirty admission refuses; owned dirty baseline permits continuation but detects external edits', () => {
    const cwd = repo();
    const initial = captureBaseline(cwd, { requireClean: true });
    writeFileSync(path.join(cwd, 'a.txt'), 'owned change');
    expect(() => captureBaseline(cwd, { requireClean: true })).toThrow('checkout-dirty');
    expect(verifyBaseline(cwd, initial)).toBe(false);
    const owned = captureBaseline(cwd, { requireClean: false });
    expect(verifyBaseline(cwd, owned)).toBe(true);
    writeFileSync(path.join(cwd, 'other.txt'), 'external');
    expect(verifyBaseline(cwd, owned)).toBe(false);
});
test('baseline refuses tracked files redirected through an external directory symlink', () => {
    const cwd = repo();
    const fs = require('node:fs');
    fs.mkdirSync(path.join(cwd, 'sub'));
    writeFileSync(path.join(cwd, 'sub', 'safe'), 'tracked');
    Bun.spawnSync(['git', '-C', cwd, 'add', '.']);
    Bun.spawnSync(['git', '-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'sub']);
    const outside = repo();
    writeFileSync(path.join(outside, 'safe'), 'outside');
    fs.rmSync(path.join(cwd, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, 'sub'));
    expect(() => captureBaseline(cwd, { requireClean: false })).toThrow('unsafe-workspace-path');
});
test('displaced Git admin ownership is detected before any later workspace effect',()=>{
 const cwd=repo();const lease=acquireCheckoutLease(cwd,{hubId:'one',runId:'r',daemonId:'d'});expect(()=>lease.assertOwnership()).not.toThrow();const admin=Bun.spawnSync(['git','-C',cwd,'rev-parse','--absolute-git-dir']).stdout.toString().trim();writeFileSync(path.join(admin,'keryx-machine-lease.json'),'foreign owner');expect(()=>lease.assertOwnership()).toThrow('lease-owner-mismatch');
});
test('explicit same-owner resume reacquires a fresh nonce only after a proved release and never displaces another Hub',()=>{
 const cwd=repo(),owner={hubId:'hub-a',runId:'session',daemonId:'daemon'};const lease=acquireCheckoutLease(cwd,owner),old=lease.nonce;expect(()=>lease.reacquire()).toThrow('lease-owner-mismatch');lease.release(old);const other=acquireCheckoutLease(cwd,{hubId:'hub-b',runId:'other',daemonId:'other'});expect(()=>lease.reacquire()).toThrow('checkout-busy');other.release(other.nonce);lease.reacquire();expect(lease.nonce).not.toBe(old);expect(()=>lease.assertOwnership()).not.toThrow();expect(()=>lease.release(old)).toThrow('lease-owner-mismatch');lease.release(lease.nonce);
});
