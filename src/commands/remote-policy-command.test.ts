// Flow 396: `/remote-policy` and the one description of the Telegram permissions every surface prints.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveShellPermissions } from "../lib/shell-permissions";
import type { RemotePolicyPatch } from "../remote/config";
import {
  countSavedRules,
  formatPolicyDuration,
  isRemotePolicyCommand,
  loadPosture,
  parseRemotePolicyArgs,
  postureLines,
  postureSidebarText,
  remotePolicyText,
} from "./remote-policy-command";

let dir = "";
const configFile = (): string => path.join(dir, "remote", "config.json");

function seed(extra: Record<string, unknown> = {}): void {
  mkdirSync(path.join(dir, "remote"), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1], ...extra }), { mode: 0o600 });
}
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-remote-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formatPolicyDuration", () => {
  test("none for zero, then the unit that reads shortest", () => {
    expect(formatPolicyDuration(0)).toBe("none");
    expect(formatPolicyDuration(45_000)).toBe("45s");
    expect(formatPolicyDuration(900_000)).toBe("15m");
    expect(formatPolicyDuration(3_600_000)).toBe("1h");
    expect(formatPolicyDuration(5_400_000)).toBe("90m");
    expect(formatPolicyDuration(90_000)).toBe("1m 30s");
  });
});

describe("parseRemotePolicyArgs", () => {
  test("nothing means show", () => {
    expect(parseRemotePolicyArgs("")).toEqual({ action: "show" });
    expect(parseRemotePolicyArgs("   ")).toEqual({ action: "show" });
  });

  test("mode, limit and wait, alone or together, in minutes", () => {
    expect(parseRemotePolicyArgs("mode ask")).toEqual({ action: "set", patch: { permissionMode: "ask" } });
    expect(parseRemotePolicyArgs("MODE Trust")).toEqual({ action: "set", patch: { permissionMode: "trust" } });
    expect(parseRemotePolicyArgs("limit 30")).toEqual({ action: "set", patch: { runTimeoutMs: 1_800_000 } });
    expect(parseRemotePolicyArgs("limit none")).toEqual({ action: "set", patch: { runTimeoutMs: 0 } });
    expect(parseRemotePolicyArgs("limit off")).toEqual({ action: "set", patch: { runTimeoutMs: 0 } });
    expect(parseRemotePolicyArgs("wait 15")).toEqual({ action: "set", patch: { approvalTimeoutMs: 900_000 } });
    expect(parseRemotePolicyArgs("mode ask limit 60 wait 5")).toEqual({
      action: "set",
      patch: { permissionMode: "ask", runTimeoutMs: 3_600_000, approvalTimeoutMs: 300_000 },
    });
  });

  test("auto is refused with the reason and never reaches a patch", () => {
    const parsed = parseRemotePolicyArgs("mode auto");
    expect(parsed.action).toBe("invalid");
    expect(parsed.action === "invalid" && parsed.message).toContain("auto");
    expect(parseRemotePolicyArgs("mode AUTO").action).toBe("invalid");
  });

  test("anything malformed gives the usage line or a reason, never a patch", () => {
    for (const bad of ["mode", "mode yolo", "limit", "limit 0.5", "limit -3", "limit 10081", "wait 0", "wait 61", "wait none", "frobnicate 1", "mode ask mode trust", "limit 5 limit 6", "wait 5 wait 6", "ask"]) {
      expect(parseRemotePolicyArgs(bad).action).toBe("invalid");
    }
  });

  test("isRemotePolicyCommand matches the token only", () => {
    expect(isRemotePolicyCommand("/remote-policy")).toBe(true);
    expect(isRemotePolicyCommand("  /remote-policy mode ask")).toBe(true);
    expect(isRemotePolicyCommand("/remote-policyx")).toBe(false);
    expect(isRemotePolicyCommand("/remote-control")).toBe(false);
  });
});

describe("the posture text", () => {
  const posture = { defaultMode: "trust" as const, runTimeoutMs: 0, approvalTimeoutMs: 900_000, savedRules: 0 };

  test("lines carry the default, the run limit with /stop, the wait and the rules", () => {
    const text = postureLines(posture).join("\n");
    expect(text).toContain("Mode: trust");
    expect(text).toContain("Run limit: none (/stop ends a run)");
    expect(text).toContain("Approval wait: 15m");
    expect(text).toContain("Saved shell rules: 0");
    expect(text).not.toContain("In force now");
  });

  test("a running shell adds the mode in force with its source on the first line", () => {
    const lines = postureLines({ ...posture, inForce: "ask (shell /mode)" });
    expect(lines[0]).toBe("In force now: ask (shell /mode)");
  });

  test("sidebar text: one line, plus the rule count only when there are rules", () => {
    expect(postureSidebarText(posture)).toBe("trust · no limit · wait 15m");
    expect(postureSidebarText({ ...posture, runTimeoutMs: 1_800_000, savedRules: 1 })).toBe("trust · limit 30m · wait 15m\n1 saved shell rule");
    expect(postureSidebarText({ ...posture, defaultMode: "ask", savedRules: 3 })).toBe("ask · no limit · wait 15m\n3 saved shell rules");
  });
});

