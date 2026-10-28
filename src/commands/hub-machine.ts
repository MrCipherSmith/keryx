import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync,unlinkSync} from 'node:fs';
import {processPresence} from '../lib/hub-machine/process-identity';
import {parseLocalOwnerRequest,requestLocalOwnerControl} from '../lib/hub-machine/local-control';
import { keryxConfigDir } from '../lib/config-dir';
import { allowCheckout, hubIdentity, machineStateDir, loadEnrollment, removeEnrollment, pairEnrollment } from '../lib/hub-machine/config';
import {canonicalDigest,type Control} from '../remote-control/protocol';
import {loadShellConfig} from '../lib/shell-config';
import {readMachinePolicy,writeMachinePolicy} from '../lib/hub-machine/policy';
import { MachineLedger } from '../lib/hub-machine/ledger';
import { MachineError } from '../lib/hub-machine/errors';
import { ensurePrivateDirectory, protectedRead } from '../lib/hub-machine/secure-state';
import { enrollMachine } from '../lib/hub-machine/client';
import { currentNativeCoverageSubject, validateNativeCoverageDescriptor } from '../session/commands/coverage';
import { NATIVE_COVERAGE_DESCRIPTOR } from '../session/native-coverage.generated';
/**
 * Explicit operator action after a serve crash: the per-Hub daemon lock is removed only when the daemon that wrote it
 * (bound by the lock nonce recorded in the ledger) is proven gone by its PID plus start time and process group.
 * A PID alone, the lock's age, an unknown nonce or a live daemon never unlock it. Run fences are untouched.
 */
