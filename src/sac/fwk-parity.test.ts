import { expect, test } from "bun:test";
import { normalizeFwkResult, FwkReadService } from "./fwk-service";

test("CLI and MCP transport serialization use the identical normalized FWK fixture contract", async () => {
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "p1" },
    source: async () => ({ facts: [], knowHow: [] }),
    canonical: { traceRef: "./trace/a", configurationRevision: "c1", policyRef: "./policy/a", policyRevision: "p1" },
  });
  const result = await service.overview({ workspaceId: "workspace-a", actor: "user:owner", budget: { maxItems: 1, maxTokens: 1 } });
  const cliFixture = JSON.stringify(normalizeFwkResult(result));
  const mcpFixture = JSON.stringify(normalizeFwkResult(result));
  expect(cliFixture).toBe(mcpFixture);
});