describe("loading the posture", () => {
  test("no config means nothing to show", () => {
    expect(loadPosture({ dir })).toBeUndefined();
  });

  test("an old config reads as the defaults: trust, no limit, 15 minutes", () => {
    seed();
    expect(loadPosture({ dir })).toEqual({ defaultMode: "trust", runTimeoutMs: 0, approvalTimeoutMs: 900_000, savedRules: 0 });
  });

  test("the running shell's copy wins over the file, and the mode in force is attached", () => {
    seed({ permissionMode: "ask" });
    const posture = loadPosture({
      dir,
      running: () => ({ defaultMode: "trust", runTimeoutMs: 60_000, approvalTimeoutMs: 120_000 }),
      inForce: () => "trust (Telegram default)",
    });
    expect(posture).toMatchObject({ defaultMode: "trust", runTimeoutMs: 60_000, approvalTimeoutMs: 120_000, inForce: "trust (Telegram default)" });
  });

  test("saved rules are counted from the same list the shell honours", () => {
    seed();
    saveShellPermissions({ allow: ["ls -la", "bun test src/a.test.ts"] }, dir);
    expect(countSavedRules(dir)).toBe(2);
    expect(loadPosture({ dir })?.savedRules).toBe(2);
  });
});

describe("remotePolicyText", () => {
  test("show without a config says to connect and prints the usage", () => {
    const text = remotePolicyText("", { dir });
    expect(text).toContain("/channels");
    expect(text).toContain("Usage: /remote-policy");
  });

  test("show prints the posture and says a shell /mode wins", () => {
    seed({ permissionMode: "ask", runTimeoutMs: 1_800_000 });
    const text = remotePolicyText("", { dir });
    expect(text).toContain("Mode: ask");
    expect(text).toContain("Run limit: 30m");
    expect(text).toContain("changes the shell's mode and wins for every turn");
    expect(readFileSync(configFile(), "utf8")).toContain("1800000");
  });

  test("set writes the file, tells the running shell, and states that the shell's mode is untouched", () => {
    seed();
    const applied: RemotePolicyPatch[] = [];
    const text = remotePolicyText("mode ask wait 5", { dir, applyPolicy: (patch) => applied.push(patch) });
    expect(onDisk()).toMatchObject({ permissionMode: "ask", approvalTimeoutMs: 300_000 });
    expect("runTimeoutMs" in onDisk()).toBe(false);
    expect(applied).toEqual([{ permissionMode: "ask", approvalTimeoutMs: 300_000 }]);
    expect(text).toContain("Saved.");
    expect(text).toContain("/remote-policy never changes it");
    expect(text).toContain("from the next Telegram turn");
  });

  test("the readline path (no applyPolicy) edits the file and says open shells keep their values", () => {
    seed();
    const text = remotePolicyText("limit 30", { dir });
    expect(onDisk().runTimeoutMs).toBe(1_800_000);
    expect(text).toContain("Open shells keep their values until they are restarted");
  });

  test("an invalid request changes nothing and does not call the shell", () => {
    seed();
    const before = readFileSync(configFile(), "utf8");
    let called = 0;
    for (const bad of ["mode auto", "wait 999", "limit x"]) {
      const text = remotePolicyText(bad, { dir, applyPolicy: () => (called += 1) });
      expect(text.length).toBeGreaterThan(0);
    }
    expect(called).toBe(0);
    expect(readFileSync(configFile(), "utf8")).toBe(before);
  });

  test("set without a config is refused, says to connect first, and does not call the shell", () => {
    let called = 0;
    const text = remotePolicyText("mode ask", { dir, applyPolicy: () => (called += 1) });
    expect(text).toContain("Not changed");
    expect(text).toContain("connect Telegram first");
    expect(called).toBe(0);
  });

  test("the text never carries the bot token or the chat id", () => {
    seed({ permissionMode: "ask" });
    writeFileSync(path.join(dir, "remote", "bot-token"), "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", { mode: 0o600 });
    const text = `${remotePolicyText("", { dir })}${remotePolicyText("mode trust", { dir })}`;
    expect(text).not.toContain("AAAAAAAA");
    expect(text).not.toContain("-1001");
  });
});
