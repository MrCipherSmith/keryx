import { withoutGitDiscoveryOverrides } from '../git-env';
import { MachineError } from './errors';
import { isMetaprojectManagedPath } from '../metaproject-gitignore';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
function git(cwd: string, args: string[]): Buffer { const r = Bun.spawnSync(['git', '-C', cwd, ...args],{env:withoutGitDiscoveryOverrides(process.env)}); if (r.exitCode !== 0)
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
    return {get nonce(){return nonce;},assertOwnership,reacquire(){
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
}
/** The bounded provenance snapshot: beyond either limit a capture refuses with quota-exceeded. */
export const SNAPSHOT_QUOTA={bytes:20*1024*1024,entries:10000} as const;
export function captureBaseline(cwd: string, options: {
    requireClean: boolean;
}): WorkspaceBaseline {
    const head = currentCheckoutHead(cwd);
    const admin = git(cwd, ['rev-parse', '--absolute-git-dir']).toString().trim();
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'index.lock'].some(p => existsSync(path.join(admin, p))))
        throw new MachineError('git-operation-active');
    // Keryx's own runtime data (the paths `keryx init` ignores) is never a foreign change, ignore block present or not; tracked files always stay observed.
    const untracked = git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).toString().split('\0').filter(name => name.length > 0 && !isMetaprojectManagedPath(name));
    if (options.requireClean && (git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).length || untracked.length))
        throw new MachineError('checkout-dirty');
    const names = [...git(cwd, ['ls-files', '-z', '--cached']).toString().split('\0').filter(Boolean), ...untracked];
    const entries: unknown[] = [];
    const files:WorkspaceBaseline['files']={};
    let total = 0;
    for (const name of [...new Set(names)].sort()) {
        if (name.split('/').includes('..') || path.isAbsolute(name))
            throw new MachineError('unsafe-workspace-path');
        const file = path.join(cwd, name);
        if (!existsSync(file)) {
            entries.push([name, 'deleted']);
            continue;
        }
        const resolved = realpathSync(file);
        if (!resolved.startsWith(realpathSync(cwd) + path.sep))
            throw new MachineError('unsafe-workspace-path');
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) {
            entries.push([name, 'symlink', readlinkSync(file)]);files[name]={mode:stat.mode&0o777,hash:'symlink',symlink:readlinkSync(file)};
            continue;
        }
        if (!stat.isFile())
            throw new MachineError('unsupported-workspace-file');
        total += stat.size;
        if (total > SNAPSHOT_QUOTA.bytes || entries.length >= SNAPSHOT_QUOTA.entries)
            throw new MachineError('quota-exceeded');
        const hash=createHash('sha256').update(readFileSync(file)).digest('hex');files[name]={mode:stat.mode&0o777,hash};entries.push([name,stat.mode&0o777,hash]);
    }
    const index=git(cwd,['diff','--cached','--binary']);return {head,files,usage:{bytes:total,entries:entries.length},indexDigest:createHash('sha256').update(index).digest('hex'),digest:createHash('sha256').update(JSON.stringify([head,index.toString(),entries])).digest('hex')};
}
export function verifyBaseline(cwd: string, baseline: WorkspaceBaseline): boolean { const actual = captureBaseline(cwd, { requireClean: false }); return actual.head === baseline.head && actual.digest === baseline.digest; }
