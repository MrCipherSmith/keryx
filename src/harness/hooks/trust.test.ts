// Tests for R700-01/R700-02's project-hook trust store (flow 319, lane A).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  trustStoreInsideProject,
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

describe("R2-04 (flow 319 review round 2): trust store resolving inside the project", () => {
  test("trustStoreInsideProject: true for a configDir under trustRoot, false for one outside it", () => {
    const base = tmpDir("keryx-trust-inside-basic-");
    const inside = path.join(base, "config");
    const outside = tmpDir("keryx-trust-outside-basic-");
    expect(trustStoreInsideProject(base, inside)).toBe(true);
    expect(trustStoreInsideProject(base, outside)).toBe(false);
  });

  test("trustStoreInsideProject: true even when the configDir sits outside a nested projectRoot but inside the real git toplevel (R2-05 parity)", () => {
    const repoRoot = tmpDir("keryx-trust-git-");
    mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    const nested = path.join(repoRoot, "nest");
    mkdirSync(nested, { recursive: true });
    const configDir = path.join(repoRoot, "config"); // outside `nested`, inside `repoRoot`
    expect(trustStoreInsideProject(nested, configDir)).toBe(true);
  });

  test("loadHooksTrustStore reads as empty when projectRoot is given and the store resolves inside it, even though a real file is there", () => {
    const base = tmpDir("keryx-trust-inside-load-");
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "hooks-trust.json"),
      JSON.stringify({
        version: 1,
        projects: { k: { digest: "sha256:x", trustedAt: "2020-01-01T00:00:00.000Z", hookIds: [] } },
      }),
      "utf8",
    );
    // Without a projectRoot to check against, the store reads normally —
    // this is the pre-existing test-seam behaviour every other test in this
    // file relies on.
    expect(loadHooksTrustStore(configDir)).not.toEqual({});
    // With projectRoot given and the store inside it, it reads as {} —
    // nothing trusted, fail-closed, same as a corrupt file.
    expect(loadHooksTrustStore(configDir, base)).toEqual({});
  });

  test("recordProjectHooksTrust refuses to write a trust store inside the project, with a clear message, and creates nothing", () => {
    const base = tmpDir("keryx-trust-inside-record-");
    const configDir = path.join(base, "config");
    const result = recordProjectHooksTrust({ trustRoot: base, digest: "sha256:x", hookIds: [], configDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("resolves inside this project");
    expect(existsSync(configDir)).toBe(false);
  });

  test("revokeProjectHooksTrust refuses the same way", () => {
    const base = tmpDir("keryx-trust-inside-revoke2-");
    const configDir = path.join(base, "config");
    const result = revokeProjectHooksTrust({ trustRoot: base, configDir });
    expect(result.ok).toBe(false);
  });

  test("a configDir outside the project is unaffected: record, load and revoke all work as before", () => {
    const base = tmpDir("keryx-trust-outside-record-");
    const configDir = path.join(tmpDir("keryx-trust-outside-config-"), "config");
    const result = recordProjectHooksTrust({ trustRoot: base, digest: "sha256:x", hookIds: ["h"], configDir });
    expect(result.ok).toBe(true);
    expect(loadHooksTrustStore(configDir, base)[projectHooksTrustKey(base)]?.digest).toBe("sha256:x");
    const revoked = revokeProjectHooksTrust({ trustRoot: base, configDir });
    expect(revoked.ok).toBe(true);
    if (revoked.ok) expect(revoked.removed).toBe(true);
  });
});

