// Live containment smoke for review-security-code-w5 F-001 / F-002 on macOS.
// REAL sandbox-exec — gated like sandbox.smoke.test.ts (KERYX_ALLOW_REAL_SUBPROCESS=1
// on darwin). The Linux half is covered by argv unit tests in bwrap.test.ts only.
//
// Every denied half has an allowed control, so a sandbox that never launched
// cannot look like a perfect one.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  // review-security-code-w2:F-001 (a): git reads `.git/commondir` for ANY git dir
  // and takes config + hooks from where it points. The verifier's repro: a sibling
  // dir with objects/refs linked back and an fsmonitor config, then commondir.
  test("w2 F-001 (a): .git/commondir cannot be created, so the host's next git status runs nothing", () => {
    const parent = mk("keryx-gitcd-");
    const ws = path.join(parent, "ws");
    const wsTmp = mk("keryx-gitcdtmp-");
    const pwned = path.join(parent, "PWNED_FSMON");
    try {
      mkdirSync(ws);
      expect(git(ws, "init", "-q").status).toBe(0);
      const attack = contained(
        ws,
        wsTmp,
        `mkdir x && ln -s ../.git/objects x/objects && ln -s ../.git/refs x/refs && cp .git/HEAD x/HEAD && printf '[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = "touch ${pwned}; false"\\n' > x/config && echo ../x > .git/commondir`,
      );
      expect(attack.status).not.toBe(0);
      expect(existsSync(path.join(ws, ".git", "commondir"))).toBe(false);
      expect(existsSync(path.join(ws, "x", "config"))).toBe(true); // allowed half: the working tree is writable
      git(ws, "status");
      expect(existsSync(pwned)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });

  // review-logic-w3:F-002 (1): a repo with no hooks dir (`git init --template=`).
  test("w3 F-002 (1): a missing .git/hooks cannot be created, and the host's checkout runs no hook", () => {
    const parent = mk("keryx-gitnh-");
    const ws = path.join(parent, "ws");
    const wsTmp = mk("keryx-gitnhtmp-");
    const pwned = path.join(parent, "PWNED_HOOK");
    try {
      mkdirSync(ws);
      expect(git(ws, "init", "-q", "--template=").status).toBe(0);
      expect(existsSync(path.join(ws, ".git", "hooks"))).toBe(false);
      expect(git(ws, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i").status).toBe(0);
      const attack = contained(
        ws,
        wsTmp,
        `mkdir .git/hooks && printf '#!/bin/sh\\ntouch ${pwned}\\n' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout`,
      );
      expect(attack.status).not.toBe(0);
      expect(existsSync(path.join(ws, ".git", "hooks"))).toBe(false);
      expect(git(ws, "checkout", "-q", "-b", "other").status).toBe(0);
      expect(existsSync(pwned)).toBe(false);
      // Allowed half: a commit still works from inside (index, objects, refs, lock files).
      const commit = contained(ws, wsTmp, "echo a > a.txt && git add a.txt && git -c user.email=a@b.c -c user.name=t commit -q -m a");
      expect(commit.status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });

  // review-regression-w2:F-002: the accepted cost of a read-only .git/config. Pinned
  // so a change to it is a decision, not an accident (see os-sandbox.md).
  test("w2 regression F-002 (accepted cost): git subcommands that write .git/config fail inside the sandbox", () => {
    const ws = mk("keryx-gitcfg-");
    const wsTmp = mk("keryx-gitcfgtmp-");
    try {
      expect(git(ws, "init", "-q").status).toBe(0);
      const remote = contained(ws, wsTmp, "git remote add origin https://example.invalid/r.git");
      expect(remote.status).not.toBe(0);
      expect(remote.stderr).toContain("could not write config file");
      // The workaround: per-command config needs no write to .git/config.
      const perCommand = contained(ws, wsTmp, "git -c user.email=a@b.c -c user.name=t commit --allow-empty -q -m i");
      expect(perCommand.status).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });

  // review-logic-w3:F-001: `.git` is a symlink to a git dir outside the roots. The
  // link must not be replaceable by a fresh git dir carrying a hook, and the
  // outside git dir stays read-only.
  test.each(["absolute", "relative"])("w3 logic F-001: a %s `.git` symlink cannot be replaced, its outside target stays read-only", (form) => {
    const parent = mk("keryx-gitlnk-");
    const outside = path.join(parent, "outside", "g.git");
    const ws = path.join(parent, "ws");
    const wsTmp = mk("keryx-gitlnktmp-");
    try {
      expect(git(parent, "init", "-q", "--bare", outside).status).toBe(0);
      mkdirSync(ws);
      symlinkSync(form === "absolute" ? outside : path.relative(ws, outside), path.join(ws, ".git"));
      const swap = contained(ws, wsTmp, "rm .git && mkdir -p .git/hooks");
      expect(swap.status).not.toBe(0);
      expect(lstatSync(path.join(ws, ".git")).isSymbolicLink()).toBe(true);
      const hook = contained(ws, wsTmp, `printf '#!/bin/sh\\n' > ${path.join(outside, "hooks", "post-checkout")}`);
      expect(hook.status).not.toBe(0);
      expect(existsSync(path.join(outside, "hooks", "post-checkout"))).toBe(false);
      const ok = contained(ws, wsTmp, "echo fine > normal.txt");
      expect(ok.status).toBe(0); // allowed half
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(wsTmp, { recursive: true, force: true });
    }
  });

  // review-security-code-w3:F-001: the verifier's repro (r3-v2 f2-live / f2-exec) on a
  // superproject with a submodule `lib` that itself holds a submodule `deep`.
  describe("w3 security F-001: a superproject's submodules", () => {
    const sub = (cwd: string, ...args: string[]) => git(cwd, "-c", "protocol.file.allow=always", ...args);
    const commit = (cwd: string, m: string) => git(cwd, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "-m", m);

    function superproject(parent: string): string {
      const deep = path.join(parent, "src-deep");
      const lib = path.join(parent, "src-lib");
      const sup = path.join(parent, "sup");
      for (const d of [deep, lib, sup]) {
        mkdirSync(d);
        expect(git(d, "init", "-q").status).toBe(0);
      }
      writeFileSync(path.join(deep, "d.txt"), "d\n");
      git(deep, "add", "d.txt");
      expect(commit(deep, "d").status).toBe(0);
      expect(sub(lib, "submodule", "add", "-q", deep, "deep").status).toBe(0);
      expect(commit(lib, "lib").status).toBe(0);
      expect(sub(sup, "submodule", "add", "-q", lib, "lib").status).toBe(0);
      expect(sub(sup, "submodule", "update", "--init", "--recursive", "-q").status).toBe(0);
      expect(commit(sup, "sup").status).toBe(0);
      expect(existsSync(path.join(sup, ".git", "modules", "lib", "modules", "deep", "config"))).toBe(true);
      return sup;
    }

    test("submodule gitdir config/hooks (nested too) and every gitlink file are read-only; the host's git status runs nothing", () => {
      const parent = mk("keryx-gitsm-");
      const wsTmp = mk("keryx-gitsmtmp-");
      const pwned = path.join(parent, "PWNED_SUBMODULE");
      try {
        const sup = superproject(parent);
        for (const rel of [
          ".git/config",
          ".git/modules/lib/config",
          ".git/modules/lib/hooks/post-checkout",
          ".git/modules/lib/modules/deep/config",
          ".git/modules/lib/modules/deep/hooks/post-checkout",
          "lib/.git",
          "lib/deep/.git",
        ]) {
          const target = path.join(sup, rel);
          const before = existsSync(target) ? readFileSync(target, "utf8") : undefined;
          const w = contained(sup, wsTmp, `printf '#probe\\n' >> "${target}"`);
          expect({ rel, status: w.status }).not.toEqual({ rel, status: 0 });
          expect(existsSync(target) ? readFileSync(target, "utf8") : undefined).toBe(before);
        }
        // f2-exec: the planted fsmonitor would run on the host's next `git status`.
        for (const cfg of [".git/modules/lib/config", ".git/modules/lib/modules/deep/config"]) {
          contained(sup, wsTmp, `printf '[core]\\n\\tfsmonitor = "touch ${pwned}; false"\\n' >> ${cfg}`);
        }
        expect(git(sup, "status", "--short").status).toBe(0);
        expect(existsSync(pwned)).toBe(false);
        // Allowed half: work inside a submodule (index, objects, refs) still commits.
        const work = contained(sup, wsTmp, "echo w > lib/w.txt && cd lib && git add w.txt && git -c user.email=a@b.c -c user.name=t commit -q -m w");
        expect(work.status).toBe(0);
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(wsTmp, { recursive: true, force: true });
      }
    }, 30_000);

    test("a submodule gitdir or linked worktree cannot be created during the run", () => {
      const parent = mk("keryx-gitsmnew-");
      const wsTmp = mk("keryx-gitsmnewtmp-");
      try {
        const sup = superproject(parent);
        for (const script of [
          "mkdir -p .git/modules/evil/hooks",
          "mkdir -p .git/modules/lib/modules/evil",
          "mkdir -p .git/worktrees/evil && echo ../.. > .git/worktrees/evil/commondir",
          "git worktree add -q wt2 -b y",
        ]) {
          expect({ script, status: contained(sup, wsTmp, script).status }).not.toEqual({ script, status: 0 });
        }
        expect(existsSync(path.join(sup, ".git", "modules", "evil"))).toBe(false);
        expect(existsSync(path.join(sup, ".git", "modules", "lib", "modules", "evil"))).toBe(false);
        expect(existsSync(path.join(sup, ".git", "worktrees", "evil"))).toBe(false);
        expect(existsSync(path.join(sup, ".git", "worktrees", "wt2"))).toBe(false);
        const ok = contained(sup, wsTmp, "mkdir -p notgit/modules/x && echo fine > notgit/modules/x/f");
        expect(ok.status).toBe(0); // allowed half: the same names outside a git dir are writable
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(wsTmp, { recursive: true, force: true });
      }
    }, 30_000);
  });

  // review-degradation-w3:F-002 (accepted cost, see os-sandbox.md): from the main
  // checkout, an existing worktree's gitdir is pinned, so these fail inside.
  test("w3 degradation F-002 (accepted cost): git worktree remove/prune cannot delete the gitdir inside the sandbox", () => {
    const main = mk("keryx-gitwtcost-");
    const wsTmp = mk("keryx-gitwtcosttmp-");
    try {
      expect(git(main, "init", "-q").status).toBe(0);
      expect(git(main, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i").status).toBe(0);
      expect(git(main, "worktree", "add", "-q", "wt", "-b", "x").status).toBe(0);
      // `move` only rewrites `.git/worktrees/wt/gitdir`, which is not protected.
      expect(contained(main, wsTmp, "git worktree move wt wt-moved").status).toBe(0);
      // `remove` deletes the checkout, then fails on the pinned gitdir: still registered.
      const remove = contained(main, wsTmp, "git worktree remove --force wt-moved");
      expect(remove.status).not.toBe(0);
      expect(remove.stderr).toContain("failed to delete '.git/worktrees/wt'");
      expect(existsSync(path.join(main, "wt-moved"))).toBe(false);
      expect(existsSync(path.join(main, ".git", "worktrees", "wt"))).toBe(true);
      // `prune` reports the error but exits 0, and the entry stays.
      expect(contained(main, wsTmp, "git worktree prune").stderr).toContain("failed to delete");
      expect(existsSync(path.join(main, ".git", "worktrees", "wt"))).toBe(true);
      // The workaround: outside the sandbox it works.
      expect(git(main, "worktree", "prune").status).toBe(0);
      expect(existsSync(path.join(main, ".git", "worktrees", "wt"))).toBe(false);
    } finally {
      rmSync(main, { recursive: true, force: true });
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
