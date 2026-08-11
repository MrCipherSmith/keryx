import { expect, test } from "bun:test";
import { FwkReadService } from "./fwk-service";
import { createSacAuthorizationServer, type SacVerifiedPrincipal } from "./index";

const stamp = "2026-08-11T00:00:00Z";
const source = async () => ({
  facts: [{ id: "fact-a", uri: "./evidence/a", revision: "r1", observedAt: stamp, expiresAt: "2099-01-01T00:00:00Z", trust: "primary" as const, visible: true, statement: "verified fact" }],
  work: { flowRef: { uri: "./flows/148", snapshot: "in-progress", revision: "r1" }, completed: ["T1"], next: ["T2"] },
  knowHow: [{ id: "wiki-a", kind: "wiki" as const, uri: "./wiki/a", revision: "r1", trust: "accepted" as const, status: "fresh" as const, accepted: true, visible: true }],
});
const make = (guard: import("./index").StrictSacGuard = { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" }, authenticateRequest: (request: unknown) => Promise<SacVerifiedPrincipal | undefined> = async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" })) => new FwkReadService({ guard, authorizationServer: createSacAuthorizationServer({ authenticateRequest }), source: async () => source(), canonical: { traceRef: "./context/traces/1", configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" }, now: () => new Date(stamp) });
const read = (service: FwkReadService, overrides: Partial<{ workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required: string[]; optional: string[] }> = {}) => service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "fwk-read-correlation-0001", budget: { maxItems: 3, maxTokens: 100 }, ...overrides });

test("mandatory budget overflow is typed and has no manifest or receipt", async () => {
  const result = await read(make(), { budget: { maxItems: 0, maxTokens: 0 } });
  expect(result).toEqual({ code: "context_overflow", requiredId: "fact-a" });
  expect("receipt" in result).toBe(false);
});
test("optional omissions are partial and every omission is named", async () => {
  const result = await read(make(), { budget: { maxItems: 1, maxTokens: 100 }, optional: ["work", "wiki-a"] });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.partial).toBe(true); expect(result.omittedOptional).toEqual(["work", "wiki-a"]);
  expect(result.receipt.contextAssembly.omittedOptional).toEqual(["./ids/work", "./ids/wiki-a"]);
});
test("receipts contain canonical trace/revisions and no forbidden raw fields", async () => {
  const result = await read(make());
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt).toMatchObject({ decision: "allowed", contextAssembly: { traceRef: "./context/traces/1", configurationRevision: "context-r1" }, policy: { revision: "policy-r1" } });
  expect(JSON.stringify(result.receipt)).not.toContain("verified fact");
});
test("disabled and advisory guard deny disclosure while retaining metadata-only receipt", async () => {
  for (const guard of [{ mode: "disabled" }, { mode: "advisory", decision: "pass" }] as const) {
    const result = await read(make(guard));
    expect("code" in result).toBe(false); if ("code" in result) continue;
    expect(result.manifest.freshness).toBe("denied"); expect(result.receipt.decision).toBe("denied");
  }
});

test("a caller supplied actor claim cannot mint a trusted FWK identity", async () => {
  const service = make(undefined, async (request) => request === undefined
    ? { subject: "user:owner", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }
    : undefined);
  const result = await read(service, { request: { actor: "user:owner", roles: ["owner"] } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.freshness).toBe("denied");
  expect(result.receipt.actor).toBe("service:untrusted");
});
