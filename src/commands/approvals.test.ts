// `keryx approvals list|allow|deny` (flow 369 / R4d): the local answer path over
// the same store `keryx serve` writes. It reads and writes the store directly, so
// it works with no server running and a second process can answer what a running
// turn is waiting on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_ROUTES } from "../cli";
import { groupUsage } from "../cli-registry";
import { GROUP_SUBCOMMANDS } from "../lib/group-subcommands";
import { createApproval, newApprovalId, readApproval, readApprovalEvidence } from "../lib/serve-approvals-store";
import { approvalsCommand, approvalsSlashText } from "./approvals";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

let xdgRoot = "";
let configDir = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalXdg: string | undefined;

beforeEach(() => {
  xdgRoot = mkdtempSync(path.join(tmpdir(), "keryx-approvals-cli-"));
  configDir = path.join(xdgRoot, "keryx");
  originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgRoot;
  captured = [];
  originalLog = console.log;
  console.log = ((...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  }) as typeof console.log;
});

afterEach(() => {
  console.log = originalLog;
  if (originalXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdg;
  }
  rmSync(xdgRoot, { recursive: true, force: true });
});

function seed(overrides: { expiresInMs?: number; floors?: string[] } = {}): string {
  const id = newApprovalId();
  createApproval(
    {
      approvalId: id,
      turnId: randomUUID(),
      sessionId: randomUUID(),
      summary: 'Run tool "write_note" (risk: write)',
      scope: 'This one call to "write_note" only.',
      consequence: "Changes files in the project.",
      expiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 300_000)),
      correlationId: randomUUID(),
      callFingerprint: "a".repeat(64),
      floors: overrides.floors ?? [],
    },
    configDir,
  );
  return id;
}

const output = (): string => captured.join("\n");

describe("keryx approvals list", () => {
  test("says so when nothing is pending", async () => {
    await approvalsCommand(["list"]);
    expect(output()).toContain("No pending approvals.");
  });

  test("shows summary, scope, consequence, expiry and state for a pending approval", async () => {
    const id = seed();
    await approvalsCommand(["list"]);
    expect(output()).toContain(id);
    expect(output()).toContain("write_note");
    expect(output()).toContain("This one call");
    expect(output()).toContain("Changes files");
    expect(output()).toMatch(/expires in \d+m/);
    expect(output()).toContain("pending");
  });

  test("bare `keryx approvals` lists too", async () => {
    seed();
    await approvalsCommand([]);
    expect(output()).toContain("pending");
  });

  test("--all adds recently resolved approvals; the default hides them", async () => {
    const id = seed();
    await approvalsCommand(["deny", id]);
    captured.length = 0;
    await approvalsCommand(["list"]);
    expect(output()).toContain("No pending approvals.");
    expect(output()).not.toContain(id);
    captured.length = 0;
    await approvalsCommand(["list", "--all"]);
    expect(output()).toContain(id);
    expect(output()).toContain("denied");
  });

  test("--json prints the public projection and never the call fingerprint", async () => {
    const id = seed();
    await approvalsCommand(["list", "--json"]);
    const parsed = JSON.parse(output()) as { approvals: Array<{ approvalId: string; state: string }> };
    expect(parsed.approvals.map((entry) => entry.approvalId)).toEqual([id]);
    expect(output()).not.toContain("callFingerprint");
    expect(output()).not.toContain("a".repeat(64));
  });

  test("an unknown option is refused", async () => {
    await expect(approvalsCommand(["list", "--nope"])).rejects.toThrow(/Unknown option/);
  });
});

