import { expect, test } from 'bun:test';
import { currentProcessIdentity, processPresence, readProcessIdentity } from './process-identity';

const settle = async (check: () => boolean): Promise<void> => { for (const deadline = Date.now() + 5000; !check() && Date.now() < deadline;) await Bun.sleep(20); };

test('a SIGKILLed daemon process is absent only by its recorded start time, never by its PID alone', async () => {
    const daemon = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], { stdout: 'ignore', stderr: 'ignore' });
    try {
        const identity = readProcessIdentity(daemon.pid);
        expect(identity).not.toBeNull();
        expect(identity!.pid).toBe(daemon.pid);
        expect(identity!.startedAt.length).toBeGreaterThan(0);
        expect(processPresence(identity!)).toBe('live');
        // The same live PID with a different recorded start time is a different (reused) process.
        expect(processPresence({ ...identity!, startedAt: `${identity!.startedAt}-other` })).toBe('absent');
        daemon.kill('SIGKILL'); await daemon.exited;
        await settle(() => processPresence(identity!) === 'absent');
        expect(processPresence(identity!)).toBe('absent');
    } finally { daemon.kill('SIGKILL'); await daemon.exited; }
});

test('a recorded process group stays live after its leader is killed until every member is gone', async () => {
    // A detached leader backgrounds a member of its own group and keeps running.
    const leader = Bun.spawn(['/bin/sh', '-c', 'sleep 60 & echo $!; wait'], { stdout: 'pipe', stderr: 'ignore', detached: true });
    try {
        const reader = leader.stdout.getReader(); const first = await reader.read(); reader.releaseLock();
        const member = Number(new TextDecoder().decode(first.value).trim());
        expect(Number.isSafeInteger(member) && member > 0).toBe(true);
        const identity = readProcessIdentity(leader.pid)!;
        expect(identity.pgid).toBe(leader.pid);
        expect(readProcessIdentity(member)!.pgid).toBe(leader.pid);
        expect(processPresence(identity)).toBe('live');
        process.kill(leader.pid, 'SIGKILL'); await leader.exited;
        // Leader gone, PID check alone would say absent; the surviving member keeps the group live.
        expect(processPresence({ ...identity })).toBe('live');
        process.kill(-identity.pgid, 'SIGKILL');
        await settle(() => processPresence(identity) === 'absent');
        expect(processPresence(identity)).toBe('absent');
    } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* The group is already gone. */ } await leader.exited; }
});

test('the current process identity is readable and live; impossible identities are uncertain', () => {
    const self = currentProcessIdentity();
    expect(self.pid).toBe(process.pid);
    expect(processPresence(self)).toBe('live');
    expect(processPresence({ pid: 0, pgid: 1, startedAt: 'x' })).toBe('uncertain');
    expect(processPresence({ pid: 1, pgid: -1, startedAt: 'x' })).toBe('uncertain');
    // A live PID whose start time was never recorded cannot be told apart from a reused one.
    expect(processPresence({ pid: process.pid, pgid: self.pgid, startedAt: '' })).toBe('uncertain');
});
