import { withoutGitDiscoveryOverrides } from '../git-env';
import { MachineError, machineFailure } from './errors';
import { isMetaprojectManagedPath } from '../metaproject-gitignore';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { constants, closeSync, fstatSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
function git(cwd: string, args: string[]): Buffer { const r = Bun.spawnSync(['git', '--no-optional-locks', '-C', cwd, ...args],{env:withoutGitDiscoveryOverrides(process.env)}); if (r.exitCode !== 0)
    throw new MachineError('invalid-checkout'); return Buffer.from(r.stdout); }
export function currentCheckoutHead(cwd: string): string { return git(cwd, ['rev-parse', 'HEAD']).toString().trim(); }
export function acquireCheckoutLease(cwd: string, owner: {
    hubId: string;
    runId: string;
    daemonId: string;
}) {
    const canonical = realpathSync(cwd);
    const admin = realpathSync(git(canonical, ['rev-parse', '--absolute-git-dir']).toString().trim());
    const file = path.join(admin, 'keryx-machine-lease.json');
    let nonce = randomUUID();let released=false;
    let bytes = JSON.stringify({ ...owner, nonce, cwd: canonical });
    let fd: number;
    try {
        fd = openSync(file, 'wx', 0o600);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new MachineError('checkout-busy', { cause: error });
        throw error;
    }
    try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    const assertOwnership=()=>{let descriptor:number|undefined;try{descriptor=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(descriptor);if(!stat.isFile()||stat.size!==Buffer.byteLength(bytes)||readFileSync(descriptor,'utf8')!==bytes)throw new MachineError('lease-owner-mismatch');}catch(cause){throw new MachineError('lease-owner-mismatch',{cause});}finally{if(descriptor!==undefined)closeSync(descriptor);}};
    return {get nonce(){return nonce;},get released(){return released;},assertOwnership,reacquire(){
     if(!released)throw new MachineError('lease-owner-mismatch');const next=randomUUID(),nextBytes=JSON.stringify({...owner,nonce:next,cwd:canonical});let descriptor:number;
     try{descriptor=openSync(file,'wx',0o600);}catch(cause){if((cause as NodeJS.ErrnoException).code==='EEXIST')throw new MachineError('checkout-busy',{cause});throw cause;}
     try{writeFileSync(descriptor,nextBytes);fsyncSync(descriptor);}finally{closeSync(descriptor);}nonce=next;bytes=nextBytes;released=false;
    },release(proof:string){if(proof!==nonce||released)throw new MachineError('lease-owner-mismatch');assertOwnership();unlinkSync(file);released=true;}};
}
/**
 * Removes a checkout lease a crashed daemon left behind, only for its exact recorded owner (hub, session, daemon, canonical
 * path). The caller has already proven that daemon's absence and seen the human Hub resolution. Never a force-unlock:
 * any other or unreadable owner is refused, and an absent lease is the idempotent replay.
 */
export function releaseRecoveredCheckoutLease(cwd:string,owner:{hubId:string;runId:string;daemonId:string}):'released'|'absent'{
    const canonical=realpathSync(cwd),admin=realpathSync(git(canonical,['rev-parse','--absolute-git-dir']).toString().trim()),file=path.join(admin,'keryx-machine-lease.json');
    let descriptor:number;
    try{descriptor=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return 'absent';throw new MachineError('lease-owner-mismatch',{cause});}
    try{const stat=fstatSync(descriptor);if(!stat.isFile()||stat.size>4096)throw new MachineError('lease-owner-mismatch');const value:unknown=JSON.parse(readFileSync(descriptor,'utf8'));
        if(value===null||typeof value!=='object'||Object.keys(value).sort().join(',')!=='cwd,daemonId,hubId,nonce,runId')throw new MachineError('lease-owner-mismatch');
        const lease=value as Record<string,unknown>;if(lease.hubId!==owner.hubId||lease.runId!==owner.runId||lease.daemonId!==owner.daemonId||lease.cwd!==canonical||typeof lease.nonce!=='string')throw new MachineError('lease-owner-mismatch');}
    catch(cause){throw cause instanceof MachineError?cause:new MachineError('lease-owner-mismatch',{cause});}
    finally{closeSync(descriptor);}
    unlinkSync(file);return 'released';
}
export interface WorkspaceBaseline {
    head: string;
    digest: string;
    indexDigest:string;
    files:Record<string,{mode:number;hash:string;symlink?:string}>;
    /** What a fresh capture measured against the snapshot quota; not part of the digest. */
    usage?:{bytes:number;entries:number};
    /** Whether captured bytes, modes and staged changes match the commit for full-file result publication. */
    matchesCommit?: boolean;
}
/** The bounded provenance snapshot: beyond either limit a capture refuses with quota-exceeded. */
export const SNAPSHOT_QUOTA={bytes:2*1024*1024*1024,entries:50_000} as const;
export function assertSnapshotQuota(bytes: number, entries: number): void {
    if (bytes > SNAPSHOT_QUOTA.bytes || entries > SNAPSHOT_QUOTA.entries)
        throw new MachineError('quota-exceeded');
}
const GIT_OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'index.lock'];
const gitOperationActive = (cwd: string): boolean => { const admin = git(cwd, ['rev-parse', '--absolute-git-dir']).toString().trim(); return GIT_OPERATION_MARKERS.some(p => existsSync(path.join(admin, p))); };
// Keryx's own runtime data (the paths `keryx init` ignores) is never a foreign change, ignore block present or not; tracked files always stay observed.
const untrackedNames = (cwd: string): string[] => git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).toString().split('\0').filter(name => name.length > 0 && !isMetaprojectManagedPath(name));
const trackedChanges = (cwd: string): boolean => git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).length > 0;
/**
 * The inventory-visible state of a checkout, measured without reading file content: HEAD, an active Git operation, and whether
 * it is clean exactly as {@link captureBaseline} judges it. Cheap enough to re-measure while connected.
 */
