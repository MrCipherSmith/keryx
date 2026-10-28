import { readFileSync } from 'node:fs';
import { MachineError } from './errors';

/**
 * Durable process identity for crash recovery. A PID alone is never evidence: a recorded process is
 * the same one only while its PID AND its operating-system start time both match, and a recorded
 * process-group leader is gone only once its whole group is gone as well.
 */
export interface ProcessIdentity { pid: number; pgid: number; startedAt: string }
/** `live`: the exact recorded process or its group still exists. `uncertain`: the evidence cannot decide. */
export type ProcessPresence = 'live' | 'absent' | 'uncertain';
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
function signalState(target: number): 'present' | 'absent' | 'unknown' {
    try { process.kill(target, 0); return 'present'; }
    catch (cause) { const code = (cause as NodeJS.ErrnoException).code; return code === 'ESRCH' ? 'absent' : code === 'EPERM' ? 'present' : 'unknown'; }
}
/** Linux: pgid and start ticks from /proc, bound to this boot. */
function linuxIdentity(pid: number): ProcessIdentity | null {
    let stat: string, boot: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
    catch { return null; }
    // The command name may contain spaces or parentheses; the fixed fields start after its last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgid = Number(fields[2]), ticks = fields[19];
    return positive(pgid) && ticks !== undefined && /^\d+$/.test(ticks) && boot.length > 0 ? { pid, pgid, startedAt: `boot:${boot}:ticks:${ticks}` } : null;
}
/** Elsewhere (macOS/BSD): ps in a fixed C locale and UTC, so the start time never depends on the caller's environment. */
function psIdentity(pid: number): ProcessIdentity | null {
    const result = Bun.spawnSync(['ps', '-o', 'pgid=,lstart=', '-p', String(pid)], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore' });
    if (result.exitCode !== 0) return null;
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(Buffer.from(result.stdout).toString('utf8'));
    return match && positive(Number(match[1])) ? { pid, pgid: Number(match[1]), startedAt: `lstart:${match[2]!.replace(/\s+/g, ' ')}` } : null;
}
/** Reads the identity of a live process, or null when it no longer exists or cannot be read. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
    if (!positive(pid)) return null;
    return process.platform === 'linux' ? linuxIdentity(pid) ?? psIdentity(pid) : psIdentity(pid);
}
/** The current process identity, recorded before this daemon may launch anything. */
export function currentProcessIdentity(): ProcessIdentity {
    const identity = readProcessIdentity(process.pid);
    if (identity === null) throw new MachineError('process-identity-unavailable');
    return identity;
}
function leaderState(identity: ProcessIdentity): 'same' | 'absent' | 'other' | 'unknown' {
    const signal = signalState(identity.pid);
    if (signal === 'absent') return 'absent';
    if (signal === 'unknown') return 'unknown';
    const current = readProcessIdentity(identity.pid);
    if (current === null) return signalState(identity.pid) === 'absent' ? 'absent' : 'unknown';
    if (identity.startedAt.length === 0) return 'unknown';
    return current.startedAt === identity.startedAt ? 'same' : 'other';
}
/**
 * Never decides from the PID alone. The exact process is live while PID and start time match; a
 * recorded group leader also stays live while any member of its group exists, since a process group
 * id cannot be reused while that group has members. A reused PID with a group present is uncertain.
 */
export function processPresence(identity: ProcessIdentity): ProcessPresence {
    if (!positive(identity.pid) || !positive(identity.pgid)) return 'uncertain';
    const leader = leaderState(identity);
    if (leader === 'same') return 'live';
    if (leader === 'unknown') return 'uncertain';
    if (identity.pgid === identity.pid) {
        const group = signalState(-identity.pgid);
        if (group === 'unknown') return 'uncertain';
        if (group === 'present') return leader === 'other' ? 'uncertain' : 'live';
    }
    return 'absent';
}
