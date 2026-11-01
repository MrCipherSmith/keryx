import { describe, expect, test } from "bun:test";
import { createWorkClient, listWorkMcpTools, resolveWorkMcpOperation, WorkClientError } from "./client";

describe("managed work transport", () => {
    test("encodes IDs and rejects unsupported response projections", async () => {
        let url = "";
        const client = createWorkClient({ baseUrl: "https://hub.test", fetch: async request => {
            url = request.url;
            return Response.json({ records: [{ kind: "surprise" }], nextCursor: null, eventCursor: "opaque-cursor" });
        } });
        await expect(client.listFlows("project/one")).rejects.toBeInstanceOf(WorkClientError);
        expect(url).toBe("https://hub.test/hub/work/v1/projects/project%2Fone/flows");
    });
    test("a retry preserves the original command body and operation key", async () => {
        const sent: { key: string | null; body: string }[] = [];
        const client = createWorkClient({ baseUrl: "https://hub.test", fetch: async request => {
            sent.push({ key: request.headers.get("Idempotency-Key"), body: await request.text() });
            if (sent.length === 1) throw new Error("network uncertain");
            return Response.json({ operationId: "op-1", entities: [], eventCursor: "opaque-cursor", receiptId: "receipt-1" });
        } });
        const command = { operationId: "op-1", expectedVersions: { attempt1: 1 }, command: "attempt.report" as const, payload: { attemptId: "attempt1", event: "progress" as const, report: "Working" } };
        const prepared = client.prepareCommand("p1", command);
        command.payload.report = "Changed after enqueue";
        await expect(prepared.send()).rejects.toBeInstanceOf(WorkClientError);
        await prepared.send();
        expect(sent[0]).toEqual(sent[1]);
        expect(sent[1]?.body).toContain("Working");
    });
    test("does not include backend error message or credentials in errors", async () => {
        const client = createWorkClient({ baseUrl: "https://hub.test", fetch: async () => Response.json({ error: { code: "forbidden", message: "secret token", retryable: false } }, { status: 403 }) });
        try { await client.listFlows("p1"); throw new Error("expected rejection"); }
        catch (error) { expect(String(error)).not.toContain("secret token"); expect(error).toBeInstanceOf(WorkClientError); }
    });
    test("read tools and contributor commands never expose protected transitions", () => {
        const names = listWorkMcpTools().map(tool => tool.name);
        expect(names).toContain("hub_work_attempt_report");
        expect(names).toContain("hub_work_get_context");
        for (const tool of listWorkMcpTools().filter(tool => !tool.annotations.readOnlyHint)) expect(tool.name).not.toMatch(/approve|amend|select|decide|cancel|convert|bind/);
        expect(resolveWorkMcpOperation("hub_work_attempt_report", { projectId: "p1", operationId: "op1", expectedVersions: { a1: 1 }, payload: { attemptId: "a1", event: "progress", report: "Hello" } })).toEqual({ operation: { path: "/hub/work/v1/projects/p1/commands", body: { operationId: "op1", expectedVersions: { a1: 1 }, command: "attempt.report", payload: { attemptId: "a1", event: "progress", report: "Hello" } } }, operationId: "op1" });
        expect(resolveWorkMcpOperation("hub_work_attempt_report", { projectId: "p1", operationId: "op1", expectedVersions: {}, payload: { attemptId: "a1", event: "progress", report: "Hello", source: "ci-observation" } })).toEqual({ error: "invalid-arguments" });
    });
    test("only operation polling accepts an explicit pending GET outcome", async () => {
        const client = createWorkClient({ baseUrl: "https://hub.test", fetch: async () => Response.json({ operationId: "op1", status: "pending", receiptId: null, result: null, eventCursor: null }, { status: 202 }) });
        expect(await client.operation("p1", "op1")).toEqual({ operationId: "op1", status: "pending", receiptId: null, result: null, eventCursor: null });
        await expect(client.listFlows("p1")).rejects.toBeInstanceOf(WorkClientError);
    });
});
test('exact document-version read requires digest and exposes only read-only scoped MCP',async()=>{const digest='a'.repeat(64);const tool=listWorkMcpTools().find(t=>t.name==='hub_work_get_document_version');expect(tool?.annotations.readOnlyHint).toBe(true);const input={projectId:'p',documentId:'d',version:1,digest};expect(resolveWorkMcpOperation('hub_work_get_document_version',input)).toEqual({operation:{path:'/hub/work/v1/projects/p/documents/d/versions/1?digest='+digest}});expect(resolveWorkMcpOperation('hub_work_get_document_version',{projectId:'p',documentId:'d',version:1})).toEqual({error:'invalid-arguments'});let path='';const client=createWorkClient({baseUrl:'https://hub.test',fetch:async request=>{path=request.url;return Response.json({document:{id:'d',projectId:'p',path:'wiki/test.md',kind:'wiki',version:1,contentDigest:digest,content:'Exact text'},eventCursor:'opaque'});}});const result=await client.read('get_document_version','p',{documentId:'d',version:1,digest});expect(result.document.content).toBe('Exact text');expect(path).toBe('https://hub.test/hub/work/v1/projects/p/documents/d/versions/1?digest='+digest);});

test('valid attempt submission coverage passes client preparation and contributor MCP while invalid coverage is refused', async () => {
    const envelope = { operationId: 'submit-one', command: 'attempt.submit' as const, expectedVersions: { a1: 1 }, payload: {
        attemptId: 'a1', subjectId: 's1', subjectDigest: 'a'.repeat(64), evidenceIds: [],
        coverage: [{ criterionId: 'ic', result: 'missing' as const, evidenceIds: [] }],
        knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' },
    } };
    const client = createWorkClient({ baseUrl: 'https://hub.test', fetch: async request => {
        expect(await request.json()).toEqual(envelope);
        return Response.json({ operationId: envelope.operationId, entities: [], eventCursor: 'opaque', receiptId: 'receipt' });
    } });
    await client.prepareCommand('p1', envelope).send();
    const { command: _command, ...args } = envelope;
    expect(resolveWorkMcpOperation('hub_work_attempt_submit', { projectId: 'p1', ...args })).toHaveProperty('operation');
    expect(resolveWorkMcpOperation('hub_work_attempt_submit', { projectId: 'p1', ...args, payload: { ...args.payload, coverage: [{ criterionId: 'ic', result: 'invented', evidenceIds: [] }] } })).toEqual({ error: 'invalid-arguments' });
});

test('MCP path identifiers reject dot segments before URL resolution', () => {
    for (const value of ['.', '..']) {
        expect(resolveWorkMcpOperation('hub_work_list_flows', { projectId: value })).toEqual({ error: 'invalid-arguments' });
        expect(resolveWorkMcpOperation('hub_work_get_attempt', { projectId: 'p1', attemptId: value })).toEqual({ error: 'invalid-arguments' });
    }
});
