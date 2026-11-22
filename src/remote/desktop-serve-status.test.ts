import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { defaultServeConfig, saveServeConfig } from "../lib/serve-config";
import { desktopServeStatus } from "./desktop-serve-status";
import { endpointPath } from "./endpoint";
import { mintShellToken, derivedBearerNonce, serveResponseProof, SERVE_PROOF_HEADER } from "./shell-token";

test("accepts only a proven server advertising the Desktop capability", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-desktop-status-"));
  try {
    const token = mintShellToken(dir);
    if (!token.ok) throw new Error("fixture token failed");
    let capability = true;
    let forged = false;
    let sessions = 0;
    const port = 17870;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const nonce = derivedBearerNonce(bearer);
      const body = JSON.stringify({ machine: "test", telegram: { state: "disconnected", sessions }, ...(capability ? { capabilities: { desktopTelegram: 1 } } : {}) });
      const proof = nonce === undefined || forged ? "invalid" : serveResponseProof(token.value, nonce, "channels-status", 200, body);
      return new Response(body, { headers: { [SERVE_PROOF_HEADER]: proof } });
    }) as typeof fetch;
    const probe = () => desktopServeStatus(dir, { fetchImpl, portAvailable: async () => false });
    expect(saveServeConfig(defaultServeConfig("local", { port }), dir)).toBe(true);
    writeOwnerOnlyFileAtomic(endpointPath(dir), JSON.stringify({ address: "127.0.0.1", port, pid: process.pid }));
    expect(await probe()).toEqual({ state: "running", pid: process.pid, activeSessions: 0 });
    sessions = 2;
    expect(await probe()).toEqual({ state: "running", pid: process.pid, activeSessions: 2 });
    sessions = -1;
    expect(await probe()).toEqual({ state: "running", pid: process.pid });
    capability = false;
    expect(await probe()).toMatchObject({ state: "blocked", reason: expect.stringContaining("incompatible") });
    capability = true;
    forged = true;
    expect(await probe()).toMatchObject({ state: "blocked", reason: expect.stringContaining("unverified") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