export function observeCheckout(cwd: string): { head: string; clean: boolean; operation: boolean } {
    const head = currentCheckoutHead(cwd), operation = gitOperationActive(cwd);
    return { head, clean: !trackedChanges(cwd) && untrackedNames(cwd).length === 0, operation };
}
type CommittedObject = {mode: string; id: string};
function committedObjects(cwd: string, head: string): Map<string, CommittedObject> {
    const objects = new Map<string, CommittedObject>();
    for (const entry of git(cwd, ['ls-tree', '-r', '-z', '--full-tree', head]).toString().split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [mode, type, id] = entry.slice(0, tab).split(' ');
        if (tab < 0 || !mode || type !== 'blob' || !id)
            continue;
        objects.set(entry.slice(tab + 1), {mode, id});
    }
    return objects;
}
function gitBlobHasher(object: CommittedObject | undefined, mode: string, size: number): Hash | undefined {
    if (object?.mode !== mode)
        return undefined;
    return createHash(object.id.length === 40 ? 'sha1' : 'sha256').update(`blob ${size}\0`);
}
type SnapshotPath = { name: string; file: string; stat?: Stats };

function* snapshotPaths(cwd: string, untracked: string[]): Generator<SnapshotPath, number> {
    const root = realpathSync(cwd);
    const tracked = git(cwd, ['ls-files', '-z', '--cached']).toString().split('\0').filter(Boolean);
    const names = [...new Set([...tracked, ...untracked])].sort();
    assertSnapshotQuota(0, names.length);
    let bytes = 0;
    for (const name of names) {
        if (name.split('/').includes('..') || path.isAbsolute(name))
            throw new MachineError('unsafe-workspace-path');
        const file = path.join(root, name);
        if (!existsSync(file)) {
            yield { name, file };
            continue;
        }
        if (!realpathSync(file).startsWith(root + path.sep))
            throw new MachineError('unsafe-workspace-path');
        const stat = lstatSync(file);
        if (stat.isFile()) {
            bytes += stat.size;
            assertSnapshotQuota(bytes, names.length);
        } else if (!stat.isSymbolicLink()) {
            throw new MachineError('unsupported-workspace-file');
        }
        yield { name, file, stat };
    }
    return bytes;
}

