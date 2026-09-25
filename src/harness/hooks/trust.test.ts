// Tests for R700-01/R700-02's project-hook trust store (flow 319, lane A).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeProjectHookForApproval,
  digestProjectHooks,
  loadHooksTrustStore,
  projectHooksTrustKey,
  projectHooksTrustState,
  recordProjectHooksTrust,
  revokeProjectHooksTrust,
} from "./trust";
import { formatHookLoadNotices } from "./notices";
import type { LoadHookConfigResult } from "./config";
import type { HookRegistration } from "./types";

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function reg(overrides: Partial<HookRegistration> = {}): HookRegistration {
  return {
    id: "my-hook",
    event: "PreToolUse",
    matcher: "Bash",
    class: "gate",
    handler: { kind: "command", argv: ["echo", "hi"] },
    timeoutMs: 5000,
    runsIn: "sandbox",
    network: "none",
    appliesToChildAgents: true,
    profiles: [],
    enabled: true,
    scope: "project",
    order: 0,
    ...overrides,
  };
}

describe("digestProjectHooks", () => {
  test("ignores key order, whitespace, description and _keryxManaged", () => {
    const a = digestProjectHooks([reg({ description: "one" })]);
    const b = digestProjectHooks([reg({ description: "two entirely different text" })]);
    expect(a).toBe(b);
  });

  test("changes when any executable field changes", () => {
    const base = digestProjectHooks([reg()]);
    const table: Array<[string, HookRegistration]> = [
      ["argv", reg({ handler: { kind: "command", argv: ["echo", "bye"] } })],
      ["cwd", reg({ handler: { kind: "command", argv: ["echo", "hi"], cwd: "/tmp" } })],
      ["env key", reg({ handler: { kind: "command", argv: ["echo", "hi"], env: { A: "1" } } })],
      ["runsIn", reg({ runsIn: "unsandboxed" })],
      ["network", reg({ network: "restricted" })],
      ["timeoutMs", reg({ timeoutMs: 9999 })],
      ["matcher", reg({ matcher: "Write" })],
      ["class", reg({ class: "observe" })],
      ["event", reg({ event: "PostToolUse" })],
      ["profiles", reg({ profiles: ["read-only-review"] })],
      ["enabled", reg({ enabled: false })],
      ["appliesToChildAgents", reg({ appliesToChildAgents: false })],
      ["id", reg({ id: "other-hook" })],
    ];
    for (const [name, changed] of table) {
      const digest = digestProjectHooks([changed]);
      expect(digest, `field: ${name}`).not.toBe(base);
    }
  });

  test("env value change and order-of-two-hooks change the digest", () => {
    const base = digestProjectHooks([reg({ handler: { kind: "command", argv: ["echo", "hi"], env: { A: "1" } } })]);
    const valueChanged = digestProjectHooks([reg({ handler: { kind: "command", argv: ["echo", "hi"], env: { A: "2" } } })]);
    expect(valueChanged).not.toBe(base);

    const two = [reg({ id: "first" }), reg({ id: "second" })];
    const reordered = [reg({ id: "second" }), reg({ id: "first" })];
    expect(digestProjectHooks(two)).not.toBe(digestProjectHooks(reordered));
  });

  test("env key order does not change the digest", () => {
    const a = digestProjectHooks([reg({ handler: { kind: "command", argv: ["echo", "hi"], env: { A: "1", B: "2" } } })]);
    const b = digestProjectHooks([reg({ handler: { kind: "command", argv: ["echo", "hi"], env: { B: "2", A: "1" } } })]);
    expect(a).toBe(b);
  });
});

describe("trust state", () => {
  test("none / untrusted / trusted / changed", () => {
    const key = "k";
    expect(projectHooksTrustState(key, undefined, {})).toBe("none");
    expect(projectHooksTrustState(key, "sha256:aaa", {})).toBe("untrusted");
    const store = { [key]: { digest: "sha256:aaa", trustedAt: "2020-01-01T00:00:00.000Z", hookIds: ["x"] } };
    expect(projectHooksTrustState(key, "sha256:aaa", store)).toBe("trusted");
    expect(projectHooksTrustState(key, "sha256:bbb", store)).toBe("changed");
  });
});

