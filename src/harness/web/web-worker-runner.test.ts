import { expect, test } from "bun:test";
import { SystemWebWorkerRunner } from "./web-worker-runner";

test("system web worker fails closed on an unsupported host", async () => {
  const runner = new SystemWebWorkerRunner({ platform: "win32", workspace: "/project", home: "/home/user" });
  await expect(runner.run({ url: "https://example.com", hostname: "example.com", address: "93.184.216.34", method: "GET" }))
    .resolves.toEqual({ ok: false, reason: "web sandbox launcher is unavailable" });
});
