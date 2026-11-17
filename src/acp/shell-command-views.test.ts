// The structured views of the picker and modal commands of `keryx acp --profile shell`
// (Keryx Desktop Client M2a, specification §3.9.1 "Views", decision D-10; task T10b).
//
// Two layers. The runner layer builds each view from a temp project fixture and checks its
// shape (title, rows, the command line behind every action, `confirm` on destructive and
// costly ones). The wire layer drives the real server over the in-process harness and sends
// each action back through `_keryx/command`, so a view's action is proved to be a command
// the server really runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROUTING_CATEGORIES } from "../harness/routing/table";
import { RECOMMENDED_JEV_PROFILE } from "../review/jev-profile";
import { loadShellConfig } from "../lib/shell-config";
import { KERYX_ACP_EXTENSION_METHODS } from "./profile";
import { findShellCommand } from "./shell-commands";
import { runShellTextCommand, type ShellCommandHost, type ShellCommandOutcome } from "./shell-command-runners";
import { scheduleActions } from "./shell-views-ops";
import { shellHarness, type ShellHarness } from "./shell-profile.test-helpers";
import { viewText, type ShellView } from "./shell-views";

const TIMEOUT_MS = 30_000;
const COMMAND = KERYX_ACP_EXTENSION_METHODS.command;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project root with `.metaproject/`, as the loaders expect. */
function project(): string {
  const root = tempDir("keryx-acp-views-");
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

function writeTriggers(root: string, triggers: readonly unknown[]): void {
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  writeFileSync(path.join(root, ".metaproject", "triggers.json"), JSON.stringify({ schemaVersion: 1, triggers }, null, 2), "utf8");
}

/** The slice of the host a view command reads: the project, the config directory and the session's model. */
function fakeHost(cwd: string, configDir: string, overrides: Partial<ShellCommandHost> = {}): ShellCommandHost {
  return {
    cwd,
    configDir,
    session: {
      modelIds: () => ({ providerId: "anthropic", modelId: "claude-x" }),
      handle: () => ({ summary: { id: "session-1" } }),
    },
    sessionDir: () => undefined,
    ...overrides,
  } as unknown as ShellCommandHost;
}

async function run(host: ShellCommandHost, name: string, args = ""): Promise<ShellCommandOutcome> {
  const row = findShellCommand(name);
  if (row === undefined) throw new Error(`no row for /${name}`);
  const outcome = await runShellTextCommand(host, row, args);
  if (outcome === undefined) throw new Error(`/${name} ${args} was not answered`);
  return outcome;
}

function viewOf(outcome: ShellCommandOutcome): ShellView {
  if (outcome.view === undefined) throw new Error(`no view in: ${outcome.text}`);
  return outcome.view;
}

const commandsOf = (view: ShellView): string[] => view.rows.flatMap((row) => row.actions.map((item) => item.command));

describe("every served view command answers a view bare", () => {
  const NAMES = ["routing", "jevprofile", "guard", "editguard", "projectctx", "mcp", "bus", "triggers", "schedules", "governance", "autoreview", "task", "decisions", "review", "product", "ac", "workspace"];
  test("each has title, a plain-text rendering with the same title, and surface view", async () => {
    const root = project();
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    for (const name of NAMES) {
      expect(findShellCommand(name)?.surface).toBe("view");
      const outcome = await run(host, name);
      expect(outcome.refused).toBeUndefined();
      const view = viewOf(outcome);
      expect(view.title.length).toBeGreaterThan(0);
      expect(outcome.text).toBe(viewText(view));
      expect(outcome.text.startsWith(view.title)).toBe(true);
    }
  }, TIMEOUT_MS);

  test("every action command is a slash command line of a served command", async () => {
    const root = project();
    writeTriggers(root, [{ name: "sync", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } }]);
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    for (const name of NAMES) {
      for (const line of commandsOf(viewOf(await run(host, name)))) {
        expect(line.startsWith("/")).toBe(true);
        expect(findShellCommand(line.slice(1).split(/\s+/)[0] ?? "")).toBeDefined();
      }
    }
  }, TIMEOUT_MS);
});