// R3-05 (flow 319 review round 3): `gitToplevelRoot` walks to ANY ancestor
// `.git`, so a project living under a git-tracked $HOME (a common dotfiles
// setup: `~/.git` tracking dotfiles) had its boundary widen all the way to
// $HOME — the real default trust store under `$HOME/.local/share/keryx`
// then read as "inside the project", and every `hooks trust` refused
// unconditionally, fail-closed but unusable. `trustBoundaryRoot`
// (`src/lib/git-toplevel.ts`) narrows the boundary back to the nearest
// `.metaproject` whenever the git toplevel swallows $HOME (or the real
// default config dir) this way.
describe("R3-05: the boundary must not widen to the operator's real $HOME", () => {
  // `os.homedir()` is resolved once at process start (from libuv's own
  // lookup) and is NOT re-read from `process.env.HOME` on every call — a
  // real difference from `process.env.XDG_DATA_HOME`, which IS read live.
  // Mutating `process.env.HOME` mid-test therefore cannot fake $HOME for
  // `trustBoundaryRoot`; a genuine fake $HOME needs a real subprocess
  // started with `HOME` set in its env, the same way an operator's shell
  // would set it. `runWithFakeHome` spawns one, running a tiny inline
  // script against this module's own exports, and reports what it printed.
  function runWithFakeHome(fakeHome: string, script: string): { ok: boolean; output: string } {
    const trustModule = path.join(__dirname, "trust.ts");
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", script.replace("__TRUST_MODULE__", trustModule)],
      env: { ...process.env, HOME: fakeHome, XDG_DATA_HOME: "", APPDATA: "" },
      cwd: fakeHome,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    return { ok: proc.exitCode === 0, output };
  }

  test("(a) a dotfiles repo at $HOME: the trust store under $HOME/.local/share is not refused, and trusting works", () => {
    const fakeHome = tmpDir("keryx-r305-home-");
    mkdirSync(path.join(fakeHome, ".git"), { recursive: true }); // $HOME itself is a git work tree
    const project = path.join(fakeHome, "proj");
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });
    const configDir = path.join(fakeHome, ".local", "share", "keryx"); // the real default location under this $HOME

    const { ok, output } = runWithFakeHome(
      fakeHome,
      `
      const { trustStoreInsideProject, recordProjectHooksTrust, loadHooksTrustStore, projectHooksTrustKey } = await import(${JSON.stringify(
        "file://__TRUST_MODULE__",
      )});
      const project = ${JSON.stringify(project)};
      const configDir = ${JSON.stringify(configDir)};
      if (trustStoreInsideProject(project, configDir) !== false) throw new Error("trustStoreInsideProject: expected false, the real $HOME/.local/share store must not read as inside the project");
      const result = recordProjectHooksTrust({ trustRoot: project, digest: "sha256:x", hookIds: ["h"], configDir });
      if (!result.ok) throw new Error("recordProjectHooksTrust refused: " + result.error);
      const store = loadHooksTrustStore(configDir, project);
      if (store[projectHooksTrustKey(project)]?.digest !== "sha256:x") throw new Error("trust did not round-trip");
      console.log("OK");
      `,
    );
    expect(ok, output).toBe(true);
    expect(output).toContain("OK");
  });

  test("(b) the normal case is unaffected: a nested .metaproject inside an ordinary (non-$HOME) git repo still cannot move the trust store inside it (R2-05 still holds)", () => {
    const repoRoot = tmpDir("keryx-r305-normal-");
    mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    const nested = path.join(repoRoot, "nest");
    mkdirSync(path.join(nested, ".metaproject"), { recursive: true });
    const configDir = path.join(repoRoot, "config"); // outside `nested`, inside `repoRoot`
    // Not under any $HOME/config-dir involved in this test, so the normal,
    // unnarrowed git-toplevel boundary applies — same assertion R2-05's own
    // test makes. Runs in-process: nothing here touches `os.homedir()`.
    expect(trustStoreInsideProject(nested, configDir)).toBe(true);
  });

  test("(c) reviewer's repro: `keryx hooks trust` succeeds in a dotfiles-tracked $HOME instead of refusing every time", () => {
    const fakeHome = tmpDir("keryx-r305-repro-");
    mkdirSync(path.join(fakeHome, ".git"), { recursive: true });
    const project = path.join(fakeHome, "work", "proj");
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });
    const configDir = path.join(fakeHome, ".local", "share", "keryx");

    const { ok, output } = runWithFakeHome(
      fakeHome,
      `
      const { recordProjectHooksTrust, loadHooksTrustStore, projectHooksTrustKey, revokeProjectHooksTrust } = await import(${JSON.stringify(
        "file://__TRUST_MODULE__",
      )});
      const project = ${JSON.stringify(project)};
      const configDir = ${JSON.stringify(configDir)};
      const result = recordProjectHooksTrust({ trustRoot: project, digest: "sha256:abc", hookIds: ["h1"], configDir });
      if (!result.ok) throw new Error("recordProjectHooksTrust refused: " + result.error);
      const store = loadHooksTrustStore(configDir, project);
      if (store[projectHooksTrustKey(project)]?.digest !== "sha256:abc") throw new Error("trust did not round-trip");
      const revoked = revokeProjectHooksTrust({ trustRoot: project, configDir });
      if (!revoked.ok || !revoked.removed) throw new Error("revoke did not remove the entry it just wrote");
      console.log("OK");
      `,
    );
    expect(ok, output).toBe(true);
    expect(output).toContain("OK");
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

  test("announces enabled unsandboxed user hooks once per session (R1-04)", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      registrations: [
        reg({ id: "userpoc", scope: "user", runsIn: "unsandboxed", enabled: true }),
        reg({ id: "userpoc-2", scope: "user", runsIn: "unsandboxed", enabled: true }),
        reg({ id: "userpoc-disabled", scope: "user", runsIn: "unsandboxed", enabled: false }),
        reg({ id: "userpoc-sandboxed", scope: "user", runsIn: "sandbox", enabled: true }),
        reg({ id: "projpoc", scope: "project", runsIn: "unsandboxed", enabled: true }),
      ],
      projectHooks: { state: "none", filePath: "/proj/.metaproject/hooks.json", trustKey: "k", hooks: [] },
    };
    const lines = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    const line = lines.find((l) => l.includes("run UNSANDBOXED"));
    expect(line).toBeDefined();
    expect(line).toContain("2 user hook(s) from /home/.keryx/hooks.json run UNSANDBOXED");
    expect(line).toContain("userpoc");
    expect(line).toContain("userpoc-2");
    expect(line).not.toContain("userpoc-disabled");
    expect(line).not.toContain("userpoc-sandboxed");
    expect(line).not.toContain("projpoc");
  });

  test("no unsandboxed-user-hook line when there are none", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      registrations: [reg({ scope: "user", runsIn: "sandbox" })],
      projectHooks: { state: "none", filePath: "/proj/.metaproject/hooks.json", trustKey: "k", hooks: [] },
    };
    const lines = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    expect(lines.some((l) => l.includes("UNSANDBOXED"))).toBe(false);
  });

  test("escapes a bidi id in the untrusted-hooks notice", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: {
        state: "untrusted",
        filePath: "/proj/.metaproject/hooks.json",
        trustKey: "k",
        digest: "sha256:x",
        hooks: [reg({ id: "safe-‮evil" })],
      },
    };
    const [line] = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    expect(line).not.toContain("‮");
    expect(line).toContain("\\u202e");
  });

  // R2-03 (flow 319 review round 2): the reviewer's payload — an
  // unconstrained JSON property name (an additional-property schema
  // diagnostic quotes the offending key verbatim) carrying an ESC/CSI
  // sequence, reaching `keryx shell`'s session-start line raw.
  test("escapes an attacker property name inside a schema-invalid diagnostic message", () => {
    const result: LoadHookConfigResult = {
      ok: false,
      diagnostics: [
        {
          code: "schema-invalid",
          scope: "project",
          message: '.metaproject/hooks.json: $.hooks.Bad\u001b[1Aevent: Additional property is not allowed.',
        },
      ],
    };
    const [line] = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/h", surface: "terminal" });
    expect(line).not.toContain("\u001b");
    expect(line).toContain("\\x1b[1A");
    expect(line).toContain("Bad");
    expect(line).toContain("event");
  });

  test("escapes an attacker-controlled tighten-only warning message", () => {
    const result: LoadHookConfigResult = {
      ...okBase,
      projectHooks: { state: "none", filePath: "/proj/.metaproject/hooks.json", trustKey: "k", hooks: [] },
      warnings: [
        {
          code: "gate-disable-unacknowledged",
          scope: "user",
          message: "keryx hooks: ignored the disable\u001b[2K of built-in gate keryx.ctx-guard",
        },
      ],
    };
    const [line] = formatHookLoadNotices(result, { projectRoot: "/proj", userFile: "/home/.keryx/hooks.json", surface: "terminal" });
    expect(line).not.toContain("\u001b");
    expect(line).toContain("\\x1b[2K");
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
    const { lines, escaped } = describeProjectHookForApproval(
      reg({ runsIn: "unsandboxed", enabled: false, handler: { kind: "command", argv: ["a b", "c"], cwd: "/x", env: { K: "V" } } }),
      { projectRoot: "/proj" },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("my-hook");
    expect(joined).toContain("PreToolUse");
    expect(joined).toContain("UNSANDBOXED");
    expect(joined).toContain("(disabled)");
    expect(joined).toContain('"a b"');
    expect(joined).toContain("cwd=/x");
    expect(joined).toContain("env: K=V");
    expect(escaped).toBe(false);
  });

  // R1-02 (flow 319 review round 1): the reviewer's CSI payload — an argv
  // token that tries to erase/overwrite the UNSANDBOXED warning line above
  // it — must reach the caller escaped, never as raw control bytes.
  test("escapes a CSI cursor-erase payload in argv instead of letting it act, and reports escaped: true", () => {
    const csi = "touch${IFS}$A/M2\u001b[1A\u001b[2K\u001b[1G";
    const { lines, escaped } = describeProjectHookForApproval(
      reg({ runsIn: "unsandboxed", handler: { kind: "command", argv: [csi] } }),
      { projectRoot: "/proj" },
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("\u001b");
    expect(joined).toContain("\\x1b[1A\\x1b[2K\\x1b[1G");
    expect(escaped).toBe(true);
  });

  // A bidi override in the id: schema-constrained in practice
  // (`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`), but this render path does not
  // trust that constraint to hold forever — it escapes on its own.
  test("escapes a bidi override in the id", () => {
    const { lines, escaped } = describeProjectHookForApproval(reg({ id: "safe-‮evil" }), { projectRoot: "/proj" });
    const joined = lines.join("\n");
    expect(joined).not.toContain("‮");
    expect(joined).toContain("\\u202e");
    expect(escaped).toBe(true);
  });

  test("escapes env keys and values, and cwd", () => {
    const { lines, escaped } = describeProjectHookForApproval(
      reg({ handler: { kind: "command", argv: ["echo"], cwd: "/x\u001b[2K", env: { "K​": "V\u001b[8m" } } }),
      { projectRoot: "/proj" },
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("\u001b");
    expect(joined).not.toContain("​");
    expect(escaped).toBe(true);
  });

  // R2-06 (flow 319 review round 2): this used to be `quoteArg(safe.render(arg))`
  // — escape a control byte to `\xHH` text, THEN `JSON.stringify` that text,
  // which doubles the backslash `terminalSafe` just introduced. Fixed by
  // quoting the RAW token first and sanitising the result exactly once.
  test("R2-06: a whitespace-containing token with a control byte is not double-escaped", () => {
    const { lines } = describeProjectHookForApproval(
      reg({ handler: { kind: "command", argv: ["echo harmless\rrm -rf ~"] } }),
      { projectRoot: "/proj" },
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain("\r"); // no raw control byte reaches the terminal
    expect(joined).not.toMatch(/\\\\/); // never a doubled backslash (the double-escape bug)
    expect(joined).toContain("rm -rf ~");
  });

  test("adds a NOTE when an argv token resolves to an existing file inside the project (R1-03)", () => {
    const base = tmpDir("keryx-hooks-note-");
    mkdirSync(path.join(base, "scripts"), { recursive: true });
    writeFileSync(path.join(base, "scripts", "h.sh"), "echo benign\n", "utf8");
    const { lines } = describeProjectHookForApproval(
      reg({ handler: { kind: "command", argv: ["/bin/sh", "scripts/h.sh"] } }),
      { projectRoot: base },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("NOTE: my-hook runs scripts/h.sh from this repository; trust does not cover changes to that file.");
  });

  test("no NOTE for a bare command name that does not resolve to a real file", () => {
    const base = tmpDir("keryx-hooks-note-none-");
    const { lines } = describeProjectHookForApproval(reg({ handler: { kind: "command", argv: ["echo", "hi"] } }), {
      projectRoot: base,
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("NOTE:");
  });

  test("no NOTE for an argv token that escapes the project root", () => {
    const base = tmpDir("keryx-hooks-note-escape-");
    const outside = tmpDir("keryx-hooks-note-outside-");
    writeFileSync(path.join(outside, "evil.sh"), "echo\n", "utf8");
    const relative = path.relative(base, path.join(outside, "evil.sh"));
    const { lines } = describeProjectHookForApproval(
      reg({ handler: { kind: "command", argv: ["/bin/sh", relative] } }),
      { projectRoot: base },
    );
    expect(lines.join("\n")).not.toContain("NOTE:");
  });
});
