// flow 142 (P4) — `keryx sandbox status`.
//
// AC2: report, not a gate — exits zero regardless of what it finds.
// AC3: "launcher not installed" and "not implemented on this platform" are
// different sentences, asserted to both exist and to never collapse into one
// another for the same row.
// AC6 covered separately by src/standard/command-registry.test.ts /
// command-registry.coverage.test.ts (registration + routing).

import { describe, expect, test } from "bun:test";
import {
  buildSandboxReport,
  renderSandboxReport,
  sandboxCommand,
  LAUNCHER_NOT_INSTALLED,
  NOT_IMPLEMENTED_ON_PLATFORM,
} from "./sandbox";

async function runCaptured(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("buildSandboxReport", () => {
  test("linux, bwrap present: filesystem + network available, allowlist/mask-env not implemented", () => {
    const report = buildSandboxReport({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      existsSync: (p) => p === "/usr/bin/bwrap",
    });
    expect(report.platform).toBe("linux");
    expect(report.launcher.available).toBe(true);

    const byCapability = Object.fromEntries(report.capabilities.map((c) => [c.capability, c]));
    expect(byCapability["Filesystem containment"]!.kind).toBe("available");
    expect(byCapability["Network OFF"]!.kind).toBe("available");
    expect(byCapability["Domain allowlist"]!.kind).toBe("not-implemented");
    expect(byCapability["Credential masking"]!.kind).toBe("not-implemented");
  });

  test("AC3: linux without bwrap — implemented capabilities say launcher-missing, unimplemented ones say not-implemented, never the other sentence", () => {
    const report = buildSandboxReport({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      existsSync: () => false,
    });
    expect(report.launcher.available).toBe(false);

    const byCapability = Object.fromEntries(report.capabilities.map((c) => [c.capability, c]));

    // Implemented on Linux, but the launcher is missing: "launcher not installed".
    for (const name of ["Filesystem containment", "Network OFF"]) {
      const row = byCapability[name]!;
      expect(row.kind).toBe("launcher-missing");
      expect(row.status).toContain(LAUNCHER_NOT_INSTALLED);
      expect(row.status).not.toContain(NOT_IMPLEMENTED_ON_PLATFORM);
    }

    // Not implemented on Linux AT ALL — installing bwrap would not change this,
    // and the sentence must say so, not "launcher not installed".
    for (const name of ["Domain allowlist", "Credential masking"]) {
      const row = byCapability[name]!;
      expect(row.kind).toBe("not-implemented");
      expect(row.status).toContain(NOT_IMPLEMENTED_ON_PLATFORM);
      expect(row.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    }
  });

  test("darwin, sandbox-exec present: every capability available", () => {
    const report = buildSandboxReport({
      platform: "darwin",
      existsSync: (p) => p === "/usr/bin/sandbox-exec",
    });
    expect(report.launcher.available).toBe(true);
    expect(report.capabilities.every((c) => c.kind === "available")).toBe(true);
  });

  test("darwin without sandbox-exec: every capability is launcher-missing, none say not-implemented", () => {
    const report = buildSandboxReport({ platform: "darwin", existsSync: () => false });
    expect(report.launcher.available).toBe(false);
    for (const cap of report.capabilities) {
      expect(cap.kind).toBe("launcher-missing");
      expect(cap.status).toContain(LAUNCHER_NOT_INSTALLED);
    }
  });

  test("unsupported platform: everything is not-implemented, not launcher-missing", () => {
    const report = buildSandboxReport({ platform: "win32" });
    for (const cap of report.capabilities) {
      expect(cap.kind).toBe("not-implemented");
      expect(cap.status).not.toContain(LAUNCHER_NOT_INSTALLED);
    }
  });
});

describe("renderSandboxReport", () => {
  test("renders platform, launcher, and every capability row", () => {
    const report = buildSandboxReport({ platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false });
    const text = renderSandboxReport(report);
    expect(text).toContain("Platform: linux");
    expect(text).toContain("Launcher: not found");
    for (const row of SANDBOX_MATRIX_LABELS) {
      expect(text).toContain(row);
    }
    // Never claims to gate anything.
    expect(text.toLowerCase()).toContain("not a gate");
  });
});

const SANDBOX_MATRIX_LABELS = ["Filesystem containment", "Network OFF", "Domain allowlist", "Credential masking"];

describe("sandboxCommand — AC2: report, not a gate", () => {
  test("never sets process.exitCode, even when the launcher is missing", async () => {
    process.exitCode = undefined;
    await sandboxCommand([], { platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false });
    expect(process.exitCode).toBeUndefined();
  });

  test("never sets process.exitCode on an unsupported platform either", async () => {
    process.exitCode = undefined;
    await sandboxCommand(["status"], { platform: "win32" });
    expect(process.exitCode).toBeUndefined();
  });

  test("--json prints valid, parseable JSON with the platform and capabilities", async () => {
    const lines = await runCaptured(() =>
      sandboxCommand(["status", "--json"], { platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false }),
    );
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { platform: string; capabilities: unknown[] };
    expect(parsed.platform).toBe("linux");
    expect(Array.isArray(parsed.capabilities)).toBe(true);
    expect(parsed.capabilities.length).toBe(4);
  });

  test("bare `sandbox` with no subcommand runs the same report as `sandbox status`", async () => {
    const bare = await runCaptured(() => sandboxCommand([], { platform: "darwin", existsSync: () => true }));
    const explicit = await runCaptured(() => sandboxCommand(["status"], { platform: "darwin", existsSync: () => true }));
    expect(bare).toEqual(explicit);
  });

  test("an unknown subcommand exits non-zero and does not silently run the report", async () => {
    const lines = await runCaptured(() => sandboxCommand(["frobnicate"]));
    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).not.toContain("Platform:");
    // Node/Bun quirk: `process.exitCode = undefined` does NOT clear a
    // previously-set numeric exit code (the setter no-ops on a non-number) —
    // only assigning an explicit `0` does. Without this, this test's exit
    // code leaks into the whole `bun test` process's own exit status.
    process.exitCode = 0;
  });
});