describe("/routing", () => {
  test("one row per category with its source, a set action, and a form for a model pick", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "routing"));
    expect(view.title).toBe("Routing");
    expect(view.rows.map((row) => row.id)).toEqual([...ROUTING_CATEGORIES]);
    for (const row of view.rows) {
      expect(row.status).toBeDefined();
      expect(row.actions.map((item) => item.command)).toEqual([`/routing set ${row.id} baseline`]);
    }
    expect(view.form?.submit).toBe("/routing set {category} {model}");
    expect(view.form?.fields.find((field) => field.id === "category")?.options).toEqual([...ROUTING_CATEGORIES]);
  });

  test("set writes the user layer and the next view shows it; bad input is refused with usage", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    const category = ROUTING_CATEGORIES[0];
    const set = await run(host, "routing", `set ${category} openai/gpt-x`);
    expect(set.refused).toBeUndefined();
    expect(set.effects).toEqual(["config"]);
    const row = viewOf(await run(host, "routing")).rows.find((candidate) => candidate.id === category);
    expect(row?.detail).toContain("openai");
    expect(row?.status).toBe("user");
    expect((await run(host, "routing", `set ${category} nonsense`)).refused).toBe(true);
    expect((await run(host, "routing", "set no-such-category openai/x")).text).toContain("Unknown routing category");
    expect((await run(host, "routing", "trust")).text).toContain("nothing to approve");
    expect((await run(host, "routing", "wat")).refused).toBe(true);
  });
});

describe("/schedule form", () => {
  const modelHost = (modelId: string) =>
    fakeHost(project(), tempDir("keryx-acp-views-config-"), {
      session: { modelIds: () => ({ providerId: "anthropic", modelId }), handle: () => ({ summary: { id: "session-1" } }) },
    } as unknown as Partial<ShellCommandHost>);

  test("all five fields are required, hinted, and the ceiling is prefilled", async () => {
    const form = viewOf(await run(modelHost("claude-x"), "schedule")).form;
    expect(form?.fields.map((field) => field.id)).toEqual(["name", "every", "rates", "ceiling", "prompt"]);
    for (const field of form?.fields ?? []) {
      expect(field.required).toBe(true);
      expect(field.placeholder?.length ?? 0).toBeGreaterThan(0);
    }
    const field = (id: string) => form?.fields.find((candidate) => candidate.id === id);
    expect(field("ceiling")?.value).toBe("0.50");
    expect(field("every")?.placeholder).toBe("every 30 minutes · daily at 08:00 · weekdays at 09:30 · cron");
    // An unpriced model gets a hint, not a guess.
    expect(field("rates")?.value).toBeUndefined();
    expect(field("rates")?.placeholder).toContain("1.25,10");
  });

  test("rates are prefilled from keryx's known pricing for the session model", async () => {
    const form = viewOf(await run(modelHost("claude-sonnet-5-5"), "schedule")).form;
    expect(form?.fields.find((candidate) => candidate.id === "rates")?.value).toBe("3,15");
  });

  test("the other forms mark their required fields", async () => {
    const routing = viewOf(await run(fakeHost(project(), tempDir("keryx-acp-views-config-")), "routing")).form;
    expect(routing?.fields.every((field) => field.required === true)).toBe(true);
    expect(routing?.fields.find((field) => field.id === "model")?.placeholder).toBeDefined();
  });
});

describe("/jevprofile", () => {
  test("a row per review.jev key with an opposite-value action, and a confirmed apply", async () => {
    const root = project();
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "jevprofile"));
    expect(view.rows.filter((row) => row.id !== "apply").map((row) => row.id)).toEqual(RECOMMENDED_JEV_PROFILE.map((entry) => entry.key));
    const apply = view.rows.find((row) => row.id === "apply");
    expect(apply?.actions[0]?.command).toBe("/jevprofile apply");
    expect(apply?.actions[0]?.confirm).toContain("tasks.config.json");

    const key = RECOMMENDED_JEV_PROFILE[0]?.key ?? "ci_triage";
    expect((await run(host, "jevprofile", `set ${key} on`)).effects).toEqual(["config"]);
    const after = viewOf(await run(host, "jevprofile")).rows.find((row) => row.id === key);
    expect(after?.status).toBe("on");
    expect(after?.actions[0]?.command).toBe(`/jevprofile set ${key} off`);
    expect((await run(host, "jevprofile", `set ${key} on`)).text).toContain("already on");
    expect(JSON.parse(readFileSync(path.join(root, ".metaproject", "tasks.config.json"), "utf8"))).toBeDefined();

    expect((await run(host, "jevprofile", "set bogus on")).refused).toBe(true);
    expect((await run(host, "jevprofile", `set ${key} maybe`)).text).toContain("Usage");
    expect((await run(host, "jevprofile", "apply")).refused).toBeUndefined();
  });
});

