// Live smoke for `keryx harness exec --allowed-domains` (flow 098 slice 3).
// Flag-gated (KERYX_ALLOW_REAL_SUBPROCESS=1) + macOS. Proves the restricted-
// network wiring end-to-end through the real CLI: the loopback allowlist proxy
// (worker) starts, the contained curl is pointed at it via HTTP_PROXY, the OS
// sandbox allows only that socket, and the proxy enforces the domain allowlist.
//
// Deterministic + offline: the requested host is NOT on the allowlist, so the
// proxy returns its 403 body WITHOUT ever contacting any upstream (no internet).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const flag = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
const supported = process.platform === "darwin";

describe.skipIf(!flag || !supported)("harness exec --allowed-domains restricted network (macOS)", () => {
  test("a non-allowlisted host is refused by the loopback proxy, not reached", async () => {
    const { harnessCommand } = await import("./harness");
    // Write curl's output under the session tmp (a sandbox writable root).
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-exec-net-")));
    const out = path.join(dir, "resp.txt");

    const logs: string[] = [];
    const original = console.log;
    // biome-ignore lint: capture console for this test only.
    console.log = (...v: unknown[]) => logs.push(v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    try {
      await harnessCommand([
        "exec",
        "--allow-real-subprocess",
        "--allow-env", "PATH",
        "--allow-env", "HOME",
        "--allowed-domains", "example.com",
        "--",
        "/usr/bin/curl", "-sS", "-m", "5", "-o", out, "http://blocked.invalid/",
      ]);
    } finally {
      console.log = original;
    }

    try {
      // The contained curl completed (containment: a non-zero curl exit is still
      // "completed"); the proxy wrote its allowlist-block body to the file.
      expect(logs.join("\n")).toContain('"kind":"completed"');
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("blocked by keryx sandbox network allowlist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
