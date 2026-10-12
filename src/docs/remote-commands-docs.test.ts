// Flow 387, AC15: the docs describe the remote commands, the confirmation rule and the commands that
// stay local. The command lists are read from the gateway, so a command added to or removed from it
// without a docs change fails here.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REMOTE_COMMANDS, REMOTE_REFUSED } from "../remote/command-gateway";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const GUIDE = read("docs/docs/guides/drive-keryx-remotely.md");
const CLI = read("docs/docs/cli-reference.md");
const README = read("README.md");

const SECTION_START = GUIDE.indexOf("### Commands from the topic");
const SECTION = SECTION_START === -1 ? "" : GUIDE.slice(SECTION_START, GUIDE.indexOf("### What is not verified"));

describe("the guide's Commands from the topic section (AC15)", () => {
  it("exists, before the not-verified note", () => {
    expect(SECTION_START).toBeGreaterThan(-1);
    expect(SECTION.length).toBeGreaterThan(500);
  });

  it("names every command the gateway allows", () => {
    const missing = REMOTE_COMMANDS.map((command) => command.name).filter((name) => !SECTION.includes(`\`/${name}`));
    expect(missing).toEqual([]);
  });

  it("names every command the gateway refuses", () => {
    const missing = Object.keys(REMOTE_REFUSED).filter((name) => !SECTION.includes(`\`/${name}\``));
    expect(missing).toEqual([]);
  });

  it("states the confirmation rule for mode, plan, delegate and external", () => {
    expect(SECTION).toContain("The confirmation rule");
    expect(SECTION).toContain("/mode trust");
    expect(SECTION).toContain("/mode auto");
    expect(SECTION).toContain("/plan");
    expect(SECTION).toContain("Yes / No");
    expect(SECTION).toMatch(/names the agent/);
    expect(SECTION).toMatch(/external/i);
    expect(SECTION).toMatch(/paid/i);
    expect(SECTION).toContain("/external apply <hash>");
  });

  it("says no and silence change nothing", () => {
    expect(SECTION).toMatch(/\*\*No\*\*, or no press[^.]*changes nothing/);
  });

  it("says which commands are deliberately local", () => {
    expect(SECTION).toContain("These commands stay in the shell");
    for (const name of ["/mcp", "/guard", "/route", "/editguard"]) {
      expect(SECTION).toContain(`\`${name}\``);
    }
    expect(SECTION).toContain("deliberately local");
  });

  it("describes the busy refusal, the same-topic /new and /clear, and /resume", () => {
    expect(SECTION).toContain("main is busy: command deferred");
    expect(SECTION).toContain("--- new session ---");
    expect(SECTION).toContain("--- resumed session ---");
    expect(SECTION).toMatch(/No second topic is created and none is deleted/);
  });

  it("describes the reactions, the typing indicator and the cross-mark limit", () => {
    expect(SECTION).toMatch(/reaction/i);
    expect(SECTION).toMatch(/typing/i);
    expect(SECTION).toContain("about every 4 seconds");
    expect(SECTION).toContain("reactions-unavailable");
    expect(SECTION).toMatch(/cross mark/);
  });

  it("describes the single-use, bound picker tokens and the in-place edit", () => {
    expect(SECTION).toMatch(/single-use/);
    expect(SECTION).toMatch(/bound to the session, the\s+message and the person/);
    expect(SECTION).toMatch(/edited in place/);
  });

  it("describes the TUI Commands tab and the tg label", () => {
    expect(SECTION).toContain("**Commands** tab");
    expect(SECTION).toContain("tg ❯");
  });

  it("does not promise anything about secrets that the gateway does not keep", () => {
    expect(SECTION).toMatch(/never takes a secret as an argument/);
    expect(SECTION).not.toMatch(/Co-Authored-By/i);
  });
});

describe("the CLI reference and the README (AC15)", () => {
  it("the CLI reference's /remote-control entry describes the topic commands and links the guide section", () => {
    const start = CLI.indexOf("- `/remote-control [name|off|status]`");
    expect(start).toBeGreaterThan(-1);
    const entry = CLI.slice(start, CLI.indexOf("- `/channels [status]`", start));
    expect(entry).toContain("/status");
    expect(entry).toContain("Yes/No");
    expect(entry).toContain("/mode trust|auto");
    expect(entry).toContain("/plan off");
    expect(entry).toContain("/delegate");
    expect(entry).toMatch(/external and\s+paid/);
    for (const name of ["/mcp", "/guard", "/route", "/editguard"]) {
      expect(entry).toContain(name);
    }
    expect(entry).toContain("Commands tab");
    expect(entry).toContain("guides/drive-keryx-remotely.md#commands-from-the-topic");
  });

  it("the README's remote control section mentions the commands, the confirmation rule and links the guide", () => {
    const start = README.indexOf("### Remote control from Telegram");
    expect(start).toBeGreaterThan(-1);
    const part = README.slice(start, README.indexOf("## CI integration", start));
    expect(part).toContain("/model");
    expect(part).toContain("Yes press");
    expect(part).toContain("/mcp");
    expect(part).toMatch(/reaction/);
    expect(part).toContain("drive-keryx-remotely.md#commands-from-the-topic");
  });

  it("every link into the guide points at a heading that exists", () => {
    expect(GUIDE).toContain("### Commands from the topic");
    expect(GUIDE).toContain("## Remote control from Telegram");
  });
});