describe("/guard, /editguard, /projectctx", () => {
  test("guard and editguard views carry their on/off toggle as a text subcommand", async () => {
    const configDir = tempDir("keryx-acp-views-config-");
    const host = fakeHost(project(), configDir);
    expect(commandsOf(viewOf(await run(host, "guard")))).toEqual(["/guard on"]);
    await run(host, "guard", "on");
    expect(loadShellConfig(configDir).turnGuard?.enabled).toBe(true);
    expect(commandsOf(viewOf(await run(host, "guard")))).toEqual(["/guard off"]);

    const edit = viewOf(await run(host, "editguard"));
    expect(edit.title).toBe("Edit guard");
    expect(edit.rows[0]?.actions[0]?.command).toMatch(/^\/editguard (on|off)$/);
    expect(edit.body).toContain("No flags recorded yet.");
  });

  test("projectctx opens its status, switches enforcement through a subcommand, and refs opens the references", async () => {
    const root = project();
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "projectctx"));
    expect(view.title).toBe("Project context");
    expect(view.rows[0]?.actions[0]?.command).toMatch(/^\/projectctx (warn|block)$/);
    expect(view.body).toContain("Enforcement:");
    expect((await run(host, "projectctx", "block")).effects).toEqual(["config"]);
    expect(viewOf(await run(host, "projectctx")).rows[0]?.status).toBe("block");
    expect(viewOf(await run(host, "projectctx", "refs")).title).toBe("Project references");
  });
});

describe("/mcp, /bus", () => {
  test("mcp lists the configured servers without a live connection; trust forms are the text runner's", async () => {
    const configDir = tempDir("keryx-acp-views-config-");
    writeFileSync(path.join(configDir, "mcp-servers.json"), JSON.stringify({ servers: { local: { command: "echo", args: ["hi"] } } }), "utf8");
    const view = viewOf(await run(fakeHost(project(), configDir), "mcp"));
    expect(view.title).toBe("MCP servers");
    expect(view.rows.map((row) => row.id)).toContain("local");
    expect(view.body).toContain("keryx mcp");
    expect((await run(fakeHost(project(), configDir), "mcp", "wat")).refused).toBe(true);
  });

  test("bus is off over keryx acp: the view says so and every bus subcommand is refused", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    expect(viewOf(await run(host, "bus")).body).toContain("not joined");
    for (const args of ["send @x hi", "pause @x --ttl 1h why", "resume", "override"]) {
      const outcome = await run(host, "bus", args);
      expect(outcome.refused).toBe(true);
    }
  });
});

describe("/triggers", () => {
  test("lists event triggers with a confirmed run-now, hides it for a disabled one, and opens a detail", async () => {
    const root = project();
    writeTriggers(root, [
      { name: "sync", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
      { name: "off", enabled: false, on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
    ]);
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "triggers"));
    const sync = view.rows.find((row) => row.id === "sync");
    expect(sync?.status).toBe("enabled");
    expect(sync?.actions[0]?.command).toBe("/triggers run sync");
    expect(sync?.actions[0]?.confirm).toContain("keryx trigger run sync");
    expect(view.rows.find((row) => row.id === "off")?.actions).toEqual([]);

    const detail = viewOf(await run(host, "triggers", "sync"));
    expect(detail.title).toBe("Trigger sync");
    expect(detail.body).toContain("post-merge");
    expect((await run(host, "triggers", "off-and-missing")).refused).toBe(true);
    expect((await run(host, "triggers", "run off")).text).toContain("disabled");
    expect((await run(host, "triggers", "run nosuch")).text).toContain("No trigger or schedule named 'nosuch'");
    expect((await run(host, "triggers", "run")).text).toContain("Usage: /triggers run");
  });
});

