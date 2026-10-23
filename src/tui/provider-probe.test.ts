// Flow 471: the [Test] probe shared by the Add provider tab and Telegram's /connect.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProviderConnection } from "./tui-shell";

describe("probeProviderConnection", () => {
  it("answers no-credential without any network call when a key provider has no key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keryx-probe-"));
    try {
      let calls = 0;
      const outcome = await probeProviderConnection("openai", {
        configDir: dir,
        env: {},
        requireCredential: true,
        fetch: (async () => {
          calls += 1;
          throw new Error("must not be called");
        }) as unknown as typeof fetch,
      });
      expect(outcome).toEqual({ kind: "no-credential" });
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers unknown for a name nobody registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keryx-probe-"));
    try {
      expect(await probeProviderConnection("no-such-provider", { configDir: dir, env: {}, requireCredential: true })).toEqual({ kind: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
