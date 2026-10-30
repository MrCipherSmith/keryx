import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductionTurnObservation } from "./host.production.test-support";
import { ownedGitSandboxProfile } from "./native-runtime-production";
import { sandboxProfileFromPolicy } from "../harness/process/sandbox/profile";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { isMetaprojectManagedPath } from "../lib/metaproject-gitignore";

const SUPPORT = join(import.meta.dir, "host.production.test-support.ts");
const CLI = join(import.meta.dir, "..", "cli.ts");

/**
 * Runs one production-assembled native coding turn in a child process with a synthetic HOME, no XDG or keryx overrides, hooks on,
 * no global or system Git configuration, and `keryx` on PATH resolving to this checkout's CLI, as the shipped binary resolves itself.
 */
async function productionTurn(checkout: "plain" | "initialized", dataLayout: "default" | "symlinked"): Promise<ProductionTurnObservation> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keryx-production-turn-")));
  try {
    const home = join(root, "home"); const bin = join(root, "bin"); mkdirSync(home); mkdirSync(bin);
    writeFileSync(join(bin, "keryx"), `#!/bin/sh\nexec "${process.execPath}" --no-env-file --config=/dev/null "${CLI}" "$@"\n`); chmodSync(join(bin, "keryx"), 0o755);
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", SUPPORT, checkout, dataLayout], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: "C.UTF-8", KERYX_PRODUCTION_TURN_ROOT: root,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`production turn child failed (${code}): ${stderr.slice(-2000)}`);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as ProductionTurnObservation;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("the owned shadow-Git sandbox writes only its own repository and the owned checkout, reads its repository under a denied data dir, and has no network", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keryx-owned-git-sandbox-")));
  try {
    const cwd = join(root, "checkout"); const dataDir = join(root, "home", ".local", "share", "keryx"); const gitDir = join(dataDir, "sessions", "native", "rewind", "shadow.git");
    mkdirSync(cwd); mkdirSync(gitDir, { recursive: true }); symlinkSync(cwd, join(root, "checkout-link"));
    const base = sandboxProfileFromPolicy({ policy: resolveLocalProfile("monitored-trusted-local"), cwd, tmpDir: join(root, "tmp"), home: join(root, "home") });
    expect(base.readDenyList).toContain(dataDir);
    const owned = ownedGitSandboxProfile(base, { cwd: join(root, "checkout-link"), gitDir });
    expect(owned.writableRoots).toEqual([cwd, gitDir]);
    expect(owned.readDenyList).not.toContain(dataDir);
    expect(owned.readDenyList).toEqual(base.readDenyList.filter((entry) => entry !== dataDir));
    expect(owned).toMatchObject({ mode: "workspace-write", network: "off", allowedDomains: [], required: base.required });
    const readOnly = ownedGitSandboxProfile(sandboxProfileFromPolicy({ policy: resolveLocalProfile("read-only-review"), cwd, tmpDir: join(root, "tmp"), home: join(root, "home") }), { cwd, gitDir });
    expect(readOnly.writableRoots).toEqual([gitDir]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [checkout, dataLayout] of [["plain", "symlinked"], ["initialized", "default"]] as const) {
  test(`a production-assembled native turn with real hooks applies its patch without fencing and records a usable rewind checkpoint (${checkout} checkout, ${dataLayout} data dir)`, async () => {
    const observed = await productionTurn(checkout, dataLayout);
    // The hook runtime's own writes (impact evidence, learning observations, security state) are keryx runtime data, not foreign edits.
    expect(observed.admitted).toBe("admitted");
    expect(observed.messages).toContain("tool-summary: shell_exec: completed");
    expect(observed.messages).toContain("tool-summary: apply_patch: completed");
    expect(observed.state).toBe("idle");
    expect(observed.note).toBe("after\n");
    // The turn recorded its pre-mutation checkpoint on the real owned-git path; nothing reports it unavailable.
    expect(observed.messages.filter((message) => message.includes("checkpoint is unavailable"))).toEqual([]);
    expect(observed.checkpoints).toBe(1);
    expect(observed.previews).toEqual({ files: { status: "applied", ok: true }, history: { status: "applied", ok: true }, both: { status: "applied", ok: true } });
    expect(observed.applied).toBe("applied");
    expect(observed.restored).toBe("before\n");
    expect(observed.finalState).toBe("idle");
    // Everything the turn's hook runtime left in the checkout is untracked keryx runtime data: ignored after `keryx init`, managed either way.
    if (checkout === "initialized") expect(observed.status).toEqual([]);
    else {
      expect(observed.status.length).toBeGreaterThan(0);
      for (const line of observed.status) expect({ line, managed: line.startsWith("?? ") && isMetaprojectManagedPath(line.slice(3)) }).toEqual({ line, managed: true });
    }
  }, 120_000);
}