describe("/schedules", () => {
  test("a schedule declared in triggers.json is listed read-only: run-now only, with a confirm", async () => {
    const root = project();
    writeTriggers(root, [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }]);
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "schedules"));
    const row = view.rows.find((candidate) => candidate.id === "nightly");
    expect(row?.status).toBe("active");
    expect(row?.detail).toContain("declared in triggers.json (read-only)");
    expect(row?.actions.map((item) => item.command)).toEqual(["/schedules run nightly"]);
    expect(row?.actions[0]?.confirm).toContain("keryx trigger run --schedule nightly");
    expect(viewOf(await run(host, "schedules", "nightly")).title).toBe("Schedule nightly");
  });

  test("a local schedule offers pause or resume, run-now and delete; delete and run-now confirm", () => {
    const local = (enabled: boolean) =>
      ({
        entry: {
          name: "check",
          enabled,
          source: "store",
          fire: { kind: "schedule", cron: "0 * * * *" },
          action: { kind: "agent-task", dispatch: { ceilingUsd: 2 } },
        },
      }) as never;
    const active = scheduleActions(local(true));
    expect(active.map((item) => item.command)).toEqual(["/schedules pause check", "/schedules run check", "/schedules delete check"]);
    expect(active[1]?.confirm).toContain("$2");
    expect(active[2]?.confirm).toContain("Delete schedule check");
    const paused = scheduleActions(local(false));
    expect(paused.map((item) => item.command)).toEqual(["/schedules resume check", "/schedules delete check"]);
    expect(paused[1]?.confirm).toBeDefined();
  });

  test("the subcommands refuse an unknown schedule, a missing name and an event trigger", async () => {
    const root = project();
    writeTriggers(root, [{ name: "sync", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } }]);
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    for (const args of ["pause nosuch", "resume nosuch", "delete nosuch", "run nosuch", "run sync", "pause", "nosuch"]) {
      expect((await run(host, "schedules", args)).refused).toBe(true);
    }
    expect((await run(host, "schedules", "run sync")).text).toContain("event trigger");
  });
});

describe("/schedule", () => {
  let keyHome = "";
  const saved = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };
  beforeEach(() => {
    keyHome = tempDir("keryx-acp-schedule-key-");
    process.env["HOME"] = keyHome;
    process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const LINE = '--name check --every "every 4 hours" --rates 3,15 --ceiling 0.5 --max-seconds 300 -- Summarise my open pull requests';

  function scheduleHost(root: string, unitDir: string): ShellCommandHost {
    const program = path.join(keyHome, "bin", "true");
    mkdirSync(path.dirname(program), { recursive: true });
    copyFileSync(Bun.which("true") ?? "/usr/bin/true", program);
    chmodSync(program, 0o755);
    return fakeHost(root, tempDir("keryx-acp-views-config-"), {
      scheduleOverrides: {
        env: {},
        host: {
          backend: "systemd",
          unitDir,
          user: "someone",
          invocation: { execPath: "/opt/node/bin/node", scriptPath: "/opt/keryx/cli.js" },
          run: async (command: string) => (command === "loginctl" ? { code: 0, stdout: "Linger=yes\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }),
        },
        now: () => new Date(2026, 8, 23, 5, 7, 0),
        resolveProgram: () => program,
        accountOf: async () => "someone",
        providerReportsUsage: () => true,
        checkCredential: async () => ({ ok: true }),
      } as never,
    });
  }

  test("bare opens the creation form; a draft writes nothing and answers a view whose Create action carries the card as its confirm", async () => {
    const root = project();
    const unitDir = tempDir("keryx-acp-schedule-units-");
    const host = scheduleHost(root, unitDir);
    const form = viewOf(await run(host, "schedule"));
    expect(form.form?.submit).toContain("/schedule --name {name}");
    expect(form.form?.fields.map((field) => field.id)).toEqual(["name", "every", "rates", "ceiling", "prompt"]);

    const draft = viewOf(await run(host, "schedule", LINE));
    const create = draft.rows[0]?.actions[0];
    expect(create?.command).toBe(`/schedule confirmed ${LINE}`);
    expect(create?.confirm).toContain("cadence: 0 */4 * * * (every 4 hours)");
    expect(draft.body).toBe(create?.confirm);
    expect(await readdir(unitDir)).toEqual([]);
    expect(existsSync(path.join(root, ".metaproject", "data", "schedules"))).toBe(false);
  });

  test("confirmed stores and installs; a bad line is refused before any card", async () => {
    const root = project();
    const unitDir = tempDir("keryx-acp-schedule-units-");
    const host = scheduleHost(root, unitDir);
    const created = await run(host, "schedule", `confirmed ${LINE}`);
    expect(created.refused).toBeUndefined();
    expect(created.text).toContain('"check" stored and installed');
    expect((await readdir(unitDir)).length).toBeGreaterThan(0);
    const listed = viewOf(await run(host, "schedules"));
    const row = listed.rows.find((candidate) => candidate.id === "check");
    expect(row?.actions.map((item) => item.command)).toEqual(["/schedules pause check", "/schedules run check", "/schedules delete check"]);
    expect(row?.actions[2]?.confirm).toContain("Delete schedule check");

    const bad = await run(host, "schedule", "--every nonsense");
    expect(bad.refused).toBe(true);
    expect(bad.view).toBeUndefined();
    expect((await run(host, "schedule", `confirmed --every nonsense`)).refused).toBe(true);
  });
});

describe("/governance, /autoreview, /task", () => {
  test("governance runs the report in process, lists it, and check/close refuse an unknown flow", async () => {
    const root = project();
    const host = fakeHost(root, tempDir("keryx-acp-views-config-"));
    const first = viewOf(await run(host, "governance"));
    expect(first.rows[0]?.actions[0]?.command).toBe("/governance run");
    expect(first.body).toContain("No governance report yet");
    expect((await run(host, "governance", "run")).text).toContain("Governance report written");
    const second = viewOf(await run(host, "governance"));
    expect(second.rows[0]?.status).toBe("stored");
    expect(second.rows[0]?.actions[0]?.label).toBe("Re-run");
    expect((await run(host, "governance", "check nosuch")).refused).toBe(true);
    expect((await run(host, "governance", "close nosuch")).refused).toBe(true);
    expect((await run(host, "governance", "check")).text).toContain("Usage: /governance check");
  }, TIMEOUT_MS);

  test("autoreview lists runs, reads an arbiter log, and refuses start and stop with the reason", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    expect(viewOf(await run(host, "autoreview")).body).toContain("No autonomous reviews yet");
    expect((await run(host, "autoreview", "arbiter")).text).toContain("no autonomous review yet");
    for (const args of ["start https://github.com/o/r/pull/1", "stop"]) {
      const outcome = await run(host, "autoreview", args);
      expect(outcome.refused).toBe(true);
      expect(outcome.text).toContain("does not start or stop autonomous reviews");
    }
    expect((await run(host, "autoreview", "bogus")).refused).toBe(true);
  });

  test("task opens a form over the five Hub modes; submitting without a Hub connection is refused with the reason", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "task"));
    expect(view.form?.fields.find((field) => field.id === "mode")?.options).toEqual(["quick", "bug", "task", "epic", "refactor"]);
    expect(view.form?.submit).toBe("/task {mode} {description} || {criteria}");
    const refused = await run(host, "task", "bug the login page is broken || it loads; it validates");
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain("/task:");
    expect((await run(host, "task", "nonsense words")).text).toContain("Usage: /task");
  });
});

