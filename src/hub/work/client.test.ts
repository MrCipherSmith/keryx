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
});
