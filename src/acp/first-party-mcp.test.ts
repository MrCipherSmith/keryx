import { describe, expect, test } from "bun:test";
import { approvalFromPermissionResponse, permissionOptionsFor } from "./permission";
import { firstPartyFloorExempt, firstPartyServerOf, parseAcpMcpServers } from "./session-mcp";

test("a first-party entry's owned tool-name prefixes are read; junk and ordinary servers own nothing", () => {
  const parsed = parseAcpMcpServers("session/new", [
    { name: "keryx-panels", command: "/app", args: [], env: [], _meta: { keryx: { firstParty: true, owns: ["browser_", "", "x", "Browser_", 7, "browser_"] } } },
    { name: "other", command: "/o", args: [], env: [], _meta: { keryx: { owns: ["terminal_"] } } },
  ]);
  expect([...(parsed.owned ?? new Map()).entries()]).toEqual([["keryx-panels", ["browser_"]]]);
});

describe("first-party client MCP servers (desktop side panel, D-13)", () => {
  test("an entry marked _meta.keryx.firstParty is recorded with its floor tools", () => {
    const parsed = parseAcpMcpServers("session/new", [
      { name: "keryx-panels", command: "/app", args: ["--panel-mcp"], env: [], _meta: { keryx: { firstParty: true, floorTools: ["terminal_run"] } } },
      { name: "other", command: "/bin/other", args: [], env: [] },
    ]);
    expect([...(parsed.firstParty?.keys() ?? [])]).toEqual(["keryx-panels"]);
    expect(firstPartyFloorExempt(parsed.firstParty, "keryx-panels__browser_click")).toBe(true);
    expect(firstPartyFloorExempt(parsed.firstParty, "keryx-panels__terminal_run")).toBe(false);
    expect(firstPartyFloorExempt(parsed.firstParty, "other__thing")).toBe(false);
    expect(firstPartyServerOf(parsed.firstParty, "keryx-panels__terminal_run")).toBe("keryx-panels");
  });

  test("without the mark nothing is first-party", () => {
    const parsed = parseAcpMcpServers("session/new", [{ name: "keryx-panels", command: "/app", args: [], env: [] }]);
    expect(parsed.firstParty).toBeUndefined();
    expect(firstPartyFloorExempt(parsed.firstParty, "keryx-panels__browser_click")).toBe(false);
  });

  test("a grantable MCP call offers 'Allow for this session', which answers trustMcpTool", () => {
    const meta = { fingerprint: "fp", destructive: true, mcpTrustAvailable: true } as const;
    const options = permissionOptionsFor(meta);
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
    expect(options[1]!.name).toBe("Allow for this session");
    const answer = approvalFromPermissionResponse({ outcome: { outcome: "selected", optionId: "allow_always" } }, options, "fp", true);
    expect(answer).toEqual({ approved: true, fingerprint: "fp", trustMcpTool: true });
    expect(approvalFromPermissionResponse({ outcome: { outcome: "selected", optionId: "allow_once" } }, options, "fp", true)).toBe(true);
  });

  test("a destructive call that cannot be trusted still offers no 'always'", () => {
    const options = permissionOptionsFor({ fingerprint: "fp", destructive: true, untrustedOrigin: true });
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "reject_once", "reject_always"]);
  });
});