describe("/review, /ci, /conform, /ac, /decisions, /product, /workspace", () => {
  test("bare /review lists nothing to review; accept, accept-ack and decline need a workspace and a proposal", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    expect(viewOf(await run(host, "review")).body).toContain("Nothing needs review right now.");
    for (const verb of ["accept", "accept-ack", "decline"]) {
      const outcome = await run(host, "review", `${verb} only-one-arg`);
      expect(outcome.refused).toBe(true);
      expect(outcome.text).toContain("Usage: /review accept|accept-ack|decline");
    }
    expect((await run(host, "review", "banana")).refused).toBe(true);
  });

  test("ac, product and workspace read their sources and say what is missing; they take no unknown arguments", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    expect(viewOf(await run(host, "ac")).body).toContain("No open flows with frozen acceptance criteria.");
    expect((await run(host, "ac", "recheck nosuch")).refused).toBe(true);
    expect((await run(host, "ac", "recheck")).text).toContain("Usage: /ac recheck");
    expect(viewOf(await run(host, "workspace")).body).toContain("No workspace bound to this session yet");
    expect(viewOf(await run(host, "product")).title).toContain("Product");
    expect((await run(host, "product", "x")).refused).toBe(true);
  });

  test("ci and conform refuse an unknown subcommand; triage and run name what they need", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    expect((await run(host, "ci", "wat")).refused).toBe(true);
    expect((await run(host, "ci", "triage")).text).toContain("Usage: /ci triage");
    expect((await run(host, "conform", "wat")).refused).toBe(true);
    expect((await run(host, "conform", "run")).text).toContain("Usage: /conform run");
  });

  test("decisions opens its report with an arms action and a reason form; reason and change refuse without a decision", async () => {
    const host = fakeHost(project(), tempDir("keryx-acp-views-config-"));
    const view = viewOf(await run(host, "decisions"));
    expect(view.rows[0]?.actions[0]?.command).toBe("/decisions arms");
    expect(view.form?.submit).toBe("/decisions reason {reason}");
    expect((await run(host, "decisions", "arms")).refused).toBeUndefined();
    expect((await run(host, "decisions", "change")).refused).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Over the wire: every action is a command the server runs
// ---------------------------------------------------------------------------

async function send(h: ShellHarness, sessionId: string, name: string, args?: string) {
  const id = h.request(COMMAND, { sessionId, name, ...(args !== undefined ? { args } : {}) });
  const reply = await h.waitFor((f) => f.id === id);
  if (reply.result === undefined) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
  const keryx = ((reply.result["_meta"] as { keryx?: { effects?: string[]; refused?: boolean } } | undefined)?.keryx ?? {}) as {
    effects?: string[];
    refused?: boolean;
  };
  return { text: reply.result["text"] as string, effects: keryx.effects, refused: keryx.refused === true };
}

/** Sends one action's command line (`/name args`) the way a client does. */
function sendLine(h: ShellHarness, sessionId: string, line: string) {
  const [name = "", ...rest] = line.trim().split(/\s+/);
  return send(h, sessionId, name, rest.length > 0 ? rest.join(" ") : undefined);
}

describe("a view's actions round-trip through _keryx/command", () => {
  test("settings family: routing, jevprofile, guard, editguard and projectctx actions write what the next view shows", async () => {
    const configDir = tempDir("keryx-acp-views-config-");
    const h = shellHarness({ serverOptions: { shellConfigDir: configDir } });
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      const category = ROUTING_CATEGORIES[0];
      const set = await sendLine(h, sessionId, `/routing set ${category} openai/gpt-x`);
      expect(set).toMatchObject({ refused: false, effects: ["config"] });
      expect(await send(h, sessionId, "routing")).toMatchObject({ refused: false });
      expect((await send(h, sessionId, "routing")).text).toContain("openai");

      const key = RECOMMENDED_JEV_PROFILE[0]?.key ?? "ci_triage";
      expect((await sendLine(h, sessionId, `/jevprofile set ${key} on`)).effects).toEqual(["config"]);
      expect(existsSync(path.join(h.projectDir, ".metaproject", "tasks.config.json"))).toBe(true);
      expect((await send(h, sessionId, "jevprofile")).text).toContain("[on]");

      expect((await sendLine(h, sessionId, "/guard on")).effects).toEqual(["config"]);
      expect((await sendLine(h, sessionId, "/editguard on")).effects).toEqual(["config"]);
      expect((await sendLine(h, sessionId, "/projectctx block")).effects).toEqual(["config"]);
      expect((await send(h, sessionId, "projectctx")).text).toContain("[block]");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("operations family: governance run, trigger and schedule refusals, autoreview and bus refusals, and the Hub-less /task", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      writeTriggers(h.projectDir, [
        { name: "sync", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
        { name: "off", enabled: false, on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
      ]);
      expect((await sendLine(h, sessionId, "/governance run")).text).toContain("Governance report written");
      expect((await send(h, sessionId, "governance")).text).toContain("[stored]");
      expect((await send(h, sessionId, "triggers")).text).toContain("/triggers run sync");
      expect(await sendLine(h, sessionId, "/triggers run off")).toMatchObject({ refused: true });
      expect(await sendLine(h, sessionId, "/schedules pause nosuch")).toMatchObject({ refused: true });
      expect(await sendLine(h, sessionId, "/autoreview start https://github.com/o/r/pull/1")).toMatchObject({ refused: true });
      expect(await sendLine(h, sessionId, "/bus pause @x why")).toMatchObject({ refused: true });
      expect((await sendLine(h, sessionId, "/task bug the page is broken")).refused).toBe(true);
      expect((await send(h, sessionId, "schedule")).text).toContain("form:");
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);

  test("review family: every subcommand answers over the wire, and a view command never answers 'not served yet'", async () => {
    const h = shellHarness();
    try {
      await h.initialize();
      const { sessionId } = await h.newSession();
      for (const line of ["/review", "/ac", "/product", "/workspace", "/decisions", "/decisions arms", "/ci wat", "/conform wat", "/ac recheck nosuch", "/review decline a"]) {
        const reply = await sendLine(h, sessionId, line);
        expect(reply.text).not.toContain("not served yet");
      }
      expect((await sendLine(h, sessionId, "/review decline a")).refused).toBe(true);
      expect((await sendLine(h, sessionId, "/decisions")).refused).toBe(false);
    } finally {
      await h.end();
    }
  }, TIMEOUT_MS);
});