/** Same path and quota checks as capture, without reading or hashing workspace file contents. */
export function inspectCheckout(cwd: string): { head: string; clean: boolean; blocker?: string } {
    const head = currentCheckoutHead(cwd);
    const untracked = untrackedNames(cwd);
    const clean = untracked.length === 0 && !trackedChanges(cwd);
    try {
        if (gitOperationActive(cwd))
            return { head, clean, blocker: 'git-operation-active' };
        for (const _ of snapshotPaths(cwd, untracked)) { /* validate paths and usage */ }
        return { head, clean };
    } catch (cause) {
        return { head, clean, blocker: machineFailure(cause).code };
    }
}

function sameFile(before: Stats, after: Stats): boolean {
    return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
        && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function hashFile(file: string, stat: Stats, buffer: Buffer, blob?: Hash): string {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        if (!sameFile(stat, fstatSync(fd)))
            throw new MachineError('workspace-conflict');
        const hash = createHash('sha256');
        for (let remaining = stat.size; remaining > 0;) {
            const read = readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null);
            if (read === 0)
                throw new MachineError('workspace-conflict');
            const chunk = buffer.subarray(0, read);
            hash.update(chunk);
            blob?.update(chunk);
            remaining -= read;
        }
        if (!sameFile(stat, fstatSync(fd)))
            throw new MachineError('workspace-conflict');
        return hash.digest('hex');
    } finally {
        closeSync(fd);
    }
}

export function captureBaseline(cwd: string, options: {
    requireClean: boolean;
    verifyCommitContents?: boolean;
}): WorkspaceBaseline {
    const head = currentCheckoutHead(cwd);
    if (gitOperationActive(cwd))
        throw new MachineError('git-operation-active');
    const untracked = untrackedNames(cwd);
    if (options.requireClean && (trackedChanges(cwd) || untracked.length))
        throw new MachineError('checkout-dirty');
    // Git status can hide working bytes via index flags and clean/smudge filters. Full-file upload needs the raw bytes.
    const committed = options.verifyCommitContents && untracked.length === 0 ? committedObjects(cwd, head) : undefined;
    let matchesCommit = committed !== undefined;
    const entries: unknown[] = [];
    const files: WorkspaceBaseline['files'] = {};
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const paths = snapshotPaths(cwd, untracked);
    let next = paths.next();
    for (; !next.done; next = paths.next()) {
        const { name, file, stat } = next.value;
        if (!stat) {
            entries.push([name, 'deleted']);
            matchesCommit = false;
            continue;
        }
        const object = matchesCommit ? committed?.get(name) : undefined;
        const mode = stat.mode & 0o777;
        if (stat.isSymbolicLink()) {
            const link = readlinkSync(file, { encoding: 'buffer' });
            const target = link.toString();
            entries.push([name, 'symlink', target]);
            files[name] = { mode, hash: 'symlink', symlink: target };
            if (matchesCommit)
                matchesCommit = object !== undefined && gitBlobHasher(object, '120000', link.length)?.update(link).digest('hex') === object.id;
            continue;
        }
        const blob = gitBlobHasher(object, stat.mode & 0o111 ? '100755' : '100644', stat.size);
        const hash = hashFile(file, stat, buffer, blob);
        files[name] = { mode, hash };
        entries.push([name, mode, hash]);
        if (matchesCommit)
            matchesCommit = blob !== undefined && blob.digest('hex') === object?.id;
    }
    const index = git(cwd, ['diff', '--cached', '--binary']);
    return { head, files, usage: { bytes: next.value, entries: entries.length }, indexDigest: createHash('sha256').update(index).digest('hex'),
        digest: createHash('sha256').update(JSON.stringify([head, index.toString(), entries])).digest('hex'),
        ...(options.verifyCommitContents ? { matchesCommit: matchesCommit && committed?.size === entries.length && index.length === 0 } : {}) };
}
export function verifyBaseline(cwd: string, baseline: WorkspaceBaseline): boolean { const actual = captureBaseline(cwd, { requireClean: false }); return actual.head === baseline.head && actual.digest === baseline.digest; }
