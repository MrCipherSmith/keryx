import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "../server";
import { operatorToken, reviewerToken, agentToken } from "./fixture.test-support";
test("remote v2 refuses a non-loopback plaintext public origin while retaining v1 token recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-transport-")); const server = startHub({ dataDir: dir, operatorToken, reviewerToken, agentToken, host: "127.0.0.1", port: 0, publicOrigin: "http://public.example" });
  try {
    const login = await fetch(`${server.url.origin}/hub/v1/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: operatorToken }) }); expect(login.status).toBe(200); const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const response = await fetch(`${server.url.origin}/hub/v2/machines/pairings`, { method: "POST", headers: { Cookie: cookie, Origin: "http://public.example", "Idempotency-Key": "plaintext", "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "denied", projectIds: ["p"] }) }); expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("forbidden");
  } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
