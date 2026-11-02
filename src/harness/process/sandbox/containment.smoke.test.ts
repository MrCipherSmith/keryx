// Live containment smoke for review-security-code-w5 F-001 / F-002 on macOS.
// REAL sandbox-exec — gated like sandbox.smoke.test.ts (KERYX_ALLOW_REAL_SUBPROCESS=1
// on darwin). The Linux half is covered by argv unit tests in bwrap.test.ts only.
//
// Every denied half has an allowed control, so a sandbox that never launched
// cannot look like a perfect one.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultSandboxProfile } from "./profile";
import { wrapSeatbelt } from "./seatbelt";

const live = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1" && process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

function mk(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Run `script` under the real default profile for `ws`. */
function contained(ws: string, wsTmp: string, script: string) {
  const wrapped = wrapSeatbelt(
    { path: "/bin/sh", argv: ["sh", "-c", script], env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: homedir() }, cwd: ws },
    defaultSandboxProfile(ws, wsTmp, homedir()),
  );
  return spawnSync(wrapped.path, wrapped.argv.slice(1), { cwd: ws, env: wrapped.env, encoding: "utf8", timeout: 8_000 });
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
}

describe.skipIf(!live)("OS-sandbox live containment (macOS)", () => {
  test("F-002: .git/hooks and .git/config are read-only, a normal file in cwd is still writable", () => {
    const ws = mk("keryx-gitp-");
    const wsTmp = mk("keryx-gitptmp-");
    try {
      expect(git(ws, "init", "-q").status).toBe(0);
      const ok = contained(ws, wsTmp, "echo fine > normal.txt && git add normal.txt");
      expect(ok.status).toBe(0); // allowed half: working files + the index still work
      expect(existsSync(path.join(ws, "normal.txt"))).toBe(true);

      const hook = contained(ws, wsTmp, "printf '#!/bin/sh\\ntouch /tmp/x\\n' > .git/hooks/post-checkout");
      expect(hook.status).not.toBe(0);
      expect(existsSync(path.join(ws, ".git", "hooks", "post-checkout"))).toBe(false);

      const cfg = contained(ws, wsTmp, "git config core.fsmonitor 'touch /tmp/y'");
      expect(cfg.status).not.toBe(0);
      expect(readFileSync(path.join(ws, ".git", "config"), "utf8")).not.toContain("fsmonitor");

      // The git dir cannot be renamed away and replaced with one carrying a hook.
      const swap = contained(ws, wsTmp, "mv .git .git-old && mkdir -p .git/hooks");
      expect(swap.status).not.toBe(0);
      expect(existsSync(path.join(ws, ".git", "config"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });

  test("F-002: a linked worktree's .git file cannot be repointed", () => {
    const main = mk("keryx-gitmain-");
    const wt = path.join(mk("keryx-gitwtp-"), "wt");
    const wsTmp = mk("keryx-gitwttmp-");
    try {
      expect(git(main, "init", "-q").status).toBe(0);
      expect(git(main, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i").status).toBe(0);
      expect(git(main, "worktree", "add", "-q", wt, "-b", "x").status).toBe(0);
      const repoint = contained(wt, wsTmp, "echo 'gitdir: /tmp/evil' > .git");
      expect(repoint.status).not.toBe(0);
      expect(readFileSync(path.join(wt, ".git"), "utf8")).toContain(main);
      const ok = contained(wt, wsTmp, "echo fine > normal.txt");
      expect(ok.status).toBe(0);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(path.dirname(wt), { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });

  test("F-001: `open` cannot launch a program outside the profile (control: an uncontained open does)", async () => {
    const ws = mk("keryx-open-");
    const wsTmp = mk("keryx-opentmp-");
    const outside = mk("keryx-openout-");
    try {
      const app = path.join(ws, "Esc.app");
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
      writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Esc</string><key>CFBundleIdentifier</key><string>invalid.keryx.contain.esc</string><key>LSUIElement</key><true/></dict></plist>',
      );
      const exe = path.join(app, "Contents", "MacOS", "Esc");
      const marker = path.join(outside, "marker");
      writeFileSync(exe, `#!/bin/sh\necho ESCAPED > ${marker}\n`);
      chmodSync(exe, 0o755);

      // Allowed half: uncontained, the same open DOES run the program.
      spawnSync("/usr/bin/open", ["-g", "-n", app]);
      for (let i = 0; i < 30 && !existsSync(marker); i++) await Bun.sleep(200);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      // Denied half: from inside the sandbox, open (and a copy of it) fail and nothing runs.
      const viaOpen = contained(ws, wsTmp, `/usr/bin/open -g -n ${app}`);
      expect(viaOpen.status).not.toBe(0);
      const viaCopy = contained(ws, wsTmp, `cp /usr/bin/open ./open2 && ./open2 -g -n ${app}`);
      await Bun.sleep(3000);
      expect(viaCopy.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);

      // Ordinary tools still run under the same profile.
      const tools = contained(ws, wsTmp, "git --version && curl --version >/dev/null && python3 -c 'import ssl'");
      expect(tools.status).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);
});