describe("keryx approvals allow|deny", () => {
  test("allow records the answer as the local CLI and appends evidence", async () => {
    const id = seed();
    await approvalsCommand(["allow", id]);
    const record = readApproval(id, configDir);
    expect(record.ok && record.value.state).toBe("allowed");
    expect(record.ok && record.value.answeredBy).toBe("local-cli");
    expect(readApprovalEvidence(configDir).some((event) => event.approvalId === id && event.kind === "resolved" && event.state === "allowed")).toBe(true);
    expect(output()).toContain("allowed");
  });

  test("deny records a deny", async () => {
    const id = seed();
    await approvalsCommand(["deny", id]);
    const record = readApproval(id, configDir);
    expect(record.ok && record.value.state).toBe("denied");
  });

  test("a second answer reports the ORIGINAL outcome and changes nothing", async () => {
    const id = seed();
    await approvalsCommand(["allow", id]);
    captured.length = 0;
    await approvalsCommand(["deny", id]);
    const record = readApproval(id, configDir);
    expect(record.ok && record.value.state).toBe("allowed");
    expect(output()).toContain("already allowed");
  });

  test("an expired approval is refused with the expiry named", async () => {
    const id = seed({ expiresInMs: -1_000 });
    await expect(approvalsCommand(["allow", id])).rejects.toThrow(/expired/);
  });

  test("an unknown id and a malformed id are refused the same way", async () => {
    await expect(approvalsCommand(["allow", newApprovalId()])).rejects.toThrow(/No such approval/);
    await expect(approvalsCommand(["allow", "../../etc/passwd"])).rejects.toThrow(/No such approval/);
  });

  test("a missing id or an extra argument prints usage as an error", async () => {
    await expect(approvalsCommand(["allow"])).rejects.toThrow(/Usage: keryx approvals allow <id>/);
    await expect(approvalsCommand(["deny", "a", "b"])).rejects.toThrow(/Usage: keryx approvals deny <id>/);
  });
});

describe("the real CLI route", () => {
  test("CLI_ROUTES dispatches the verb, and the group has its subcommand vocabulary", () => {
    expect(CLI_ROUTES.approvals).toBeDefined();
    expect(GROUP_SUBCOMMANDS.get("approvals")).toEqual(["list", "allow", "deny"]);
    expect(groupUsage("approvals")).toContain("keryx approvals list");
  });

  test("`keryx approvals list` run as a real process reaches the store and exits 0", () => {
    const id = seed();
    const run = Bun.spawnSync(["bun", "src/cli.ts", "approvals", "list"], {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_DATA_HOME: xdgRoot },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain(id);
  });

  test("a mistyped subcommand gets a did-you-mean from the real process, not a usage dump", () => {
    const run = Bun.spawnSync(["bun", "src/cli.ts", "approvals", "lst"], {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_DATA_HOME: xdgRoot },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("list");
  });

  test("`keryx approvals allow <id>` as a real process answers the record", () => {
    const id = seed();
    const run = Bun.spawnSync(["bun", "src/cli.ts", "approvals", "allow", id], {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_DATA_HOME: xdgRoot },
    });
    expect(run.exitCode).toBe(0);
    const record = readApproval(id, configDir);
    expect(record.ok && record.value.state).toBe("allowed");
  });
});

describe("the readline /approvals text", () => {
  test("lists pending and recently resolved approvals and says how to answer", async () => {
    const pending = seed();
    const answered = seed();
    await approvalsCommand(["deny", answered]);
    const text = approvalsSlashText("");
    expect(text).toContain(pending);
    expect(text).toContain("Recently resolved (1):");
    expect(text).toContain(answered);
    expect(text).toContain("/approvals allow <id>");
  });

  test("says so when there is nothing to answer", () => {
    expect(approvalsSlashText("list")).toContain("No pending approvals.");
    expect(approvalsSlashText("list")).not.toContain("/approvals allow");
  });

  test("allow and deny answer through the same store and report refusals as text", () => {
    const id = seed();
    expect(approvalsSlashText(`allow ${id}`)).toContain("may run once");
    const record = readApproval(id, configDir);
    expect(record.ok && record.value.answeredBy).toBe("local-cli");
    expect(approvalsSlashText(`deny ${id}`)).toContain("already allowed");
    expect(approvalsSlashText(`allow ${newApprovalId()}`)).toContain("No such approval");
    expect(approvalsSlashText("allow")).toContain("Usage: /approvals allow <id>");
    expect(approvalsSlashText("frobnicate")).toContain("Usage: /approvals [list");
  });
});