function releaseStaleDaemonLock(stateDir:string,hubId:string):{kind:'daemon-lock';state:'absent'|'released';daemonId?:string}{
    const file=path.join(machineStateDir(stateDir,hubId),'daemon.lock');
    if(!existsSync(file))return{kind:'daemon-lock',state:'absent'};
    const nonce=protectedRead(file,128);
    const ledger=new MachineLedger(path.join(machineStateDir(stateDir,hubId),'control.sqlite'));
    try{
        const daemon=ledger.daemonByLockNonce(nonce);if(!daemon)throw new MachineError('recovery-required');
        const presence=processPresence(daemon);if(presence==='live')throw new MachineError('daemon-live');if(presence!=='absent')throw new MachineError('recovery-required');
        // Compare-and-delete: only the very lock the absent daemon wrote. A new daemon can create one only after this unlink.
        if(protectedRead(file,128)!==nonce)throw new MachineError('lease-owner-mismatch');
        unlinkSync(file);return{kind:'daemon-lock',state:'released',daemonId:daemon.daemonId};
    }finally{ledger.close();}
}
interface CommandOptions {
    stateDir?: string;
    env?: Record<string, string | undefined>;
    write?: (message: string) => void;
    /** Test seam only: replaces the build-time embedded descriptor; `null` models an absent one. */
    nativeCoverageDescriptor?: unknown;
}
export async function hubMachineCommand(args: string[], options: CommandOptions = {}): Promise<void> {
    const stateDir = keryxConfigDir(options.stateDir);
    const env = options.env ?? process.env;
    const write = options.write ?? console.log;
    const [command, ...rest] = args;
    const allowed: Record<string, string[]> = { readiness: [], pair: ['--url', '--code-env'], allow: ['--project', '--checkout', '--path', '--profile','--hub'], recover: ['--hub','--action','--session','--native-session','--controller-lease','--controller-version','--session-version','--history-version','--workspace-baseline','--request-id','--run','--reconciliation'], unpair: ['--hub'],configure:['--hub','--candidate','--ad-hoc','--max-runs'] };
    if (!command || !allowed[command])
        throw new MachineError('Use hub machine pair | allow | recover | unpair');
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
        const key = rest[i]!;
        const value = rest[++i];
        if (!allowed[command]!.includes(key) || flags.has(key) || !value || value.startsWith('--'))
            throw new MachineError('Invalid hub machine arguments');
        flags.set(key, value);
    }
    const required = (key: string) => { const value = flags.get(key); if (!value)
        throw new MachineError(`Required ${key}`); return value; };
    if (command === 'readiness') {
        // Shipped readiness reads only the embedded build-time descriptor, checked against the shipped registry and command contract.
        const check = validateNativeCoverageDescriptor('nativeCoverageDescriptor' in options ? options.nativeCoverageDescriptor : NATIVE_COVERAGE_DESCRIPTOR, currentNativeCoverageSubject());
        if (!check.ok)
            throw new MachineError(`native-coverage-${check.code}`);
        const { descriptor } = check;
        write(JSON.stringify({ descriptorValid: true, releaseReady: check.releaseReady, descriptorDigest: descriptor.descriptorDigest, counts: descriptor.counts, requiredGaps: descriptor.requiredGaps.map(gap => gap.variantId) }));
        if (!check.releaseReady)
            throw new MachineError('native-coverage-not-ready');
        return;
    }
    if (command === 'pair') {
        const hubId=hubIdentity(required('--url'));
        if (loadEnrollment(stateDir,hubId))
            throw new MachineError('already-paired');
        const codeEnv = required('--code-env');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(codeEnv))
            throw new MachineError('Invalid code environment reference');
        const code = env[codeEnv];
        if (!code)
            throw new MachineError('Pairing environment variable is missing');
        await pairEnrollment(stateDir,required('--url'),async()=>{
            ensurePrivateDirectory(machineStateDir(stateDir,hubId));
            const ledger=new MachineLedger(path.join(machineStateDir(stateDir,hubId),'control.sqlite'));
            try{return await enrollMachine(required('--url'),{code,agentVersion:'keryx-native-v1',ledgerId:ledger.ledgerId});}finally{ledger.close();}
        });
        write('Machine paired. Add an explicit local checkout allowance before execution.');
        return;
    }
    if (command === 'allow') {
        allowCheckout(stateDir, { projectId: required('--project'), checkoutId: required('--checkout'), cwd: required('--path'), profileId: required('--profile') }, flags.get('--hub'));
        write('Local checkout allowance saved.');
        return;
    }
    if(command==='configure'){
        const e=loadEnrollment(stateDir,flags.get('--hub'));if(!e)throw new MachineError('not-paired');
        if(required('--candidate')!=='current'||!['allow','deny'].includes(required('--ad-hoc'))||!['1','2'].includes(required('--max-runs')))throw new MachineError('invalid-policy');
        const saved=loadShellConfig(stateDir);if(!saved.provider||saved.provider==='fake'||!saved.model)throw new MachineError('provider-setup');
        const candidateId=canonicalDigest([saved.provider,saved.model]),adHoc=required('--ad-hoc')==='allow';const prior=readMachinePolicy(stateDir,e.hubId);
        const policy:Control['LocalMachinePolicy']={version:2,hubId:e.hubId,enabled:true,maxConcurrentRuns:Number(required('--max-runs')),allowAdHocSessions:adHoc,allowedCandidateIds:[candidateId],
          checkouts:e.mappings.map(m=>({projectId:m.projectId,checkoutId:m.checkoutId,localBindingId:canonicalDigest([e.hubId,m.checkoutId]),path:m.cwd,profileIds:[m.profileId]})),
          profiles:[...new Set(e.mappings.map(m=>m.profileId))].map(profileId=>({profileId,allowAdHocTurns:adHoc,consentVersion:(prior?.profiles.find(p=>p.profileId===profileId)?.consentVersion??0)+1,allowedCandidateIds:[candidateId]}))};
        writeMachinePolicy(stateDir,policy);write('Local policy saved for the current candidate. Readiness still requires supported native commands, credentials and containment.');return;
    }
    // Neither command may infer process absence or delete unresolved launch identities.
    const enrollment=loadEnrollment(stateDir,flags.get('--hub'));
    if(!enrollment)throw new MachineError('not-paired');
    if(command==='recover'){
        const action=flags.get('--action')??'inspect';if(!['inspect','release-expired-idle','confirm-run-absence','release-resolved-run','release-stale-daemon'].includes(action))throw new MachineError('invalid-local-request');
        const integer=(key:string)=>{const raw=required(key);if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new MachineError('invalid-local-request');return Number(raw);};
        const only=(keys:string[])=>{if([...flags.keys()].some(key=>!keys.includes(key)))throw new MachineError('invalid-local-request');};
        if(action==='inspect')only(['--hub','--action','--session','--request-id']);
        if(action==='confirm-run-absence')only(['--hub','--action','--run','--request-id']);
        if(action==='release-resolved-run')only(['--hub','--action','--run','--reconciliation','--request-id']);
        if(action==='release-stale-daemon'){only(['--hub','--action']);write(JSON.stringify(releaseStaleDaemonLock(stateDir,enrollment.hubId)));return;}
        const target=()=>action==='confirm-run-absence'?{runId:required('--run')}:action==='release-resolved-run'?{runId:required('--run'),reconciliationId:required('--reconciliation')}
            :{sessionId:required('--session'),nativeSessionId:required('--native-session'),controllerLeaseId:required('--controller-lease'),controllerVersion:integer('--controller-version'),expectedSessionVersion:integer('--session-version'),expectedHistoryVersion:integer('--history-version'),expectedWorkspaceBaseline:required('--workspace-baseline')};
        const request=parseLocalOwnerRequest({v:1,hubId:enrollment.hubId,requestId:flags.get('--request-id')??(action==='inspect'?randomUUID():required('--request-id')),operation:action,
            ...(action==='inspect'?(flags.has('--session')?{sessionId:required('--session')}:{}) : {target:target()})});
        if(!request.ok)throw new MachineError(request.error.code);const result=await requestLocalOwnerControl(stateDir,request.value);
        if(result.ok){write(JSON.stringify(result.value));return;}
        if(action!=='inspect'||!['local-control-unavailable','ENOENT'].includes(result.error.code))throw new MachineError(result.error.code);
        // Offline inspection is evidence only, never a stop/unlock/launch operation.
    }
    const ledger = new MachineLedger(path.join(machineStateDir(stateDir,enrollment.hubId),'control.sqlite'));
    try {
        const unresolved = ledger.unresolved();
        if (command === 'recover') {
            write(JSON.stringify({ ledgerId: ledger.ledgerId, unresolved:unresolved.map(row=>({commandId:row.id,runId:row.run,checkoutId:row.checkout,phase:row.phase})),localRecovery:ledger.localRecoveryClaims(), next: 'Verify native ownership locally; no lease or command tombstone was changed.' }));
            return;
        }
        if (unresolved.length)
            throw new MachineError('recovery-required');
        removeEnrollment(stateDir,enrollment.hubId,()=>{if(ledger.unresolved().length)throw new MachineError('recovery-required');});
        write('Local enrollment removed. Durable ledger preserved; revoke the machine separately in Hub.');
    }
    finally {
        ledger.close();
    }
}
