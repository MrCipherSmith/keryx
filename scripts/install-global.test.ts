// Flow 114 / AC4 + AC5 — the testable half of open item O-4: `scripts/install.sh
// --global` produces a wrapper that actually runs the CLI.
//
// O-4's second clause split in two (flow 113): "the global install produces a
// working CLI" is testable and was deferred as an installer concern; "…launches
// the TUI" needs a pty CI does not have and stays open. This is the first half.
//
// ISOLATION — the whole point, because a global installer defaults to the
// developer's real home:
//   * KERYX_HOME / KERYX_BIN_DIR point at a fresh temp prefix, never ~/.keryx or
//     ~/.local/bin. Asserted below by checking the real paths are untouched.
//   * KERYX_REPO_URL points at a bare clone of THIS checkout, so the install
//     clones locally with no network to the published repository. KERYX_REF is a
//     throwaway branch in that bare repo.
//   * HOME is redirected too, so `install.sh`'s own `$HOME/.bun/bin/bun` /
//     `$HOME/.local/bin` fallbacks cannot reach the real home either.
//
// The suite skips cleanly, with a visible reason, when `git` is genuinely absent
// (install.sh requires it) — it does not silently pass.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, access, readdir, chmod, symlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, delimiter as PATH_DELIMITER } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");
const INSTALL_REF = "keryx-install-global-test";

const hasGit = Bun.which("git") !== null;
const hasBun = Bun.which("bun") !== null || (await fileExists(join(homedir(), ".bun", "bin", "bun")));
/** install.sh needs both git (to clone) and bun (to install + run). */
const installable = hasGit && hasBun;
const guardedTest = test.skipIf(!installable);

// AC1 (flow 142 / P4) only makes a claim about Linux hosts — install.sh's
// `report_sandbox_status` branches on `uname -s`, and this suite runs on
// whatever OS the test machine actually is, so the assertion is scoped to
// where it is true rather than skipped silently on a mismatch.
const isLinuxHost = process.platform === "linux";
const linuxGuardedTest = test.skipIf(!installable || !isLinuxHost);

/**
 * PATH on which `bwrap` cannot be resolved — regardless of whether THIS
 * machine happens to have bubblewrap installed. AC1 requires exactly this: the
 * test must not depend on the real test machine lacking bubblewrap.
 *
 * The obvious implementation — drop every PATH directory containing `bwrap` —
 * is wrong, and was silently broken on any host where bubblewrap is installed
 * in `/usr/bin`: dropping that directory takes `bash`, `git`, `sed` and `uname`
 * with it, so `install.sh` could not be spawned at all and these tests failed
 * with `Executable not found in $PATH: "bash"`. It passed on CI only because
 * `ubuntu-latest` has no bubblewrap, which is precisely the host dependency the
 * helper exists to remove.
 *
 * So instead: for each directory that does contain `bwrap`, mirror its contents
 * into a temp directory as symlinks, minus `bwrap`, and substitute the mirror
 * in place of the original. Every other tool stays reachable; only bubblewrap
 * disappears. Directories that fail to read are kept as they are — a permission
 * error is not evidence of anything.
 *
 * Built once per suite; `mirrorRoot` must be inside the workspace so `afterAll`
 * removes it.
 */
let cachedPathWithoutBwrap: string | undefined;

async function pathWithoutBwrap(): Promise<string> {
  if (cachedPathWithoutBwrap !== undefined) {
    return cachedPathWithoutBwrap;
  }
  const dirs = (process.env.PATH ?? "").split(PATH_DELIMITER).filter(Boolean);
  const resolved: string[] = [];
  let mirrorIndex = 0;

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      resolved.push(dir);
      continue;
    }
    if (!entries.includes("bwrap")) {
      resolved.push(dir);
      continue;
    }

    const mirror = join(workspace, `path-mirror-${mirrorIndex++}`);
    await mkdir(mirror, { recursive: true });
    await Promise.all(
      entries
        .filter((entry) => entry !== "bwrap")
        // A broken symlink (a dangling entry in the source dir) is harmless
        // here: it resolves to nothing, exactly as it did before.
        .map((entry) => symlink(join(dir, entry), join(mirror, entry)).catch(() => undefined)),
    );
    resolved.push(mirror);
  }

  cachedPathWithoutBwrap = resolved.join(PATH_DELIMITER);
  return cachedPathWithoutBwrap;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (!installable) {
  const missing = [!hasGit ? "git" : undefined, !hasBun ? "bun" : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" + ");
  // A visible reason, not a silent green: bun prints the skip, and this makes the
  // WHY explicit in the log next to it.
  console.warn(`[install-global.test] SKIPPED — install.sh prerequisite missing: ${missing}`);
}

