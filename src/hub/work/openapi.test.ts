import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { workOpenApi, matchesWorkSchema } from "./openapi";

test("published OpenAPI is the exact generated closed HTTP contract", async () => {
    const published = await Bun.file(new URL("../../../docs/requirements/hub-work-management/openapi.json", import.meta.url)).json();
    expect(published).toEqual(workOpenApi);
    expect(workOpenApi.openapi).toBe("3.1.0");
    expect(Object.keys(workOpenApi.paths)).toHaveLength(26);
});

test("responses reject unknown fields, invalid records, and unsupported actions", () => {
    expect(matchesWorkSchema({ records: [], nextCursor: null, eventCursor: "opaque-cursor" }, { $ref: "#/components/schemas/Page" })).toBe(true);
    expect(matchesWorkSchema({ records: [], nextCursor: null, eventCursor: "opaque-cursor", secret: "bad" }, { $ref: "#/components/schemas/Page" })).toBe(false);
    expect(matchesWorkSchema({ records: [], actions: [{ command: "trust.me", allowed: true, reasonCode: "ok" }], eventCursor: "opaque-cursor" }, { $ref: "#/components/schemas/Aggregate" })).toBe(false);
});

test('every published schema reference resolves within the OpenAPI document', () => {
    function check(value: unknown) {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
            if (key === '$ref') {
                expect(typeof item).toBe('string');
                expect(String(item).startsWith('#/components/schemas/')).toBe(true);
                expect(Object.hasOwn(workOpenApi.components.schemas, String(item).replace('#/components/schemas/', ''))).toBe(true);
            } else check(item);
        }
    }
    check(workOpenApi);
});

test('web contract copies remain identical to canonical schemas and vocabulary stays explicitly supported', async () => {
    const vocabulary = new Set(['$id', '$ref', '$schema', '$comment', '$defs', 'title', 'description', 'additionalProperties', 'anyOf', 'const', 'enum', 'items', 'maxItems', 'maxLength', 'maxProperties', 'minItems', 'minLength', 'minimum', 'maximum', 'oneOf', 'pattern', 'propertyNames', 'properties', 'required', 'type']);
    function inspect(schema: unknown) {
        if (Array.isArray(schema)) { for (const item of schema) inspect(item); return; }
        if (!schema || typeof schema !== 'object') return;
        for (const [key, value] of Object.entries(schema)) {
            expect(vocabulary.has(key)).toBe(true);
            if (key === 'properties' || key === '$defs') for (const child of Object.values(value as Record<string, unknown>)) inspect(child);
            else if (!['const', 'enum', 'required'].includes(key)) inspect(value);
        }
    }
    for (const name of ['domain', 'command', 'event']) {
        const canonical = await Bun.file(new URL(`../../../docs/requirements/hub-work-management/schemas/${name}.schema.json`, import.meta.url)).json();
        const web = await Bun.file(new URL(`../../../apps/hub-web/src/features/managed-work/${name}-schema.json`, import.meta.url)).json();
        expect(web).toEqual(canonical); inspect(canonical);
    }
});


test('browser schema copies are reproducibly generated and their check is read-only', async () => {
    const root = new URL('../../../', import.meta.url);
    const paths = ['command', 'domain', 'event'].map(name => new URL(`apps/hub-web/src/features/managed-work/${name}-schema.json`, root));
    const before = await Promise.all(paths.map(path => Bun.file(path).text()));
    const child = Bun.spawn([process.execPath, 'scripts/sync-hub-work-schemas.ts', '--check'], { cwd: fileURLToPath(root), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('match the canonical protocol');
    expect(await Promise.all(paths.map(path => Bun.file(path).text()))).toEqual(before);
});
