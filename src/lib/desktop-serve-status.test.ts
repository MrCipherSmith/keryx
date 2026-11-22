import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeOwnerOnlyFileAtomic } from "./config-dir";
import { defaultServeConfig, saveServeConfig } from "./serve-config";
import { desktopServeStatus } from "./desktop-serve-status";
import { endpointPath } from "../remote/endpoint";
import { mintShellToken, derivedBearerNonce, serveResponseProof } from "../remote/shell-token";

test("accepts only a proven server advertising the Desktop capability", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-desktop-status-"));
  const token = mintShellToken(dir);
  if (!token.ok) throw new Error("fixture token failed");
  let capability = true;
  let forged = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const nonce = derivedBearerNonce(bearer);
      const body = JSON.stringify({ machine: "test", telegram: { state: "disconnected", sessions: 0 }, ...(capability ? { capabilities: { desktopTelegram: 1 } } : {}) });
      const proof = nonce === undefined || forged ? "invalid" : serveResponseProof(token.value, nonce, "channels-status", 200, body);
      return new Response(body, { headers: { "x-keryx-serve-proof": proof } });
    },
  });
  try {
    const port = server.port;
    if (port === undefined) throw new Error("fixture did not bind a port");
    expect(saveServeConfig(defaultServeConfig("local", { port }), dir)).toBe(true);
    writeOwnerOnlyFileAtomic(endpointPath(dir), JSON.stringify({ address: "127.0.0.1", port, pid: process.pid }));
    expect(await desktopServeStatus(dir)).toEqual({ state: "running", pid: process.pid });
    capability = false;
    expect((await desktopServeStatus(dir)).state).toBe("blocked");
    capability = true;
    forged = true;
    expect((await desktopServeStatus(dir)).state).toBe("blocked");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