let workspace: string;
let originGit: string;
let prefixHome: string;
let binDir: string;
let fakeHome: string;

/**
 * Budget for anything in this file that shells out to git or runs install.sh
 * (which itself runs `bun install` inside a fresh clone). Generous on purpose:
 * these steps are I/O- and contention-bound, so a tight bound produces a flake
 * that looks like a product bug — a SIGTERM'd git — rather than a slow fixture.
 */
const FIXTURE_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  if (!installable) {
    return;
  }
  workspace = await mkdtemp(join(tmpdir(), "keryx-install-global-"));
  originGit = join(workspace, "origin.git");
  prefixHome = join(workspace, "prefix", "keryx");
  binDir = join(workspace, "bin");
  fakeHome = join(workspace, "home");

  // A bare local origin, on a throwaway ref, that install.sh clones from — so no
  // network reaches the published repository.
  //
  // It is built from a SNAPSHOT of HEAD's *tree* (`git archive` → fresh
  // single-commit repo), NOT by pushing REPO_ROOT's history. That is deliberate
  // and load-bearing: GitHub Actions (`actions/checkout@v4`) checks the repo out
  // as a SHALLOW clone by default, and `git push` from a shallow clone is
  // rejected with exit 128. The previous `git -C REPO_ROOT push … HEAD:…`
  // therefore failed silently on CI (its exit code was never checked), leaving
  // this origin empty, so install.sh's `git clone --branch` failed with 128 —
  // green locally (full history), red in CI (shallow). Snapshotting the tree
  // sidesteps history entirely, so shallow vs. full makes no difference, and a
  // real user (who clones GitHub's full history) was never affected. The steps
  // below use runOk so any future fixture breakage fails LOUDLY instead of
  // silently emptying the origin again.
  const snapshot = join(workspace, "snapshot");
  const snapshotTar = join(workspace, "snapshot.tar");
  await mkdir(snapshot, { recursive: true });

  await runOk(["git", "init", "--bare", "-b", INSTALL_REF, originGit]);
  await runOk(["git", "-C", REPO_ROOT, "archive", "--format=tar", "-o", snapshotTar, "HEAD"]);
  await runOk(["tar", "-xf", snapshotTar, "-C", snapshot]);
  await runOk(["git", "-c", `init.defaultBranch=${INSTALL_REF}`, "init", snapshot]);
  await runOk(["git", "-C", snapshot, "add", "-A"]);
  await runOk([
    "git",
    "-C",
    snapshot,
    "-c",
    "user.email=install-global-test@keryx.local",
    "-c",
    "user.name=keryx install-global test",
    "commit",
    "--quiet",
    "-m",
    "flow114 install-global test snapshot",
  ]);
  await runOk(["git", "-C", snapshot, "push", "--quiet", originGit, `HEAD:refs/heads/${INSTALL_REF}`]);
  // Bun's default hook timeout is 5s. This fixture shells out to git five times
  // (archive, init, add, commit, push) over the whole worktree, which fits well
  // under 5s on an idle machine and does NOT on a loaded one — the failure then
  // surfaces as a SIGTERM'd `git commit` (exit 143), which reads like a hung git
  // rather than a budget the fixture outgrew. Observed failing 5/5 on a busy
  // laptop while passing in CI and on an idle checkout.
}, FIXTURE_TIMEOUT_MS);

