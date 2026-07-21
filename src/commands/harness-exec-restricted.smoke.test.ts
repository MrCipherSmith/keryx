// Live smoke for `keryx harness exec --allowed-domains` (flow 098 slice 3).
// Flag-gated (KERYX_ALLOW_REAL_SUBPROCESS=1) + a platform with a launcher.
// Proves the restricted-network wiring end-to-end through the real CLI: the
// loopback allowlist proxy (worker) starts, the contained curl is pointed at it
// via HTTP_PROXY, the OS sandbox allows only that socket, and the proxy enforces
// the domain allowlist.
//
// Deterministic + offline: the requested host is NOT on the allowlist, so the
// proxy returns its 403 body WITHOUT ever contacting any upstream (no internet).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSandboxLauncher } from "../harness/process/sandbox/detect";

const flag = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
const launcherAvailable = detectSandboxLauncher().available;
// `network: restricted` is enforced on macOS only. On Linux the launcher cannot
// express "deny all network except this one loopback socket" (that needs a
// network namespace plus a relay), so wrapWithSandbox fails CLOSED there — which
// is its own assertion, below.
const supported = process.platform === "darwin" && launcherAvailable;

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

      // The denial is REPORTED, not just enforced. Without this, a blocked host
      // is invisible to the caller: curl exits 0 here (a 403 is a successful HTTP
      // transaction), so the outcome alone cannot tell "denied" from "fetched".
      const blob = JSON.parse(logs[logs.length - 1] as string) as {
        network?: {
          restricted?: boolean;
          decisions?: Array<{ host: string; allowed: boolean; count: number }>;
        };
      };
      expect(blob.network?.restricted).toBe(true);
      expect(blob.network?.decisions).toContainEqual({
        host: "blocked.invalid",
        allowed: false,
        count: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The other half of the same contract: on Linux a restricted-network run must
// refuse with an explicit reason rather than quietly running with FULL host
// network. Silently downgrading "only these domains" to "everything" would be
// the worst possible failure mode, so it is asserted, not assumed.
describe.skipIf(!flag || process.platform !== "linux" || !launcherAvailable)(
  "harness exec --allowed-domains fails closed on Linux",
  () => {
    test("a restricted-network run is blocked with a reason, never silently unrestricted", async () => {
      const { harnessCommand } = await import("./harness");
      const logs: string[] = [];
      const original = console.log;
      // biome-ignore lint: capture console for this test only.
      console.log = (...v: unknown[]) =>
        logs.push(v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      try {
        await harnessCommand([
          "exec",
          "--allow-real-subprocess",
          "--allow-env",
          "PATH",
          "--allowed-domains",
          "example.com",
          "--",
          "/bin/echo",
          "hi",
        ]);
      } finally {
        console.log = original;
      }

      const blob = JSON.parse(logs[logs.length - 1] as string) as {
        outcome?: { kind?: string; reason?: string };
      };
      expect(blob.outcome?.kind).toBe("blocked");
      expect(blob.outcome?.reason).toContain("not yet enforced on Linux");
    });
  },
);
