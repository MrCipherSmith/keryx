import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HERDR_ICON_SVG,
  HERDR_PROGRAM_ENTRY,
  HERDR_TEMPLATE_MD,
  herdrCommand,
  runHerdr,
  type HerdrDeps,
  type HerdrReport,
} from "./herdr";

let root: string;
let deps: HerdrDeps;
let appHome: string;
let coreHome: string;
let programs: string;
let icon: string;
let template: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-herdr-"));
  const config = path.join(root, "xdg");
  mkdirSync(config, { recursive: true });
  deps = { env: { HOME: root, XDG_CONFIG_HOME: config }, platform: "darwin", home: root };
  appHome = path.join(config, "herdr-app");
  coreHome = path.join(config, "herdr-core");
  programs = path.join(appHome, "programs.json");
  icon = path.join(appHome, "keryx", "keryx.svg");
  template = path.join(coreHome, "templates", "keryx.md");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

function makeHomes(): void {
  mkdirSync(appHome, { recursive: true });
  mkdirSync(coreHome, { recursive: true });
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) {
        out[`${path.relative(dir, full)}/`] = "";
        walk(full);
      } else out[path.relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

function actions(report: HerdrReport): Record<string, string> {
  return Object.fromEntries(report.targets.map((row) => [row.target, row.action]));
}

describe("herdr install", () => {
  test("fresh install creates the programs entry, the icon and the template", async () => {
    makeHomes();
    const report = await runHerdr("install", {}, deps);
    expect(actions(report)).toEqual({ programs: "created", icon: "created", template: "created" });
    expect(JSON.parse(readFileSync(programs, "utf8"))).toEqual({ programs: { keryx: HERDR_PROGRAM_ENTRY } });
    expect(JSON.parse(readFileSync(programs, "utf8")).programs.keryx).toEqual({
      name: "Keryx",
      icon: "keryx/keryx.svg",
      tint: true,
      run: ["keryx", "shell"],
    });
    expect(readFileSync(icon, "utf8")).toBe(HERDR_ICON_SVG);
    expect(readFileSync(template, "utf8")).toBe(HERDR_TEMPLATE_MD);
    expect(HERDR_TEMPLATE_MD).toContain("command: keryx shell");
    expect(HERDR_TEMPLATE_MD).not.toContain("ready:");
  });

  test("the template reports over the bus first, plain hc send off a bus, and keeps its other lines", () => {
    const md = HERDR_TEMPLATE_MD;
    expect(md.indexOf("bus_send")).toBeGreaterThan(-1);
    expect(md).toContain('`keryx report --to @<bus name> "<result>"`');
    expect(md.indexOf("Report over the bus first")).toBeLessThan(md.indexOf("plain `hc send"));
    expect(md).toContain("only when you are not on a bus");
    expect(md).toContain("Never answer another terminal's dialog");
    expect(md).toContain("`hc keys` and `hc send --force` only when the operator asks");
    expect(md).toContain('`hc get "$HC_TERMINAL_ID" --json`');
    expect(md).toContain("Work only on the task below and stay inside the scope it names.");
  });

  test("the embedded icon equals the VS Code extension glyph", () => {
    const source = readFileSync(path.join(import.meta.dir, "../../vscode-extension/media/keryx.svg"), "utf8");
    expect(HERDR_ICON_SVG).toBe(source);
  });

  test("preserves every other programs.json key", async () => {
    makeHomes();
    const user = {
      programs: { lazygit: { name: "Lazygit", run: ["lazygit"], tint: false } },
      shells: ["zsh", "fish"],
      interpreters: ["node"],
    };
    writeFileSync(programs, JSON.stringify(user));
    const report = await runHerdr("install", {}, deps);
    expect(report.targets[0]?.action).toBe("updated");
    const after = JSON.parse(readFileSync(programs, "utf8"));
    expect(after.programs.lazygit).toEqual(user.programs.lazygit);
    expect(after.shells).toEqual(user.shells);
    expect(after.interpreters).toEqual(user.interpreters);
    expect(after.programs.keryx).toEqual(HERDR_PROGRAM_ENTRY);
  });

  test("a second run changes nothing and says so", async () => {
    makeHomes();
    await runHerdr("install", {}, deps);
    const before = snapshot(root);
    const report = await runHerdr("install", {}, deps);
    expect(actions(report)).toEqual({ programs: "unchanged", icon: "unchanged", template: "unchanged" });
    expect(snapshot(root)).toEqual(before);

    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await herdrCommand(["install"], deps);
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).toContain("Already installed: nothing to change.");
  });

  test("--dry-run writes nothing and lists the plan", async () => {
    makeHomes();
    writeFileSync(programs, JSON.stringify({ shells: ["zsh"] }));
    const before = snapshot(root);
    const report = await runHerdr("install", { dryRun: true }, deps);
    expect(report.dryRun).toBe(true);
    expect(actions(report)).toEqual({ programs: "updated", icon: "created", template: "created" });
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(`${programs}.keryx-backup`)).toBe(false);
  });

  test("--json output is parseable and matches the report", async () => {
    makeHomes();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await herdrCommand(["install", "--json"], deps);
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines.join("\n")) as HerdrReport;
    expect(parsed.command).toBe("install");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.targets.map((t) => [t.target, t.action, t.path])).toEqual([
      ["programs", "created", programs],
      ["icon", "created", icon],
      ["template", "created", template],
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("herdr install failure paths", () => {
  test("invalid programs.json exits non-zero, names the file and stays byte-identical", async () => {
    makeHomes();
    const garbage = '{ "programs": { oops';
    writeFileSync(programs, garbage);
    const errLines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void errLines.push(a.join(" "));
    try {
      await herdrCommand(["install"], deps);
    } finally {
      console.log = original;
    }
    expect(process.exitCode).toBe(1);
    expect(errLines.join("\n")).toContain(programs);
    expect(errLines.join("\n")).toContain("each target marked error was left untouched");
    expect(readFileSync(programs, "utf8")).toBe(garbage);
    expect(existsSync(`${programs}.keryx-backup`)).toBe(false);
    const report = await runHerdr("install", {}, deps);
    expect(report.targets[0]?.action).toBe("error");
    expect(report.targets[0]?.reason).toContain(programs);
  });

  test("an invalid programs.json stops install: the icon and the template are not written either", async () => {
    makeHomes();
    writeFileSync(programs, "nope");
    const report = await runHerdr("install", {}, deps);
    expect(actions(report)).toEqual({ programs: "error", icon: "skipped", template: "skipped" });
    expect(report.targets[1]?.reason).toContain("programs.json");
    expect(existsSync(icon)).toBe(false);
    expect(existsSync(template)).toBe(false);
  });

  test("a symlinked programs.json stays a link; the change lands in its target", async () => {
    makeHomes();
    const dotfiles = path.join(root, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const real = path.join(dotfiles, "programs.json");
    writeFileSync(real, JSON.stringify({ shells: ["zsh"] }));
    symlinkSync(real, programs);
    await runHerdr("install", {}, deps);
    expect(lstatSync(programs).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).programs.keryx).toEqual(HERDR_PROGRAM_ENTRY);
  });

  test("a dangling programs.json symlink stays a link on install; its target gets the content", async () => {
    makeHomes();
    const dotfiles = path.join(root, "dotfiles");
    const real = path.join(dotfiles, "programs.json");
    symlinkSync(path.join("..", "..", "dotfiles", "programs.json"), programs); // relative and dangling
    const report = await runHerdr("install", {}, deps);
    expect(report.targets[0]?.action).toBe("created");
    expect(lstatSync(programs).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).programs.keryx).toEqual(HERDR_PROGRAM_ENTRY);
  });

  test("a symlinked icon and template stay links under --force; the content lands in the targets", async () => {
    makeHomes();
    mkdirSync(path.dirname(icon), { recursive: true });
    mkdirSync(path.dirname(template), { recursive: true });
    const dotfiles = path.join(root, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const realIcon = path.join(dotfiles, "keryx.svg");
    const realTemplate = path.join(dotfiles, "keryx.md");
    writeFileSync(realIcon, "<svg/>");
    writeFileSync(realTemplate, "mine");
    symlinkSync(realIcon, icon);
    symlinkSync(realTemplate, template);
    const report = await runHerdr("install", { force: true }, deps);
    expect(report.targets.map((t) => t.action)).toEqual(["created", "updated", "updated"]);
    expect(lstatSync(icon).isSymbolicLink()).toBe(true);
    expect(lstatSync(template).isSymbolicLink()).toBe(true);
    expect(readFileSync(realIcon, "utf8")).toBe(HERDR_ICON_SVG);
    expect(readFileSync(realTemplate, "utf8")).toBe(HERDR_TEMPLATE_MD);
  });

  test("a dangling icon symlink is created through, and stays a link", async () => {
    makeHomes();
    mkdirSync(path.dirname(icon), { recursive: true });
    const realIcon = path.join(root, "dotfiles", "keryx.svg");
    symlinkSync(realIcon, icon);
    await runHerdr("install", {}, deps);
    expect(lstatSync(icon).isSymbolicLink()).toBe(true);
    expect(readFileSync(realIcon, "utf8")).toBe(HERDR_ICON_SVG);
  });

  test("a dangling symlink at the backup path is never written through", async () => {
    makeHomes();
    writeFileSync(programs, JSON.stringify({ shells: ["zsh"] }));
    const elsewhere = path.join(root, "elsewhere.json");
    symlinkSync(elsewhere, `${programs}.keryx-backup`);
    await runHerdr("install", {}, deps);
    expect(existsSync(elsewhere)).toBe(false);
    expect(JSON.parse(readFileSync(programs, "utf8")).programs.keryx).toEqual(HERDR_PROGRAM_ENTRY);
  });

  test("a non-object programs value is invalid too", async () => {
    makeHomes();
    writeFileSync(programs, JSON.stringify({ programs: [] }));
    const report = await runHerdr("install", {}, deps);
    expect(report.targets[0]?.action).toBe("error");
    expect(JSON.parse(readFileSync(programs, "utf8"))).toEqual({ programs: [] });
  });

  test("missing herdr-app home skips programs and icon, creates nothing there, still installs the template", async () => {
    mkdirSync(coreHome, { recursive: true });
    const report = await runHerdr("install", {}, deps);
    expect(actions(report)).toEqual({ programs: "skipped", icon: "skipped", template: "created" });
    expect(report.targets[0]?.reason).toContain(appHome);
    expect(existsSync(appHome)).toBe(false);
    expect(readFileSync(template, "utf8")).toBe(HERDR_TEMPLATE_MD);
  });

  test("missing herdr-core home skips the template, creates nothing there, still installs programs and icon", async () => {
    mkdirSync(appHome, { recursive: true });
    const report = await runHerdr("install", {}, deps);
    expect(actions(report)).toEqual({ programs: "created", icon: "created", template: "skipped" });
    expect(existsSync(coreHome)).toBe(false);
  });

  test("neither home present: everything skipped, nothing created", async () => {
    const before = snapshot(root);
    const report = await runHerdr("install", {}, deps);
    expect(Object.values(actions(report))).toEqual(["skipped", "skipped", "skipped"]);
    expect(snapshot(root)).toEqual(before);
  });

  test("a user-modified entry and template are kept without --force and overwritten with it", async () => {
    makeHomes();
    const modified = { programs: { keryx: { name: "Mine", run: ["keryx", "shell", "--x"] } } };
    writeFileSync(programs, JSON.stringify(modified));
    mkdirSync(path.dirname(template), { recursive: true });
    writeFileSync(template, "custom template\n");
    mkdirSync(path.dirname(icon), { recursive: true });
    writeFileSync(icon, "<svg/>");

    const kept = await runHerdr("install", {}, deps);
    expect(actions(kept)).toEqual({ programs: "kept", icon: "kept", template: "kept" });
    expect(JSON.parse(readFileSync(programs, "utf8"))).toEqual(modified);
    expect(readFileSync(template, "utf8")).toBe("custom template\n");
    expect(readFileSync(icon, "utf8")).toBe("<svg/>");
    expect(existsSync(`${programs}.keryx-backup`)).toBe(false);

    const forced = await runHerdr("install", { force: true }, deps);
    expect(actions(forced)).toEqual({ programs: "updated", icon: "updated", template: "updated" });
    expect(JSON.parse(readFileSync(programs, "utf8")).programs.keryx).toEqual(HERDR_PROGRAM_ENTRY);
    expect(readFileSync(template, "utf8")).toBe(HERDR_TEMPLATE_MD);
    expect(readFileSync(icon, "utf8")).toBe(HERDR_ICON_SVG);
  });

  describe("a template shipped by an earlier keryx", () => {
    const OLDER_TEMPLATE = [
      "---",
      "description: Keryx agent shell. Give it one task and the files in scope.",
      "command: keryx shell",
      "---",
      "You are a Keryx agent started through herdr-core by another agent.",
      "Work only on the task below and stay inside the scope it names. Do not start other agents unless the task asks for it.",
      'If another agent assigned this task, report the result or the blocker with `hc send <its address>` when you are done or stuck, not just to acknowledge. Its address is in the `from` of the `<hc from="...">` message; otherwise `hc get "$HC_TERMINAL_ID" --json` shows your parent.',
      "",
    ].join("\n");

    function installOlder(): void {
      makeHomes();
      mkdirSync(path.dirname(template), { recursive: true });
      writeFileSync(template, OLDER_TEMPLATE);
    }

    test("install updates it without --force", async () => {
      installOlder();
      const report = await runHerdr("install", {}, deps);
      expect(actions(report).template).toBe("updated");
      expect(readFileSync(template, "utf8")).toBe(HERDR_TEMPLATE_MD);
    });

    test("remove deletes it", async () => {
      installOlder();
      const report = await runHerdr("remove", {}, deps);
      expect(actions(report).template).toBe("removed");
      expect(existsSync(template)).toBe(false);
    });

    test("status says it is out of date, not user-modified", async () => {
      installOlder();
      const report = await runHerdr("status", {}, deps);
      expect(actions(report).template).toBe("outdated");
    });

    test("an edited copy of it is still the user's", async () => {
      installOlder();
      writeFileSync(template, `${OLDER_TEMPLATE}my own line\n`);
      expect(actions(await runHerdr("install", {}, deps)).template).toBe("kept");
    });
  });

  test("the first modification leaves a backup beside the file and a later one does not overwrite it", async () => {
    makeHomes();
    const original = JSON.stringify({ shells: ["zsh"] });
    writeFileSync(programs, original);
    await runHerdr("install", {}, deps);
    const backup = `${programs}.keryx-backup`;
    expect(readFileSync(backup, "utf8")).toBe(original);

    // A second modification (remove) must keep the first backup.
    await runHerdr("remove", {}, deps);
    expect(readFileSync(backup, "utf8")).toBe(original);
  });

  test("a freshly created programs.json has no backup", async () => {
    makeHomes();
    await runHerdr("install", {}, deps);
    expect(existsSync(`${programs}.keryx-backup`)).toBe(false);
  });

  test("win32 reports every target skipped and touches nothing", async () => {
    makeHomes();
    const before = snapshot(root);
    const report = await runHerdr("install", {}, { ...deps, platform: "win32" });
    expect(Object.values(actions(report))).toEqual(["skipped", "skipped", "skipped"]);
    expect(report.targets[0]?.reason).toContain("APPDATA");
    expect(snapshot(root)).toEqual(before);
  });
});

describe("herdr remove", () => {
  test("deletes only keryx's own content and keeps programs.json and other keys", async () => {
    makeHomes();
    writeFileSync(programs, JSON.stringify({ programs: { lazygit: { name: "L" } }, shells: ["zsh"] }));
    await runHerdr("install", {}, deps);
    const report = await runHerdr("remove", {}, deps);
    expect(actions(report)).toEqual({ programs: "removed", icon: "removed", template: "removed" });
    expect(JSON.parse(readFileSync(programs, "utf8"))).toEqual({ programs: { lazygit: { name: "L" } }, shells: ["zsh"] });
    expect(existsSync(icon)).toBe(false);
    expect(existsSync(path.dirname(icon))).toBe(false);
    expect(existsSync(template)).toBe(false);
    expect(existsSync(path.dirname(template))).toBe(true);
  });

  test("keeps modified entry/files and a non-empty keryx/ directory", async () => {
    makeHomes();
    mkdirSync(path.dirname(icon), { recursive: true });
    writeFileSync(icon, "<svg/>");
    writeFileSync(path.join(path.dirname(icon), "other.txt"), "x");
    mkdirSync(path.dirname(template), { recursive: true });
    writeFileSync(template, "custom\n");
    writeFileSync(programs, JSON.stringify({ programs: { keryx: { name: "Mine" } } }));
    const report = await runHerdr("remove", {}, deps);
    expect(actions(report)).toEqual({ programs: "kept", icon: "kept", template: "kept" });
    expect(readFileSync(icon, "utf8")).toBe("<svg/>");
    expect(readFileSync(template, "utf8")).toBe("custom\n");
    expect(JSON.parse(readFileSync(programs, "utf8")).programs.keryx).toEqual({ name: "Mine" });
  });

  test("keeps the keryx/ directory when another file lives beside a removed icon", async () => {
    makeHomes();
    await runHerdr("install", {}, deps);
    writeFileSync(path.join(path.dirname(icon), "other.svg"), "x");
    await runHerdr("remove", {}, deps);
    expect(existsSync(icon)).toBe(false);
    expect(existsSync(path.join(path.dirname(icon), "other.svg"))).toBe(true);
  });

  test("reports absent when nothing is installed and --dry-run writes nothing", async () => {
    makeHomes();
    const absent = await runHerdr("remove", {}, deps);
    expect(Object.values(actions(absent))).toEqual(["absent", "absent", "absent"]);

    await runHerdr("install", {}, deps);
    const before = snapshot(root);
    const dry = await runHerdr("remove", { dryRun: true }, deps);
    expect(dry.dryRun).toBe(true);
    expect(actions(dry)).toEqual({ programs: "removed", icon: "removed", template: "removed" });
    expect(snapshot(root)).toEqual(before);
  });

  test("remove keeps a symlinked programs.json a link; the entry leaves its target", async () => {
    makeHomes();
    const dotfiles = path.join(root, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const real = path.join(dotfiles, "programs.json");
    writeFileSync(real, JSON.stringify({ shells: ["zsh"] }));
    symlinkSync(real, programs);
    await runHerdr("install", {}, deps);
    const report = await runHerdr("remove", {}, deps);
    expect(report.targets[0]?.action).toBe("removed");
    expect(lstatSync(programs).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ programs: {}, shells: ["zsh"] });
  });

  test("an invalid programs.json fails remove, stays byte-identical and stops the other removals", async () => {
    makeHomes();
    await runHerdr("install", {}, deps);
    writeFileSync(programs, "nope");
    const report = await runHerdr("remove", {}, deps);
    expect(actions(report)).toEqual({ programs: "error", icon: "skipped", template: "skipped" });
    expect(readFileSync(programs, "utf8")).toBe("nope");
    expect(readFileSync(icon, "utf8")).toBe(HERDR_ICON_SVG);
    expect(readFileSync(template, "utf8")).toBe(HERDR_TEMPLATE_MD);
  });
});

describe("herdr status", () => {
  test("reports absent, installed, modified and skipped per target without writing", async () => {
    mkdirSync(appHome, { recursive: true });
    const skippedCore = await runHerdr("status", {}, deps);
    expect(actions(skippedCore)).toEqual({ programs: "absent", icon: "absent", template: "skipped" });

    makeHomes();
    await runHerdr("install", {}, deps);
    expect(actions(await runHerdr("status", {}, deps))).toEqual({
      programs: "installed",
      icon: "installed",
      template: "installed",
    });

    writeFileSync(template, "edited\n");
    writeFileSync(programs, JSON.stringify({ programs: { keryx: { name: "Mine" } } }));
    const before = snapshot(root);
    const modified = await runHerdr("status", { dryRun: true, force: true }, deps);
    expect(actions(modified)).toEqual({ programs: "modified", icon: "installed", template: "modified" });
    expect(modified.dryRun).toBe(false);
    expect(snapshot(root)).toEqual(before);
    expect(modified.targets.every((row) => row.path.length > 0)).toBe(true);
  });
});

describe("herdr CLI", () => {
  test("an unknown subcommand or option sets a non-zero exit code", async () => {
    const original = console.error;
    console.error = () => undefined;
    const log = console.log;
    console.log = () => undefined;
    try {
      await herdrCommand(["bogus"], deps);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await herdrCommand(["install", "--wat"], deps);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = original;
      console.log = log;
    }
  });

  test("each subcommand takes only the flags its usage lists", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    const log = console.log;
    console.log = () => undefined;
    try {
      for (const args of [["remove", "--force"], ["status", "--force"], ["status", "--dry-run"]]) {
        process.exitCode = 0;
        await herdrCommand(args, deps);
        expect(process.exitCode).toBe(1);
      }
      expect(errors).toEqual([
        "Unknown option for herdr remove: --force",
        "Unknown option for herdr status: --force",
        "Unknown option for herdr status: --dry-run",
      ]);
      process.exitCode = 0;
      await herdrCommand(["install", "--dry-run", "--force", "--json"], deps);
      await herdrCommand(["remove", "--dry-run", "--json"], deps);
      await herdrCommand(["status", "--json"], deps);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      console.error = original;
      console.log = log;
    }
  });

  test("--dry-run and --force on the command line reach install", async () => {
    const log = console.log;
    console.log = () => undefined;
    try {
      makeHomes();
      const before = snapshot(root);
      await herdrCommand(["install", "--dry-run"], deps);
      expect(snapshot(root)).toEqual(before);
      expect(existsSync(programs)).toBe(false);

      const modified = { programs: { keryx: { name: "Mine", run: ["keryx", "shell", "--x"] } } };
      writeFileSync(programs, JSON.stringify(modified));
      await herdrCommand(["install"], deps);
      expect(JSON.parse(readFileSync(programs, "utf8"))).toEqual(modified);
      await herdrCommand(["install", "--force"], deps);
      expect(JSON.parse(readFileSync(programs, "utf8")).programs.keryx).toEqual(HERDR_PROGRAM_ENTRY);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      console.log = log;
    }
  });
});