describe("recordProjectHooksTrust / loadHooksTrustStore", () => {
  test("keys by realpath (a symlinked project dir maps to the same entry) and writes an owner-only file", () => {
    const base = tmpDir("keryx-hooks-trust-");
    const configDir = path.join(base, "config");
    const real = path.join(base, "real-project");
    mkdirSync(real, { recursive: true });
    const link = path.join(base, "linked-project");
    symlinkSync(real, link);

    const result = recordProjectHooksTrust({
      trustRoot: link,
      digest: "sha256:abc",
      hookIds: ["h1"],
      configDir,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);

    const store = loadHooksTrustStore(configDir);
    const keyViaReal = projectHooksTrustKey(real);
    const keyViaLink = projectHooksTrustKey(link);
    expect(keyViaReal).toBe(keyViaLink);
    expect(store[keyViaReal]?.digest).toBe("sha256:abc");

    if (process.platform !== "win32") {
      const mode = statSync(path.join(configDir, "hooks-trust.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("a corrupt or wrong-shape trust store grants nothing", () => {
    const base = tmpDir("keryx-hooks-trust-corrupt-");
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "hooks-trust.json"), "{ not json", "utf8");
    expect(loadHooksTrustStore(configDir)).toEqual({});

    writeFileSync(path.join(configDir, "hooks-trust.json"), JSON.stringify({ wrong: "shape" }), "utf8");
    expect(loadHooksTrustStore(configDir)).toEqual({});
  });

  test("recordProjectHooksTrust refuses when the store exists but cannot be read, and writes nothing", () => {
    const base = tmpDir("keryx-hooks-trust-unreadable-");
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "hooks-trust.json");
    mkdirSync(file); // a directory where a file is expected: "not-regular"

    const result = recordProjectHooksTrust({ trustRoot: base, digest: "sha256:x", hookIds: [], configDir });
    expect(result.ok).toBe(false);
  });
});

describe("revokeProjectHooksTrust", () => {
  test("removes only that project's entry", () => {
    const base = tmpDir("keryx-hooks-trust-revoke-");
    const configDir = path.join(base, "config");
    const projectA = path.join(base, "a");
    const projectB = path.join(base, "b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });

    recordProjectHooksTrust({ trustRoot: projectA, digest: "sha256:a", hookIds: [], configDir });
    recordProjectHooksTrust({ trustRoot: projectB, digest: "sha256:b", hookIds: [], configDir });

    const result = revokeProjectHooksTrust({ trustRoot: projectA, configDir });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const store = loadHooksTrustStore(configDir);
    expect(store[projectHooksTrustKey(projectA)]).toBeUndefined();
    expect(store[projectHooksTrustKey(projectB)]?.digest).toBe("sha256:b");

    const again = revokeProjectHooksTrust({ trustRoot: projectA, configDir });
    expect(again.ok).toBe(true);
    expect(again.removed).toBe(false);
  });
});

describe("formatHookLoadNotices", () => {
  const okBase = {
    ok: true as const,
    registrations: [],
    diagnostics: [],
    warnings: [],
    disabledBuiltinGates: [],
  };

  test("untrusted notice names enabled hooks, marks unsandboxed, points to keryx hooks trust", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: {
        state: "untrusted",
        filePath: "/proj/.metaproject/hooks.json",
        trustKey: "k",
        digest: "sha256:x",
        hooks: [reg({ runsIn: "unsandboxed" })],
      },
    };
    const [line, hint] = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    expect(line).toContain("/proj/.metaproject/hooks.json defines 1 command hook");
    expect(line).toContain("not trusted");
    expect(line).toContain("my-hook (PreToolUse, unsandboxed)");
    expect(hint).toContain("keryx hooks trust");
  });

  test("headless variant points to a terminal in the project root", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: {
        state: "untrusted",
        filePath: "/proj/.metaproject/hooks.json",
        trustKey: "k",
        digest: "sha256:x",
        hooks: [reg()],
      },
    };
    const lines = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "headless" });
    expect(lines[1]).toContain("This session cannot ask");
    expect(lines[1]).toContain("/proj");
  });

  test("changed variant", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: {
        state: "changed",
        filePath: "/proj/.metaproject/hooks.json",
        trustKey: "k",
        digest: "sha256:x",
        hooks: [reg()],
      },
    };
    const [line] = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    expect(line).toContain("changed since you trusted it");
  });

  test("no notice when there are no project hooks (state none)", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: { state: "none", filePath: "/proj/.metaproject/hooks.json", trustKey: "k", hooks: [] },
    };
    expect(formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/h", surface: "terminal" })).toEqual([]);
  });

  test("load-failure line", () => {
    const result: LoadHookConfigResult = { ok: false, diagnostics: [{ code: "invalid-json", scope: "project", message: "bad json" }] };
    const [line] = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/h", surface: "terminal" });
    expect(line).toContain("every tool call and prompt is refused");
    expect(line).toContain("bad json");
    expect(line).toContain("keryx hooks validate");
  });

  test("warnings and gate banner", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: { state: "none", filePath: "/proj/.metaproject/hooks.json", trustKey: "k", hooks: [] },
      warnings: [{ code: "project-gate-disable-ignored", scope: "project", message: "keryx hooks: ignored the disable of built-in gate keryx.ctx-guard in /proj/.metaproject/hooks.json: a project file cannot turn off a built-in gate. The gate stays on." }],
      disabledBuiltinGates: [{ id: "keryx.ctx-guard", file: "/home/.keryx/hooks.json" }],
    };
    const lines = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    expect(lines[0]).toContain("ignored the disable of built-in gate keryx.ctx-guard");
    expect(lines[1]).toContain("built-in gate keryx.ctx-guard is OFF");
  });
});

describe("describeProjectHookForApproval", () => {
  test("shows event/matcher/class/runsIn/network, argv, and marks disabled/unsandboxed", () => {
    const lines = describeProjectHookForApproval(
      reg({ runsIn: "unsandboxed", enabled: false, handler: { kind: "command", argv: ["a b", "c"], cwd: "/x", env: { K: "V" } } }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("my-hook");
    expect(joined).toContain("PreToolUse");
    expect(joined).toContain("UNSANDBOXED");
    expect(joined).toContain("(disabled)");
    expect(joined).toContain('"a b"');
    expect(joined).toContain("cwd=/x");
    expect(joined).toContain("env: K=V");
  });
});
