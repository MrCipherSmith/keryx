import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderTestingPrePushHook } from "../testing/templates";
import { GIT_DISCOVERY_OVERRIDE_VARS, withoutGitDiscoveryOverrides } from "./git-env";

describe("withoutGitDiscoveryOverrides", () => {
  test("drops every discovery override and keeps everything else", () => {
    const overrides = Object.fromEntries(GIT_DISCOVERY_OVERRIDE_VARS.map((name) => [name, "/elsewhere"]));
    const env = { PATH: "/usr/bin", HOME: "/home/dev", GIT_EDITOR: "true", ...overrides };
    expect(withoutGitDiscoveryOverrides(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", GIT_EDITOR: "true" });
  });
});

// The incident: git runs the pre-push hook with `GIT_DIR` exported, the hook
// runs `keryx test run`, and the suite's fixture repos resolve to the checkout
// being pushed. Clearing the variables inside the suite does not work — Bun
// children inherit the ORIGINAL environment whatever `process.env` says, which
// was measured — so the hook itself must not hand them on.
describe("the testing pre-push hook", () => {
  test("does not pass git discovery overrides to the test run", () => {
    const work = mkdtempSync(path.join(tmpdir(), "keryx-git-env-hook-"));
    try {
      const repo = path.join(work, "repo");
      execFileSync("git", ["init", "-q", repo], { env: withoutGitDiscoveryOverrides(process.env) });

      const bin = path.join(work, "bin");
      mkdirSync(bin);
      const stub = path.join(bin, "keryx");
      const probes = GIT_DISCOVERY_OVERRIDE_VARS.map((name) => `${name}=\${${name}-UNSET}`).join(" ");
      writeFileSync(stub, `#!/bin/sh\necho "${probes}"\n`);
      chmodSync(stub, 0o755);

      const hook = path.join(work, "pre-push");
      writeFileSync(hook, `#!/bin/sh\n${renderTestingPrePushHook()}`);

      const gitDir = path.join(repo, ".git");
      const run = spawnSync("/bin/sh", [hook], {
        cwd: repo,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: work,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: repo,
          GIT_INDEX_FILE: path.join(gitDir, "index"),
        },
        encoding: "utf8",
      });

      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(GIT_DISCOVERY_OVERRIDE_VARS.map((name) => `${name}=UNSET`).join(" "));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
