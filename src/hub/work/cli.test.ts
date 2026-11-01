import { expect, test } from "bun:test";
import { runWorkCommand, WORK_HELP } from "./cli";

const binding = { url: "https://hub.test", projectId: "p1", checkoutId: "checkout1", tokenEnv: "WORK_TEST_TOKEN" };
const connector = { status: async () => ({ ok: true as const, connection: binding }), binding: async () => binding };
test("managed work CLI reads bound project with token env and safe output", async () => {
    const outputs: string[] = []; const calls: Request[] = [];
    await runWorkCommand(["flow", "list"], { connector, env: { WORK_TEST_TOKEN: "private-token" }, write: value => outputs.push(value), fetch: async request => { calls.push(request); return Response.json({ records: [], nextCursor: null, eventCursor: "opaque" }); } });
    expect(calls[0]?.url).toBe("https://hub.test/hub/work/v1/projects/p1/flows");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer private-token");
    expect(outputs.join("\n")).not.toContain("private-token");
    expect(JSON.parse(outputs[0]!)).toEqual({ records: [], nextCursor: null, eventCursor: "opaque" });
});
test("CLI preserves user-supplied idempotency envelope from stdin and never prints credentials", async () => {
    const envelope = { operationId: "original-operation", expectedVersions: { a1: 1 }, command: "attempt.report", payload: { attemptId: "a1", event: "progress", report: "Working" } };
    let sent = ""; let key: string | null = null;
    await runWorkCommand(["attempt", "report", "--input", "-"], { connector, env: { WORK_TEST_TOKEN: "private-token" }, readInput: async () => JSON.stringify(envelope), write: () => {}, fetch: async request => { sent = await request.text(); key = request.headers.get("Idempotency-Key"); return Response.json({ operationId: envelope.operationId, entities: [], receiptId: "receipt", eventCursor: "opaque" }); } });
    expect(JSON.parse(sent)).toEqual(envelope); expect(String(key)).toBe(envelope.operationId);
});
test("CLI refuses human transitions, extras and missing tokens before network", async () => {
    let calls = 0;
    const options = { connector, env: {}, write: () => {}, readInput: async () => JSON.stringify({ operationId: "op", expectedVersions: {}, command: "requirements.approve", payload: {} }), fetch: async () => { calls++; return Response.json({}); } };
    await expect(runWorkCommand(["command", "--input", "-"], options)).rejects.toThrow();
    await expect(runWorkCommand(["flow", "list", "--unexpected", "secret"], options)).rejects.toThrow();
    await expect(runWorkCommand(["flow", "list"], options)).rejects.toThrow("token environment variable is empty");
    expect(calls).toBe(0);
});
test("CLI status and help do not need tokens or network", async () => {
    const outputs: string[] = [];
    const options = { connector, env: {}, write: (value: string) => outputs.push(value), fetch: async () => { throw Error("network"); } };
    await runWorkCommand(["status"], options); await runWorkCommand(["--help"], options);
    expect(outputs[0]).not.toContain("WORK_TEST_TOKEN"); expect(outputs[1]).toBe(WORK_HELP);
});
test("CLI explicitly refreshes an exact Git subject using the original guarded operation", async () => {
    const input = { operationId: "git-observe-one", expectedVersions: { a1: 2 }, payload: { subjectDigest: "a".repeat(64) } };
    let path = ""; let body = "";
    await runWorkCommand(["subject", "observe", "s1", "--input", "-"], { connector, env: { WORK_TEST_TOKEN: "private-token" }, readInput: async () => JSON.stringify(input), write: () => {}, fetch: async request => { path = new URL(request.url).pathname; body = await request.text(); return Response.json({ operationId: input.operationId, observation: { id: "obs1", projectId: "p1", subjectId: "s1", subjectDigest: input.payload.subjectDigest, createdBy: "human:one", observedAt: "2026-11-01T00:00:00Z", generation: 1, artifacts: [], contentDigest: "b".repeat(64) }, receiptId: "receipt", eventCursor: "opaque" }); } });
    expect(path).toBe("/hub/work/v1/projects/p1/subjects/s1/observe"); expect(JSON.parse(body)).toEqual(input);
});
test('CLI fetches immutable document content with explicit exact version and digest',async()=>{const digest='a'.repeat(64);let url='';const outputs:string[]=[];await runWorkCommand(['document','show','d1','--version','2','--digest',digest],{connector,env:{WORK_TEST_TOKEN:'private-token'},write:value=>outputs.push(value),fetch:async request=>{url=request.url;return Response.json({document:{id:'d1',projectId:'p1',path:'wiki/test.md',kind:'wiki',version:2,contentDigest:digest,content:'Exact archived context'},eventCursor:'opaque'});}});expect(url).toBe('https://hub.test/hub/work/v1/projects/p1/documents/d1/versions/2?digest='+digest);expect(JSON.parse(outputs[0]!).document.content).toBe('Exact archived context');});

test('CLI sends valid attempt.submit coverage through the canonical contract', async () => {
    const envelope = { operationId: 'submit-real', command: 'attempt.submit', expectedVersions: { a1: 1 }, payload: {
        attemptId: 'a1', subjectId: 's1', subjectDigest: 'a'.repeat(64), evidenceIds: [],
        coverage: [{ criterionId: 'ic', result: 'missing', evidenceIds: [] }],
        knowledgeFollowup: { proposalIds: [], noUpdateReason: 'None' },
    } };
    let sent = '';
    await runWorkCommand(['attempt', 'submit', '--input', '-'], { connector, env: { WORK_TEST_TOKEN: 'private-token' }, readInput: async () => JSON.stringify(envelope), write: () => {}, fetch: async request => {
        sent = await request.text(); return Response.json({ operationId: envelope.operationId, entities: [], receiptId: 'receipt', eventCursor: 'opaque' });
    } });
    expect(JSON.parse(sent)).toEqual(envelope);
});