afterAll(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
}, FIXTURE_TIMEOUT_MS);

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], opts?: { env?: Record<string, string>; cwd?: string }): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    cwd: opts?.cwd ?? workspace,
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Blob([""]),
    env: opts?.env ?? { PATH: process.env.PATH ?? "" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

/**
 * Like {@link run} but throws — with the captured stderr/stdout — on a non-zero
 * exit. Used for fixture setup so a broken origin build (e.g. a `git push` that
 * fails on a shallow CI checkout) fails LOUDLY here instead of silently leaving
 * an empty origin that only surfaces later as an opaque install.sh exit 128.
 */
async function runOk(argv: string[], opts?: { env?: Record<string, string>; cwd?: string }): Promise<Ran> {
  const result = await run(argv, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `command failed (exit ${result.exitCode}): ${argv.join(" ")}\n` +
        `----- stderr -----\n${result.stderr}\n----- stdout -----\n${result.stdout}`,
    );
  }
  return result;
}

/** The env that pins install.sh to the temp prefix and the local origin. */
function installEnv(overrides?: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: fakeHome,
    KERYX_HOME: prefixHome,
    KERYX_BIN_DIR: binDir,
    KERYX_REPO_URL: originGit,
    KERYX_REF: INSTALL_REF,
    ...overrides,
  };
}

// install.sh runs `bun install` inside the clone; 4 min keeps a slow-network
// dev machine safe while still failing rather than hanging forever.
const INSTALL_TIMEOUT_MS = 240_000;

