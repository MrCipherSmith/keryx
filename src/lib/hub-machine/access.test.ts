import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Control } from '../../remote-control/protocol';
import { hubAccessHeaders } from './access';
import { MachineConnection, enrollMachine, readScopedHubFlows, readSessionActionAuthority, readSessionSelectionAuthority } from './client';
import { MachineContextSync } from './context';
const ID = 'cf-test-id.access', SECRET = 'cf-test-secret-' + 'Z'.repeat(24), BEARER = 's'.repeat(43);
const NAMES = ['KERYX_CF_ACCESS_CLIENT_ID', 'KERYX_CF_ACCESS_CLIENT_SECRET'] as const;
/** Runs with exactly this Access environment and restores the caller's afterwards. */
const put = (name: string, value: string | undefined) => { if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; } };
async function withAccess<T>(access: { id?: string; secret?: string }, run: () => Promise<T>): Promise<T> {
    const saved = NAMES.map(name => process.env[name]), next = [access.id, access.secret];
    try {
        NAMES.forEach((name, i) => put(name, next[i]));
        return await run();
    }
    finally {
        NAMES.forEach((name, i) => put(name, saved[i]));
    }
}
const welcome = JSON.stringify({ v: 2, type: 'welcome', messageId: 'welcome', epoch: 4, payload: { machineId: 'machine-a', heartbeatSeconds: 20, heartbeatTimeoutSeconds: 60, resumeMode: 'replay', hubSequence: 0 } });
/** A real local Hub that records the headers of every request and upgrade it receives. */
function hub(status = 200) {
    const seen: Headers[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(r, s) {
            seen.push(r.headers);
            const route = new URL(r.url).pathname;
            if (route === '/hub/v2/machines/socket') {
                if (status === 200 && s.upgrade(r))
                    return;
                return new Response('', { status: status === 200 ? 400 : status });
            }
            if (status !== 200)
                return new Response('', { status });
            if (route === '/hub/v2/machines/enroll')
                return Response.json({ machineId: 'machine-a', secret: BEARER });
            if (route.endsWith('/context'))
                return Response.json({ revision: 1, fullSnapshot: true, manifest: [], documents: [], deletedDocumentIds: [] });
            return Response.json({});
        }, websocket: { message(ws) { ws.send(welcome); } } });
    return { server, seen, origin: server.url.origin };
}
const connection = (hubUrl: string) => new MachineConnection({ hubUrl, machineId: 'machine-a', secret: BEARER, ledgerId: 'l', daemonId: 'd', agentVersion: 'test', onFrame: () => { } });
const session = { sessionId: 's', projectId: 'p', controller: { state: 'held', actorId: 'human', expiresAt: new Date(Date.now() + 60000).toISOString() }, activeRunId: 'r', activeTurnId: 't' } as unknown as Control['SessionRecord'];
const context = (root: string) => { const cwd = path.join(root, 'repo'); mkdirSync(path.join(cwd, '.metaproject'), { recursive: true }); writeFileSync(path.join(cwd, '.metaproject', 'index.md'), '# Index'); return { cwd, cacheRoot: path.join(root, 'cache') }; };
/** Every way the machine reaches the Hub over HTTP. A settled call is enough: the Hub above records what arrived. */
const throwing: Record<string, (origin: string) => Promise<unknown>> = {
    enroll: origin => enrollMachine(origin, { code: 'c'.repeat(22), agentVersion: 'test', ledgerId: 'ledger-a' }),
    request: origin => connection(origin).request('/hub/v2/machines/machine-a'),
    flows: origin => readScopedHubFlows({ hubUrl: origin, secret: BEARER, projectId: 'p' }),
    context: async (origin) => {
        const root = mkdtempSync(path.join(tmpdir(), 'machine-access-'));
        try {
            const { cwd, cacheRoot } = context(root);
            return await new MachineContextSync({ hubUrl: origin, token: BEARER, cacheRoot, mappings: [{ projectId: 'p', checkoutId: 'c', cwd, profileId: 'native' }] }).invalidate('p', 1);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
};
/** These return a closed answer instead of throwing; with half a token the answer is the refusal and nothing was sent. */
const failClosed: Record<string, [(origin: string) => Promise<unknown>, unknown]> = {
    action: [origin => readSessionActionAuthority({ hubUrl: origin, secret: BEARER, action: { session, runId: 'r', turnId: 't', kind: 'model' } }), false],
    selection: [origin => readSessionSelectionAuthority({ hubUrl: origin, secret: BEARER, action: { session, actorId: 'human', request: {}, signal: new AbortController().signal } as never }), { status: 'unknown' }]
};
const calls = { ...throwing, action: failClosed.action![0], selection: failClosed.selection![0] };
test('both variables set: every HTTP call to the Hub carries both Access headers beside its own credentials', async () => {
    const { server, seen, origin } = hub();
    try {
        await withAccess({ id: ID, secret: SECRET }, async () => {
            for (const [name, call] of Object.entries(calls)) {
                seen.length = 0;
                await call(origin);
                expect(seen.length, name).toBeGreaterThan(0);
                for (const headers of seen) {
                    expect(headers.get('cf-access-client-id'), name).toBe(ID);
                    expect(headers.get('cf-access-client-secret'), name).toBe(SECRET);
                }
            }
            seen.length = 0;
            await calls.request!(origin);
            expect(seen[0]!.get('authorization')).toBe(`Bearer ${BEARER}`);
        });
    }
    finally {
        server.stop(true);
    }
});
test('neither variable set: no call sends an Access header', async () => {
    const { server, seen, origin } = hub();
    try {
        await withAccess({}, async () => {
            for (const [name, call] of Object.entries(calls)) {
                seen.length = 0;
                await call(origin);
                expect(seen.length, name).toBeGreaterThan(0);
                for (const headers of seen)
                    expect([...headers.keys()].filter(key => key.startsWith('cf-access')), name).toEqual([]);
            }
        });
    }
    finally {
        server.stop(true);
    }
});
test('only one variable set: each call refuses with a typed error before the Hub sees any request', async () => {
    const { server, seen, origin } = hub();
    try {
        for (const access of [{ id: ID }, { secret: SECRET }])
            await withAccess(access, async () => {
                for (const [name, call] of Object.entries(throwing)) {
                    const failure = await call(origin).then(() => undefined, (cause: unknown) => cause);
                    expect(failure, name).toMatchObject({ name: 'MachineError', code: 'cloudflare-access-incomplete' });
                    expect(String(failure), name).not.toContain(ID);
                    expect(String(failure), name).not.toContain(SECRET);
                }
                for (const [name, [call, closed]] of Object.entries(failClosed))
                    expect(await call(origin), name).toEqual(closed);
                await expect(connection(origin).connect()).rejects.toMatchObject({ name: 'MachineError', code: 'cloudflare-access-incomplete' });
            });
        expect(seen.length).toBe(0);
    }
    finally {
        server.stop(true);
    }
});
test('WebSocket upgrade carries both Access headers beside the machine bearer; neither set sends none; one set is refused untouched', async () => {
    const { server, seen, origin } = hub();
    const client = connection(origin);
    try {
        await withAccess({}, async () => {
            await client.connect();
            expect(client.connected).toBe(true);
            client.close();
        });
        expect(seen.length).toBe(1);
        expect([...seen[0]!.keys()].filter(key => key.startsWith('cf-access'))).toEqual([]);
        expect(seen[0]!.get('authorization')).toBe(`Bearer ${BEARER}`);
        seen.length = 0;
        await withAccess({ secret: SECRET }, async () => {
            await expect(client.connect()).rejects.toMatchObject({ name: 'MachineError', code: 'cloudflare-access-incomplete' });
        });
        expect(seen.length).toBe(0);
        expect(client.connected).toBe(false);
        await withAccess({ id: ID, secret: SECRET }, async () => {
            await client.connect();
            expect(client.connected).toBe(true);
        });
        expect(seen.length).toBe(1);
        expect(seen[0]!.get('cf-access-client-id')).toBe(ID);
        expect(seen[0]!.get('cf-access-client-secret')).toBe(SECRET);
        expect(seen[0]!.get('authorization')).toBe(`Bearer ${BEARER}`);
        expect(seen[0]!.get('sec-websocket-protocol')).toBe('keryx.hub.machine.v2');
    }
    finally {
        client.close();
        server.stop(true);
    }
});
test('no failure, whether refused, rejected by the Hub, unreachable or a failed upgrade, ever contains an Access value', async () => {
    const everything = (cause: unknown): string => { const e = cause as Error & { cause?: unknown }; return [e.message, String(e), e.stack ?? '', JSON.stringify(e, Object.getOwnPropertyNames(e)), e.cause === undefined ? '' : everything(e.cause)].join('\n'); };
    const failures: unknown[] = [];
    const settle = async (run: () => Promise<unknown>) => { failures.push(await run().then(() => undefined, (cause: unknown) => cause)); };
    const rejecting = hub(403), gone = hub(), failingUpgrade = hub(400);
    await gone.server.stop(true);
    try {
        await withAccess({ id: ID, secret: SECRET }, async () => {
            await settle(() => enrollMachine(rejecting.origin, { code: 'c'.repeat(22), agentVersion: 'test', ledgerId: 'ledger-a' }));
            await settle(() => connection(rejecting.origin).request('/hub/v2/machines/machine-a'));
            await settle(() => readScopedHubFlows({ hubUrl: rejecting.origin, secret: BEARER, projectId: 'p' }));
            await settle(() => connection(gone.origin).request('/hub/v2/machines/machine-a'));
            await settle(() => enrollMachine(gone.origin, { code: 'c'.repeat(22), agentVersion: 'test', ledgerId: 'ledger-a' }));
            await settle(() => connection(failingUpgrade.origin).connect());
            await settle(() => connection(rejecting.origin).connect());
        });
        for (const access of [{ id: ID, secret: SECRET + ' with space' }, { id: ID, secret: '' }, { id: 'x'.repeat(8193), secret: SECRET }, { id: ID }, { secret: SECRET }])
            await withAccess(access, async () => { await settle(async () => hubAccessHeaders(rejecting.origin)); });
        expect(failures.every(failure => failure !== undefined)).toBe(true);
        expect(failures.length).toBe(12);
        for (const failure of failures)
            for (const value of [ID, SECRET, SECRET + ' with space'])
                expect(everything(failure)).not.toContain(value);
    }
    finally {
        rejecting.server.stop(true);
        failingUpgrade.server.stop(true);
    }
});
test('helper follows the MCP bridge rules: trusted URL first, both or neither, printable bounded values, environment only', () => {
    const env = { KERYX_CF_ACCESS_CLIENT_ID: ID, KERYX_CF_ACCESS_CLIENT_SECRET: SECRET };
    expect(hubAccessHeaders('https://hub.example.com', env)).toEqual({ 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET });
    expect(hubAccessHeaders('http://127.0.0.1:8787', env)).toEqual({ 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET });
    expect(hubAccessHeaders('https://hub.example.com', {})).toEqual({});
    for (const url of ['http://hub.example.com', 'https://user:pass@hub.example.com', 'https://hub.example.com/path', 'https://hub.example.com/?q=1', 'https://hub.example.com/#f', 'not a url'])
        expect(() => hubAccessHeaders(url, env), url).toThrow('invalid-hub-url');
    for (const [id, secret] of [[ID, undefined], [undefined, SECRET]] as const)
        expect(() => hubAccessHeaders('https://hub.example.com', { KERYX_CF_ACCESS_CLIENT_ID: id, KERYX_CF_ACCESS_CLIENT_SECRET: secret })).toThrow('cloudflare-access-incomplete');
    for (const bad of ['', 'has space', 'tab\there', 'café', 'x'.repeat(8193)])
        expect(() => hubAccessHeaders('https://hub.example.com', { KERYX_CF_ACCESS_CLIENT_ID: bad, KERYX_CF_ACCESS_CLIENT_SECRET: SECRET }), JSON.stringify(bad.slice(0, 12))).toThrow('cloudflare-access-invalid');
    expect(hubAccessHeaders('https://hub.example.com', { KERYX_CF_ACCESS_CLIENT_ID: 'x'.repeat(8192), KERYX_CF_ACCESS_CLIENT_SECRET: SECRET })['CF-Access-Client-Id']!.length).toBe(8192);
});
