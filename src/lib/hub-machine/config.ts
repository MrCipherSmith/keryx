import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseClosedJson } from '../../remote-control/protocol';
import { withoutGitDiscoveryOverrides } from '../git-env';
import { MachineError } from './errors';
import { ensurePrivateDirectory, ownerLock, protectedRead, protectedWrite } from './secure-state';
export interface CheckoutMapping {
    projectId: string;
    checkoutId: string;
    cwd: string;
    profileId: string;
}
export interface MachineEnrollment {
    version: 2;
    hubId: string;
    hubUrl: string;
    machineId: string;
    secretPath: string;
    mappings: CheckoutMapping[];
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === [...expected].sort().join(',');
export function trustedHubUrl(value: string): string {
    let u: URL;
    try {
        u = new URL(value);
    }
    catch (cause) {
        throw new MachineError('invalid-hub-url', { cause });
    }
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))))
        throw new MachineError('invalid-hub-url');
    return u.origin;
}
/** Stable local enrollment namespace; does not assert a Hub-issued identity. */
export const hubIdentity = (url: string) => createHash('sha256').update(trustedHubUrl(url)).digest('hex');
export function machineStateDir(dir: string, hubId: string): string { if (!/^[a-f0-9]{64}$/.test(hubId))
    throw new MachineError('invalid-hub-selection'); return path.join(dir, 'hub-machines', hubId); }
function legacyCheck(dir: string): void { if (existsSync(path.join(dir, 'machine'))) {
    const legacy = lstatSync(path.join(dir, 'machine'));
    throw new MachineError(legacy.isSymbolicLink() ? 'unsafe-config-path' : 'legacy-enrollment-migration-required');
} }
export function listEnrollments(dir: string): MachineEnrollment[] {
    // A machine with no Hub (and no legacy enrollment to migrate) holds nothing to vet: its config directory is none of this module's business.
    if (!existsSync(path.join(dir, 'hub-machines')) && !existsSync(path.join(dir, 'machine')))
        return [];
    if (existsSync(dir))
        ensurePrivateDirectory(dir);
    legacyCheck(dir);
    const parent = path.join(dir, 'hub-machines');
    if (!existsSync(parent))
        return [];
    ensurePrivateDirectory(parent);
    return readdirSync(parent).filter(s => /^[a-f0-9]{64}$/.test(s)).filter(s => existsSync(path.join(parent, s, 'config.json'))).map(s => loadEnrollment(dir, s)!);
}
function selected(dir: string, hubId?: string): string | null {
    if (existsSync(dir))
        ensurePrivateDirectory(dir);
    legacyCheck(dir);
    if (hubId !== undefined) {
        machineStateDir(dir, hubId);
        return hubId;
    }
    const parent = path.join(dir, 'hub-machines');
    if (!existsSync(parent))
        return null;
    ensurePrivateDirectory(parent);
    const ids = readdirSync(parent).filter(s => /^[a-f0-9]{64}$/.test(s) && existsSync(path.join(parent, s, 'config.json')));
    if (ids.length > 1)
        throw new MachineError('hub-selection-required');
    return ids[0] ?? null;
}
export function machineConfigPath(dir: string, hubId?: string): string { const selectedId = selected(dir, hubId); if (!selectedId)
    throw new MachineError('not-paired'); return path.join(machineStateDir(dir, selectedId), 'config.json'); }
function validConfig(value: unknown, dir: string, hubId: string): value is MachineEnrollment {
    if (!object(value) || !keys(value, ['version', 'hubId', 'hubUrl', 'machineId', 'secretPath', 'mappings']) || value.version !== 2 || value.hubId !== hubId || typeof value.hubUrl !== 'string' || !id(value.machineId) || value.secretPath !== path.join(machineStateDir(dir, hubId), 'secret') || !Array.isArray(value.mappings) || value.mappings.length > 1000)
        return false;
    if (trustedHubUrl(value.hubUrl) !== value.hubUrl || hubIdentity(value.hubUrl) !== hubId)
        return false;
    const checkouts = new Set<string>(), paths = new Set<string>();
    return value.mappings.every(v => { if (!object(v) || !keys(v, ['projectId', 'checkoutId', 'cwd', 'profileId']) || !id(v.projectId) || !id(v.checkoutId) || !id(v.profileId) || typeof v.cwd !== 'string' || !path.isAbsolute(v.cwd) || path.normalize(v.cwd) !== v.cwd || checkouts.has(v.checkoutId) || paths.has(v.cwd))
        return false; checkouts.add(v.checkoutId); paths.add(v.cwd); return true; });
}
export function loadEnrollment(dir: string, hubId?: string): MachineEnrollment | null {
    const chosen = selected(dir, hubId);
    if (!chosen)
        return null;
    const state = machineStateDir(dir, chosen), file = path.join(state, 'config.json');
    if (!existsSync(file))
        return null;
    ensurePrivateDirectory(state);
    const parsed = parseClosedJson(protectedRead(file, 65536));
    if (!parsed.ok || !validConfig(parsed.value, dir, chosen))
        throw new MachineError('invalid-enrollment');
    protectedRead(parsed.value.secretPath, 256);
    return parsed.value;
}
export function readMachineSecret(enrollment: MachineEnrollment): string { const secret = protectedRead(enrollment.secretPath, 256); if (!/^[-_A-Za-z0-9]{43,256}$/.test(secret))
    throw new MachineError('invalid-enrollment'); return secret; }
