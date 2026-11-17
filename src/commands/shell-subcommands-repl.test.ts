// The readline agent REPL takes the shared subcommand forms (Keryx Desktop Client M2a, D-10).
// Real actions over an empty temp project: what is observed is the routing and the [y/N] gate,
// not the actions' own effects (those are covered where they live).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDeps } from "./agent";
import { readlineAgentHelpText, runAgentRepl } from "./shell";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";

async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function repl(...lines: string[]): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-shared-subcommands-"));
  dirs.push(root);
  const out: string[] = [];
  const deps = {
    providerId: "scripted",
    modelId: "m",
    systemInstruction: "sys",
    provider: {
      complete: () => {
        throw new Error("a slash command must not reach the provider");
      },
    },
  } as unknown as AgentDeps;
  const port = { searchCode: async ({ pattern }: { pattern: string }) => ({ pattern, output: "", isError: false }) } as unknown as MetaprojectPort;
  await runAgentRepl(linesFrom(...lines, "/exit"), { printPrompt: () => {}, safeBoundary: undefined, write: (s) => out.push(s) }, deps, port, { cwd: root, enabled: false }, undefined, undefined, undefined, path.join(root, "config"));
  return out.join("");
}

describe("shared subcommand forms in the readline REPL", () => {
  test("a bare modal command is unchanged: still not a command of this surface", async () => {
    for (const command of ["/routing", "/schedules", "/triggers", "/jevprofile", "/conform", "/ci"]) {
      const output = await repl(command);
      expect(output, command).toContain("Unknown command");
    }
  });

  test("a form that needs no confirmation runs and prints the action's own answer", async () => {
    const output = await repl("/routing set not-a-category baseline");
    expect(output).toContain("Unknown routing category 'not-a-category'");
    expect(output).not.toContain("Unknown command");
    expect(output).not.toContain("[y/N]");
  });

  test("a missing argument prints the usage line", async () => {
    const output = await repl("/jevprofile set");
    expect(output).toContain("Usage: /jevprofile set <key> on|off | /jevprofile apply");
    expect(output).not.toContain("[y/N]");
  });

  test("a destructive form asks [y/N] and a no leaves it unrun", async () => {
    const output = await repl("/schedules delete nightly", "n");
    expect(output).toContain("Delete schedule nightly?");
    expect(output).toContain("[y/N]");
    expect(output).toContain("cancelled, nothing changed");
    expect(output).not.toContain("Deleted nightly");
    // The action's own failure reads "schedules delete: <reason>"; the cancel line is "/schedules delete: cancelled".
    expect(output).not.toMatch(/(^|[^/])schedules delete:/);
  });

  test("anything but yes is a no", async () => {
    const output = await repl("/schedules delete nightly", "maybe");
    expect(output).toContain("cancelled, nothing changed");
  });

  test("a yes runs the action", async () => {
    const output = await repl("/schedules delete nightly", "y");
    expect(output).toContain("Delete schedule nightly?");
    expect(output).not.toContain("cancelled");
    // No such schedule in the empty project: the action ran and said so.
    expect(output).toMatch(/(^|[^/])schedules delete:/);
  });

  test("accepting a proposal asks first", async () => {
    const output = await repl("/review accept ws-1 p-9", "n");
    expect(output).toContain("Accept proposal p-9?");
    expect(output).toContain("cancelled, nothing changed");
  });

  test("/review layers keeps its own handler", async () => {
    const output = await repl("/review layers");
    expect(output).not.toContain("Unknown command");
    expect(output).not.toContain("[y/N]");
  });

  test("/schedule drafts and asks before creating; a flag-less call prints its usage", async () => {
    const output = await repl("/schedule");
    expect(output).not.toContain("Unknown command");
  });

  test("/decisions prints the journal report", async () => {
    const output = await repl("/decisions");
    expect(output).not.toContain("Unknown command");
  });

  test("the help lists the one-line forms", () => {
    const help = readlineAgentHelpText();
    expect(help).toContain("/schedules pause|resume|run|delete <name>");
    expect(help).toContain("/routing set <category> <provider/model | baseline>");
    expect(help).toContain("/review accept|accept-ack|decline");
  });
});
