// Flow 295 (AC8, AC9): installing the OS timer. Every test uses a temporary unit
// directory and a FAKE systemctl/launchctl/crontab/loginctl (`host.run`).
// Nothing here installs a real timer or changes linger on this machine.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  detectBackend,
  installSchedule,
  isScheduleInstalled,
  lingerStatus,
  pauseSchedule,
  planInstall,
  resumeSchedule,
  systemdUserUnitDir,
  uninstallSchedule,
  type CommandResult,
  type ScheduleHost,
} from "./install";
import { projectScheduleHash } from "./schedule";

interface FakeHost extends ScheduleHost {
  readonly calls: string[];
  crontab: string | undefined;
}

let root = "";
let unitDir = "";
let agents = "";

function fakeHost(backend: "systemd" | "launchd" | "cron", linger = "yes"): FakeHost {
  const host: FakeHost = {
    backend,
    unitDir,
    launchAgentsDir: agents,
    uid: 1000,
    user: "someone",
    invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
    calls: [],
    crontab: undefined,
    run: async (command: string, args: readonly string[], input?: string): Promise<CommandResult> => {
      host.calls.push([command, ...args].join(" "));
      if (command === "loginctl") return { code: 0, stdout: `Linger=${linger}\n`, stderr: "" };
      if (command === "crontab" && args[0] === "-l") {
        return host.crontab === undefined ? { code: 1, stdout: "", stderr: "no crontab for someone" } : { code: 0, stdout: host.crontab, stderr: "" };
      }
      if (command === "crontab" && args[0] === "-") {
        host.crontab = input ?? "";
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return host;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx install root "));
  unitDir = await mkdtemp(path.join(tmpdir(), "keryx-units-"));
  agents = await mkdtemp(path.join(tmpdir(), "keryx-agents-"));
});
afterEach(async () => {
  for (const dir of [root, unitDir, agents]) await rm(dir, { recursive: true, force: true });
});

const CRON = "0 */4 * * *";
/** The runner the operator confirmed (M1): resume reinstalls exactly this. */
const CONFIRMED = { argv: ["/bin/true", "/bin/true"], env: {} };

describe("systemd --user", () => {
  test("writes a project-unique service+timer with a real OnCalendar, Persistent=true, WorkingDirectory and absolute ExecStart, then enables it", async () => {
    const host = fakeHost("systemd");
    const result = await installSchedule(root, "check-github", CRON, host);
    const base = `keryx-${projectScheduleHash(root)}-check-github`;
    expect(result.unit).toBe(`${base}.timer`);
    expect((await readdir(unitDir)).sort()).toEqual([`${base}.service`, `${base}.timer`]);
    const service = await readFile(path.join(unitDir, `${base}.service`), "utf8");
    const timer = await readFile(path.join(unitDir, `${base}.timer`), "utf8");
    expect(service.startsWith(`# keryx-managed ${projectScheduleHash(root)} check-github\n`)).toBe(true);
    expect(service).toContain(`WorkingDirectory=${root}`);
    expect(service).toContain("ExecStart=/bin/true /bin/true trigger run --schedule check-github");
    expect(timer).toContain("\nOnCalendar=*-*-* 00,04,08,12,16,20:00:00\n");
    expect(timer).toContain("\nPersistent=true\n");
    expect(host.calls).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${base}.timer`]);
  });

  test("installing twice leaves exactly one unit pair and does not rewrite it", async () => {
    const host = fakeHost("systemd");
    await installSchedule(root, "check-github", CRON, host);
    const second = await installSchedule(root, "check-github", CRON, host);
    expect(second.wrote).toEqual([]);
    expect((await readdir(unitDir)).length).toBe(2);
    expect(await isScheduleInstalled(root, "check-github", CRON, host)).toBe(true);
  });

  test("two projects with the same schedule name get different units", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "keryx-install-other-"));
    try {
      const host = fakeHost("systemd");
      await installSchedule(root, "check-github", CRON, host);
      await installSchedule(other, "check-github", CRON, host);
      expect((await readdir(unitDir)).length).toBe(4);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("pause disables the timer, resume re-enables it; the unit files stay", async () => {
    const host = fakeHost("systemd");
    await installSchedule(root, "check-github", CRON, host);
    host.calls.length = 0;
    await pauseSchedule(root, "check-github", CRON, host);
    const base = `keryx-${projectScheduleHash(root)}-check-github`;
    expect(host.calls).toEqual([`systemctl --user disable --now ${base}.timer`]);
    expect((await readdir(unitDir)).length).toBe(2);
    host.calls.length = 0;
    await resumeSchedule(root, "check-github", CRON, host, CONFIRMED);
    expect(host.calls).toContain(`systemctl --user enable --now ${base}.timer`);
  });

  test("uninstall deletes only files carrying this project's header, and install refuses to overwrite a foreign file", async () => {
    const host = fakeHost("systemd");
    await installSchedule(root, "check-github", CRON, host);
    const base = `keryx-${projectScheduleHash(root)}-check-github`;
    // Someone replaced the timer with their own file at the same path.
    await writeFile(path.join(unitDir, `${base}.timer`), "[Timer]\nOnCalendar=daily\n", "utf8");
    const result = await uninstallSchedule(root, "check-github", CRON, host);
    expect(result.removed).toEqual([path.join(unitDir, `${base}.service`)]);
    expect(result.skipped).toEqual([path.join(unitDir, `${base}.timer`)]);
    expect(await readdir(unitDir)).toEqual([`${base}.timer`]);
    await expect(installSchedule(root, "check-github", CRON, host)).rejects.toThrow(/not written by keryx for this project/);
  });

  test("keryx never runs loginctl enable-linger — it only reads the linger state", async () => {
    const host = fakeHost("systemd", "no");
    expect(await lingerStatus(host)).toBe("no");
    await installSchedule(root, "check-github", CRON, host);
    await pauseSchedule(root, "check-github", CRON, host);
    await resumeSchedule(root, "check-github", CRON, host, CONFIRMED);
    await uninstallSchedule(root, "check-github", CRON, host);
    expect(host.calls.filter((c) => c.includes("enable-linger"))).toEqual([]);
    expect(host.calls.filter((c) => c.startsWith("loginctl"))).toEqual(["loginctl show-user someone -p Linger"]);
  });

  test("a cron that systemd cannot express is refused, and nothing is written", async () => {
    const host = fakeHost("systemd");
    await expect(installSchedule(root, "odd", "0 9 1 * 1", host)).rejects.toThrow(/restricts BOTH/);
    expect(await readdir(unitDir)).toEqual([]);
  });

  const analyze = Bun.which("systemd-analyze");
  test.skipIf(!analyze)("the installed units pass systemd-analyze verify, with a project path containing a space", async () => {
    const host = fakeHost("systemd");
    expect(root).toContain(" ");
    await mkdir(path.join(root, ".metaproject", "data", "trigger"), { recursive: true });
    await installSchedule(root, "check-github", CRON, host);
    const units = (await readdir(unitDir)).map((f) => path.join(unitDir, f));
    const proc = Bun.spawn([analyze!, "verify", ...units], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`systemd-analyze verify failed: ${stderr}`);
    expect(code).toBe(0);
  });
});

describe("launchd", () => {
  test("writes one plist with the managed header and a calendar interval, bootstraps it; twice is still one plist", async () => {
    const host = fakeHost("launchd");
    await installSchedule(root, "check-github", "30 9 * * 1-5", host);
    await installSchedule(root, "check-github", "30 9 * * 1-5", host);
    const files = await readdir(agents);
    const label = `ai.keryx.${projectScheduleHash(root)}.check-github`;
    expect(files).toEqual([`${label}.plist`]);
    const plist = await readFile(path.join(agents, files[0]!), "utf8");
    expect(plist).toContain(`<!-- keryx-managed ${projectScheduleHash(root)} check-github -->`);
    expect(plist).toContain("<dict><key>Minute</key><integer>30</integer><key>Hour</key><integer>9</integer><key>Weekday</key><integer>1</integer></dict>");
    expect(plist).toContain("<string>trigger</string>");
    expect(host.calls).toContain(`launchctl bootstrap gui/1000 ${path.join(agents, files[0]!)}`);
    const removed = await uninstallSchedule(root, "check-github", "30 9 * * 1-5", host);
    expect(removed.removed).toEqual([path.join(agents, files[0]!)]);
  });
});

describe("cron", () => {
  test("adds one marked block, keeps the operator's own lines, twice is still one block, uninstall removes only the block", async () => {
    const host = fakeHost("cron");
    host.crontab = "MAILTO=me\n15 3 * * * /usr/bin/backup\n";
    await installSchedule(root, "check-github", CRON, host);
    await installSchedule(root, "check-github", CRON, host);
    const begin = `# >>> keryx-managed ${projectScheduleHash(root)} check-github >>>`;
    expect(host.crontab!.split(begin).length - 1).toBe(1);
    expect(host.crontab).toContain("15 3 * * * /usr/bin/backup");
    expect(host.crontab).toContain("0 */4 * * * cd ");
    const plan = await planInstall(root, "check-github", CRON, host);
    expect(plan.location).toBe("crontab (user)");
    await uninstallSchedule(root, "check-github", CRON, host);
    expect(host.crontab).toBe("MAILTO=me\n15 3 * * * /usr/bin/backup\n");
  });
});

// A prior incident: a test that forgot to inject a fake `ScheduleHost` left
// `keryx-<hash>-x.{service,timer}`, ENABLED, in the developer's real
// `~/.config/systemd/user/`. `installSchedule`/`pauseSchedule`/`resumeSchedule`/
// `uninstallSchedule`/`lingerStatus` now refuse the real scheduler under `bun test`
// (`runner()` in install.ts) rather than silently falling back to it, and
// `systemdUserUnitDir()`/`launchAgentsDir()` refuse the real unit directories the
// same way. This proves the refusal AND that the real, un-owned locations on this
// machine are untouched by it — the same before/after check item 4 of the task runs
// by hand, kept here as a regression test that runs in this same `bun test` process.
describe("hermeticity guard: the default host refuses instead of touching the real scheduler", () => {
  function keryxUnitFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f) => f.startsWith("keryx-") || f.startsWith("ai.keryx."));
    } catch {
      return [];
    }
  }
  function realCrontabKeryxLines(): string[] {
    if (Bun.which("crontab") === null) return [];
    try {
      return execFileSync("crontab", ["-l"], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes("keryx"));
    } catch {
      return []; // "no crontab for <user>" exits non-zero — same as an empty crontab.
    }
  }
  function snapshot(): { systemd: string[]; launchAgents: string[]; crontab: string[] } {
    return {
      systemd: keryxUnitFiles(path.join(homedir(), ".config", "systemd", "user")),
      launchAgents: keryxUnitFiles(path.join(homedir(), "Library", "LaunchAgents")),
      crontab: realCrontabKeryxLines(),
    };
  }

  test("bun test really does set NODE_ENV=test (the signal the guard relies on)", () => {
    expect(process.env["NODE_ENV"]).toBe("test");
  });

  test("install/pause/resume/uninstall/lingerStatus with the default host refuse, and the real scheduler is untouched", async () => {
    const before = snapshot();
    // `platform: "linux"` is forced so the refusal is deterministic on every CI
    // platform (probing would otherwise short-circuit to "launchd" on darwin
    // before ever reaching the missing `run`) — the point under test is "no `run`
    // injected", not "which OS this runner happens to be".
    const bare: ScheduleHost = { platform: "linux" };
    await expect(installSchedule(root, "guard-check", CRON, bare)).rejects.toThrow(/refuses to touch the real/);
    await expect(pauseSchedule(root, "guard-check", CRON, bare)).rejects.toThrow(/refuses to touch the real/);
    await expect(resumeSchedule(root, "guard-check", CRON, bare, CONFIRMED)).rejects.toThrow(/refuses to touch the real/);
    await expect(uninstallSchedule(root, "guard-check", CRON, bare)).rejects.toThrow(/refuses to touch the real/);
    await expect(lingerStatus(bare)).rejects.toThrow(/refuses to touch the real/);
    await expect(detectBackend(bare)).rejects.toThrow(/refuses to touch the real/);
    expect(snapshot()).toEqual(before);
  });

  test("systemdUserUnitDir() and a systemd/launchd plan with no unitDir/launchAgentsDir also refuse", async () => {
    expect(() => systemdUserUnitDir()).toThrow(/refuses to touch the real/);
    expect(() => systemdUserUnitDir({})).toThrow(/refuses to touch the real/);
    // `backend` set explicitly bypasses the systemctl probe, isolating the
    // unit-directory refusal from the `runner()` refusal exercised above.
    await expect(planInstall(root, "guard-check", CRON, { backend: "systemd" })).rejects.toThrow(/refuses to touch the real/);
    await expect(planInstall(root, "guard-check", CRON, { backend: "launchd" })).rejects.toThrow(/refuses to touch the real/);
  });
});