function withLock<T>(dir: string, hubId: string, run: () => T): T { ensurePrivateDirectory(dir); ensurePrivateDirectory(path.join(dir, 'hub-machines')); const lock = ownerLock(machineStateDir(dir, hubId), 'daemon.lock'); try {
    return run();
}
finally {
    lock.release();
} }
export function acquireMachineDaemon(dir: string, hubId: string) { return ownerLock(machineStateDir(dir, hubId), 'daemon.lock'); }
function writeEnrollment(dir: string, input: {
    hubUrl: string;
    machineId: string;
    secret: string;
}): void {
    const hubUrl = trustedHubUrl(input.hubUrl), hubId = hubIdentity(hubUrl);
    if (!id(input.machineId) || !/^[-_A-Za-z0-9]{43,256}$/.test(input.secret))
        throw new MachineError('invalid-enrollment');
    const state = machineStateDir(dir, hubId), file = path.join(state, 'config.json');
    if (existsSync(file))
        throw new MachineError('already-paired');
    const secretPath = path.join(state, 'secret');
    protectedWrite(secretPath, input.secret, true);
    try {
        protectedWrite(file, JSON.stringify({ version: 2, hubId, hubUrl, machineId: input.machineId, secretPath, mappings: [] }), true);
    }
    catch (cause) {
        unlinkSync(secretPath);
        throw cause;
    }
}
export function saveEnrollment(dir: string, input: {
    hubUrl: string;
    machineId: string;
    secret: string;
}): void {
    legacyCheck(dir);
    withLock(dir, hubIdentity(input.hubUrl), () => writeEnrollment(dir, input));
}
/** Hold the same daemon/config nonce throughout one-use code consumption and credential persistence. */
export async function pairEnrollment(dir: string, hubUrl: string, provision: () => Promise<{
    machineId: string;
    secret: string;
}>): Promise<void> {
    legacyCheck(dir);
    const hubId = hubIdentity(hubUrl);
    ensurePrivateDirectory(dir);
    ensurePrivateDirectory(path.join(dir, 'hub-machines'));
    const lock = acquireMachineDaemon(dir, hubId);
    try {
        if (loadEnrollment(dir, hubId))
            throw new MachineError('already-paired');
        const result = await provision();
        writeEnrollment(dir, { hubUrl, ...result });
    }
    finally {
        lock.release();
    }
}
export function allowCheckout(dir: string, mapping: CheckoutMapping, hubId?: string): void {
    const chosen = selected(dir, hubId);
    if (!chosen)
        throw new MachineError('not-paired');
    withLock(dir, chosen, () => {
        const value = loadEnrollment(dir, chosen)!;
        if (!id(mapping.projectId) || !id(mapping.checkoutId) || !id(mapping.profileId))
            throw new MachineError('invalid-enrollment');
        const cwd = realpathSync(mapping.cwd);
        const r = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { env: withoutGitDiscoveryOverrides(process.env) });
        if (r.exitCode !== 0 || realpathSync(r.stdout.toString().trim()) !== cwd)
            throw new MachineError('invalid-checkout');
        if (value.mappings.some(m => m.checkoutId === mapping.checkoutId || m.cwd === cwd))
            throw new MachineError('mapping-conflict');
        value.mappings.push({ ...mapping, cwd });
        protectedWrite(path.join(machineStateDir(dir, chosen), 'config.json'), JSON.stringify(value));
    });
}
export function removeEnrollment(dir: string, hubId?: string, beforeRemove?: () => void): void { const chosen = selected(dir, hubId); if (!chosen)
    return; withLock(dir, chosen, () => { const value = loadEnrollment(dir, chosen); if (!value)
    return; beforeRemove?.(); unlinkSync(path.join(machineStateDir(dir, chosen), 'config.json')); unlinkSync(value.secretPath); }); }