guardedTest(
  "AC4: install.sh --global produces a wrapper that runs the CLI, in a temp prefix",
  async () => {
    const install = await run(["bash", INSTALL_SH, "--global"], { env: installEnv() });
    expect(install.stderr).not.toContain("Missing required command");
    // Surface WHY install.sh failed in the CI log — a bare `Expected 0` hides the
    // installer's own stderr, which is exactly what made the original CI-only
    // failure (git exit 128) undiagnosable from the run log.
    if (install.exitCode !== 0) {
      console.error(
        `[install-global.test] install.sh --global exited ${install.exitCode}\n` +
          `----- stderr -----\n${install.stderr}\n----- stdout -----\n${install.stdout}`,
      );
    }
    expect(install.exitCode).toBe(0);

    const wrapper = join(binDir, "keryx");

    // Executable …
    const mode = (await stat(wrapper)).mode;
    expect(mode & 0o111).not.toBe(0);

    // … and it actually runs the CLI. `--version` is a pure, network-free path
    // that still exercises argv parsing through the real cli.ts entrypoint.
    const version = await run([wrapper, "--version"], {
      env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    // The wrapper points into the temp prefix, not anywhere real.
    const wrapperText = await Bun.file(wrapper).text();
    expect(wrapperText).toContain(prefixHome);
    expect(wrapperText).not.toContain(join(homedir(), ".keryx"));
  },
  INSTALL_TIMEOUT_MS,
);

guardedTest("AC4: the real ~/.keryx and ~/.local/bin are never touched", async () => {
  // The install above wrote only under the temp workspace. Prove the real
  // locations the installer defaults to were not created by this run: if they
  // already exist (a real install on the dev box), their mtime must predate the
  // test workspace; if they do not, they must still not.
  const realKeryx = join(homedir(), ".keryx");
  const realBin = join(homedir(), ".local", "bin", "keryx");
  const workspaceBirth = (await stat(workspace)).birthtimeMs;

  for (const path of [realKeryx, realBin]) {
    if (await fileExists(path)) {
      const touched = (await stat(path)).mtimeMs;
      expect(touched).toBeLessThan(workspaceBirth);
    }
  }
  // And everything this run produced is inside the workspace.
  expect(prefixHome.startsWith(workspace)).toBe(true);
  expect(binDir.startsWith(workspace)).toBe(true);
});

// --- AC5: the test is falsifiable -------------------------------------------
//
// A copy of install.sh with the wrapper-producing heredoc neutered must make the
// AC4 assertions fail. This runs the SAME steps against that broken installer
// and asserts the wrapper is missing / non-functional — so the green AC4 test
// above is known to be load-bearing, not vacuous. (Recorded in the flow journal
// with the exact failure output.)
guardedTest(
  "AC5: a broken wrapper step is caught (the AC4 assertions can fail)",
  async () => {
    const original = await Bun.file(INSTALL_SH).text();
    // Neuter only the wrapper emission: the clone/install still happen, so this
    // isolates "the wrapper was produced" from "the install ran at all".
    const broken = original.replace(
      /cat > "\$BIN_DIR\/keryx" <<EOF[\s\S]*?\nEOF\n/,
      'echo "flow114: wrapper step deliberately broken" >&2\n',
    );
    expect(broken).not.toBe(original); // the replacement really matched

    const brokenSh = join(workspace, "install-broken.sh");
    await Bun.write(brokenSh, broken);

    const brokenBin = join(workspace, "bin-broken");
    const install = await run(["bash", brokenSh, "--global"], {
      env: installEnv({ KERYX_BIN_DIR: brokenBin }),
    });
    // The install script itself still exits 0 (chmod on a missing file is the
    // only casualty, guarded) — the point is the ARTIFACT is absent…
    const wrapper = join(brokenBin, "keryx");
    expect(await fileExists(wrapper)).toBe(false);

    // …and an attempt to run it fails, which is exactly what AC4 asserts against.
    // A missing wrapper cannot be spawned at all (ENOENT) — that IS the failure
    // AC4's `keryx --version` would surface; a produced-but-broken wrapper would
    // instead exit non-zero. Both count as "does not run".
    let ran: Ran | undefined;
    let spawnError: unknown;
    try {
      ran = await run([wrapper, "--version"], {
        env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
      });
    } catch (error) {
      spawnError = error;
    }
    expect(spawnError !== undefined || (ran !== undefined && ran.exitCode !== 0)).toBe(true);
    void install; // stdout/stderr captured for the journal record
  },
  INSTALL_TIMEOUT_MS,
);

// --- AC1 (flow 142 / P4), AC12 (keryx-linux-containment step 1) --------------
//
// AC1: "On a Linux host without bubblewrap, installation states that OS
// containment is unavailable and names what provides it."
//
// AC12 is the correction. The installer used to decide this from `command -v
// bwrap`, and on Ubuntu 23.10+ that answer is "found" while every contained run
// dies — so it printed "Filesystem containment and network-off are available"
// on hosts where nothing was contained. It now delegates to `keryx sandbox
// status`, which runs one trial contained command. The three tests below cover
// the three outcomes: no launcher, a launcher that contains, and a launcher
// that is present and does not contain (the shipped defect).
//
// The PATH handed to install.sh is filtered to remove any directory that would
// resolve `bwrap` (see `pathWithoutBwrap` above), so each assertion holds
// regardless of whether bubblewrap happens to be installed on the machine
// running the suite — it is the installer's message under a controlled PATH
// being tested, not a fact about this host.

/** Write an executable shim into a fresh directory and return that directory. */
async function shimDirWith(name: string, program: string, script: string): Promise<string> {
  const dir = join(workspace, name);
  await mkdir(dir, { recursive: true });
  const shim = join(dir, program);
  await Bun.write(shim, script);
  await chmod(shim, 0o755);
  return dir;
}

/** A `bwrap` shim directory. */
function bwrapShim(name: string, script: string): Promise<string> {
  return shimDirWith(name, "bwrap", script);
}

/**
 * Surface WHY install.sh failed in the CI log before asserting on the exit
 * code. A bare `Expected 0` hides the installer's own stderr, which is exactly
 * what made the original CI-only failure (git exit 128) undiagnosable from the
 * run log — see the AC4 test above. Every installer assertion goes through this.
 */
function expectInstallSucceeded(label: string, install: Ran): void {
  if (install.exitCode !== 0) {
    console.error(
      `[install-global.test] ${label} install exited ${install.exitCode}\n` +
        `----- stderr -----\n${install.stderr}\n----- stdout -----\n${install.stdout}`,
    );
  }
  expect(install.exitCode).toBe(0);
}

linuxGuardedTest(
  "AC1: Linux install without bubblewrap on PATH states OS containment is unavailable and names bubblewrap",
  async () => {
    const filteredPath = await pathWithoutBwrap();
    const install = await run(["bash", INSTALL_SH, "--global"], {
      env: installEnv({ PATH: filteredPath, KERYX_BIN_DIR: join(workspace, "bin-ac1") }),
    });
    // Never a gate: install.sh must still succeed even though containment is
    // unavailable — this is a report, not a blocker (P4's "expected outcome").
    expectInstallSucceeded("AC1", install);

    expect(install.stdout).toMatch(/OS containment is unavailable/i);
    expect(install.stdout).toMatch(/bubblewrap/i);
    // AC1 requires it NAME what provides containment, not just say "missing".
    expect(install.stdout).toMatch(/install it:.*bubblewrap/i);
    // Nothing was probed, because there was nothing to probe.
    expect(install.stdout).toMatch(/containment probe: not run/i);
  },
  INSTALL_TIMEOUT_MS,
);

linuxGuardedTest(
  "AC12: THE DEFECT — a bwrap that is present and fails to contain is reported as NOT working, verbatim",
  async () => {
    // This shim reproduces the exact failure measured on a stock Ubuntu 24.04:
    // the binary is on PATH, `command -v` finds it, and it cannot build its
    // boundary. Before the probe, install.sh printed "Filesystem containment
    // and network-off are available" in precisely this situation.
    const shimDir = await bwrapShim(
      "bwrap-shim-broken",
      "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n",
    );
    const filteredPath = await pathWithoutBwrap();
    const install = await run(["bash", INSTALL_SH, "--global"], {
      env: installEnv({
        PATH: `${shimDir}${PATH_DELIMITER}${filteredPath}`,
        KERYX_BIN_DIR: join(workspace, "bin-ac12-broken"),
      }),
    });
    expectInstallSucceeded("AC12 broken-shim", install);

    // The launcher IS found — and that is explicitly not the same as working.
    expect(install.stdout).toMatch(/containment probe: FAILED/i);
    expect(install.stdout).toMatch(/OS containment is unavailable/i);
    // The launcher's own words, quoted rather than paraphrased.
    expect(install.stdout).toContain("bwrap: setting up uid map: Permission denied");
    // The remediation names the AppArmor profile…
    expect(install.stdout).toContain("/etc/apparmor.d/bwrap");
    // …and never the machine-wide sysctl, which ADR-0010 rejected outright.
    expect(install.stdout).not.toContain("apparmor_restrict_unprivileged_userns");
    // The sentence that was the defect.
    expect(install.stdout).not.toMatch(/containment and network-off are available/i);
  },
  INSTALL_TIMEOUT_MS,
);

linuxGuardedTest(
  "AC12: falsifiable — a bwrap that DOES contain the trial run is reported as working",
  async () => {
    // Proves the two assertions above are load-bearing rather than a
    // permanently-negative report: the only difference from the previous case
    // is that this shim execs the wrapped command instead of failing.
    //
    // `wrapBwrap` produces `bwrap <flags…> -- <cmd> [args…]`, so the shim
    // discards everything up to and including the `--` and runs the rest.
    const shimDir = await bwrapShim(
      "bwrap-shim-working",
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--" ]; then shift; break; fi\n  shift\ndone\nexec "$@"\n',
    );
    const filteredPath = await pathWithoutBwrap();
    const install = await run(["bash", INSTALL_SH, "--global"], {
      env: installEnv({
        PATH: `${shimDir}${PATH_DELIMITER}${filteredPath}`,
        KERYX_BIN_DIR: join(workspace, "bin-ac12-working"),
      }),
    });
    expectInstallSucceeded("AC12 working-shim", install);
    expect(install.stdout).toMatch(/containment probe: OK/i);
    expect(install.stdout).not.toMatch(/OS containment is unavailable/i);
    expect(install.stdout).toMatch(/confirmed by a trial contained command/i);
    // The trial exercised filesystem containment and network-off. It exercised
    // nothing about the allowlist or masking, and those rows are unimplemented
    // on Linux anyway — so no row may read as confirmed except the two.
    expect(install.stdout.match(/confirmed by a trial contained command/gi)?.length).toBe(2);
  },
  INSTALL_TIMEOUT_MS,
);

linuxGuardedTest(
  "AC12: when `keryx sandbox status` cannot run at all, the installer claims NOTHING and still exits 0",
  async () => {
    // The one branch left where the installer could regress into an optimistic
    // guess. A keryx that cannot start must produce "nothing is claimed either
    // way" — never a containment claim, and never a failed install, because
    // this is a report and not a gate.
    //
    // The failure is injected by pre-seeding KERYX_BIN_DIR with a `keryx`
    // wrapper that exits non-zero; install.sh overwrites it with the real
    // wrapper, so instead the wrapper's TARGET is broken: KERYX_HOME points at
    // a directory whose src/cli.ts will not exist because the clone is sent
    // somewhere else. Simpler and more direct: shadow `bun` with a shim that
    // fails only for `sandbox status`.
    const binDirForRun = join(workspace, "bin-ac12-unknown");

    // The shim shadows `bun` on PATH and passes everything else through to the
    // REAL bun by absolute path. Resolved here, and asserted, because a
    // relative `exec bun` would re-resolve through the shimmed PATH and find
    // the shim again — an infinite re-exec that presents as a silent 240s
    // timeout rather than a failure. `hasBun` (above) admits a host where bun
    // exists only under $HOME, so the fallback is a real path, not a guess.
    const realBun = Bun.which("bun") ?? join(homedir(), ".bun", "bin", "bun");
    expect(await fileExists(realBun)).toBe(true);

    const shimDir = await shimDirWith(
      "keryx-status-broken",
      "bun",
      [
        "#!/bin/sh",
        "# Fail only the containment report; every other bun invocation (install,",
        "# --version, the CLI itself) passes through to the real bun.",
        'for arg in "$@"; do',
        '  if [ "$arg" = "sandbox" ]; then',
        '    echo "keryx: exploded while reporting containment" >&2',
        "    exit 3",
        "  fi",
        "done",
        `exec ${JSON.stringify(realBun)} "$@"`,
      ].join("\n"),
    );

    const filteredPath = await pathWithoutBwrap();
    const install = await run(["bash", INSTALL_SH, "--global"], {
      env: installEnv({
        PATH: `${shimDir}${PATH_DELIMITER}${filteredPath}`,
        KERYX_BIN_DIR: binDirForRun,
      }),
    });
    expectInstallSucceeded("AC12 unknown-status", install);

    expect(install.stdout).toMatch(/could not determine containment status/i);
    expect(install.stdout).toMatch(/nothing is claimed either way/i);
    // The reason is surfaced rather than swallowed — this is the one path where
    // the installer admits it does not know, so the why is all it has to offer.
    expect(install.stdout).toContain("keryx: exploded while reporting containment");
    // And above all: no claim, in either direction.
    expect(install.stdout).not.toMatch(/containment probe: (OK|FAILED)/i);
    expect(install.stdout).not.toMatch(/are available/i);
  },
  INSTALL_TIMEOUT_MS,
);

linuxGuardedTest(
  "AC12: the PROJECT install reports the probe too — the two-argument delegation form works",
  async () => {
    // `report_sandbox_status` is invoked in two shapes: `"$BIN_DIR/keryx"` for
    // --global and `"$BUN_BIN" "$RUNTIME_DIR/src/cli.ts"` for --project. Only
    // the first was covered, so a quoting or argument-order regression in the
    // second would ship silently.
    const projectDir = join(workspace, "project-install");
    await mkdir(projectDir, { recursive: true });

    const filteredPath = await pathWithoutBwrap();
    const install = await run(["bash", INSTALL_SH, "--project", "--yes", "--no-gdgraph", "--no-gdctx"], {
      env: installEnv({ PATH: filteredPath }),
      cwd: projectDir,
    });
    expectInstallSucceeded("AC12 project-install", install);

    expect(install.stdout).toMatch(/OS sandbox containment:/i);
    expect(install.stdout).toMatch(/containment probe: not run/i);
    expect(install.stdout).toMatch(/OS containment is unavailable/i);
  },
  INSTALL_TIMEOUT_MS,
);
