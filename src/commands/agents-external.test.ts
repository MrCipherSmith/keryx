// Tests for `keryx agents external` (flow 176, T15).
//
// The probe is injected in every test, so nothing here runs `codex --version` or
// `claude --version`, let alone a real agent turn. The point of most of these
// assertions is one property: the surface must never render "a binary exists" or
// "nobody asked" as though it meant "ready". A green tick that means "nobody
// asked" costs the operator a dispatch that cannot run (security-policy §1).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentsExternalCommand,
  buildExternalAgentsJson,
  describeAvailability,
  renderExternalAgents,
  type AgentsExternalDeps,
  type ExternalAgentRow,
} from "./agents-external";
import { EXTERNAL_AGENTS, resolveAvailability } from "../harness/external/registry";
import type { VersionProbe } from "../harness/external-agent-probe";
import { loadExternalAgentsConfig } from "../capability/external-agents";

const CODEX = EXTERNAL_AGENTS[0];
if (CODEX === undefined) throw new Error("the external agent registry is empty");

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "keryx-extcli-"));
  process.exitCode = 0;
});

afterEach(async () => {
  // Cleared, not restored: these tests deliberately set `process.exitCode = 1`,
  // and a leaked non-zero code would fail the WHOLE `bun test` run with no
  // failing assertion to point at — a genuinely nasty thing to debug.
  process.exitCode = 0;
  await rm(configDir, { recursive: true, force: true });
});

/** Deps that read no real config and see no CI markers. */
function deps(overrides: Partial<AgentsExternalDeps> = {}): AgentsExternalDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    cwd: configDir,
    env: {},
    configDir,
    log: (line) => lines.push(line),
    ...overrides,
  };
}

/** A probe that reports a specific banner for every binary. */
function probeReturning(outcome: Awaited<ReturnType<VersionProbe>>): VersionProbe {
  return async () => outcome;
}

describe("the three availability states are rendered as themselves", () => {
  test("not-probed says nobody asked, and points at the probe command", () => {
    const text = describeAvailability(CODEX, resolveAvailability(CODEX, undefined));
    expect(text).toContain("not probed");
    expect(text).toContain(CODEX.id);
  });

  test("binary-missing names the binary that is not on PATH", () => {
    const text = describeAvailability(CODEX, resolveAvailability(CODEX, { binaryFound: false }));
    expect(text).toContain("not installed");
    expect(text).toContain(CODEX.binary);
  });

  test("available reports the version AND states that a login was not verified", () => {
    const text = describeAvailability(
      CODEX,
      resolveAvailability(CODEX, { binaryFound: true, detectOutput: "codex-cli 0.200.0" }),
    );
    expect(text).toContain("installed");
    expect(text).toContain("0.200.0");
    // The load-bearing clause. keryx cannot know, and must not imply otherwise.
    expect(text).toContain("login not verified");
    expect(text).not.toContain("ready");
  });

  test("an out-of-range version is reported as drift-prone, not as broken", () => {
    const text = describeAvailability(
      CODEX,
      resolveAvailability(CODEX, { binaryFound: true, detectOutput: "codex-cli 0.1.0" }),
    );
    expect(text).toContain("below the recorded minimum");
  });

  test("an unrecognised banner is 'version unknown', never an assumed version", () => {
    const text = describeAvailability(
      CODEX,
      resolveAvailability(CODEX, { binaryFound: true, detectOutput: "some other program" }),
    );
    expect(text).toContain("unknown version");
  });
});

describe("the text report", () => {
  const rows: ExternalAgentRow[] = [
    { entry: CODEX, availability: resolveAvailability(CODEX, { binaryFound: true, detectOutput: "codex-cli 0.200.0" }) },
  ];

  test("never draws a tick for an installed-but-unverified agent", () => {
    const text = renderExternalAgents(rows, { available: true }).join("\n");
    expect(text).not.toContain("✓");
    expect(text).toContain("login not verified");
  });

  test("states the capability's refusal reason when it is unavailable", () => {
    const text = renderExternalAgents(rows, { available: false, reason: "disabled by the operator" }).join("\n");
    expect(text).toContain("capability: unavailable");
    expect(text).toContain("disabled by the operator");
  });
});

describe("list", () => {
  test("--no-probe starts no process and reports every entry as not-probed", async () => {
    let probed = 0;
    const d = deps({
      probe: async () => {
        probed += 1;
        return { binaryFound: true };
      },
    });
    await agentsExternalCommand(["list", "--no-probe"], d);
    expect(probed).toBe(0);
    expect(d.lines.join("\n")).toContain("not probed");
  });

  test("probes by default and covers every registered agent", async () => {
    const seen: string[] = [];
    const d = deps({
      probe: async (binary) => {
        seen.push(binary);
        return { binaryFound: true, detectOutput: "codex-cli 0.200.0\n2.5.0" };
      },
    });
    await agentsExternalCommand(["list"], d);
    expect(seen).toEqual(EXTERNAL_AGENTS.map((entry) => entry.binary));
  });

  test("--json carries the runtime's own availability model, not a second one", async () => {
    const d = deps({ probe: probeReturning({ binaryFound: false }) });
    await agentsExternalCommand(["list", "--json"], d);
    const parsed = JSON.parse(d.lines.join("\n")) as ReturnType<typeof buildExternalAgentsJson>;
    expect(parsed.probed).toBe(true);
    expect(parsed.agents).toHaveLength(EXTERNAL_AGENTS.length);
    for (const agent of parsed.agents) {
      expect(agent.availability.state).toBe("binary-missing");
    }
    // Disabled by default: this temp config dir has no `externalAgents` block.
    expect(parsed.capability.available).toBe(false);
    expect(parsed.capability.reason).toBeDefined();
  });

  test("--json under --no-probe reports probed:false and not-probed rows", async () => {
    const d = deps();
    await agentsExternalCommand(["list", "--json", "--no-probe"], d);
    const parsed = JSON.parse(d.lines.join("\n")) as ReturnType<typeof buildExternalAgentsJson>;
    expect(parsed.probed).toBe(false);
    for (const agent of parsed.agents) {
      expect(agent.availability.state).toBe("not-probed");
    }
  });
});

describe("probe", () => {
  test("probes exactly one agent, using its registry detect argv", async () => {
    const seen: Array<{ binary: string; argv: readonly string[] }> = [];
    const d = deps({
      probe: async (binary, argv) => {
        seen.push({ binary, argv });
        return { binaryFound: true, detectOutput: "codex-cli 0.200.0" };
      },
    });
    await agentsExternalCommand(["probe", CODEX.id], d);
    expect(seen).toEqual([{ binary: CODEX.binary, argv: CODEX.detect }]);
    // The whole point: the detect argv is `--version`, which cannot spend quota.
    expect(seen[0]?.argv).toEqual(["--version"]);
  });

  test("an unknown id fails with a non-zero exit code and lists the known ids", async () => {
    const d = deps({ probe: probeReturning({ binaryFound: true }) });
    await agentsExternalCommand(["probe", "not-an-agent"], d);
    expect(process.exitCode).toBe(1);
  });

  test("a missing id fails rather than probing everything", async () => {
    let probed = 0;
    const d = deps({
      probe: async () => {
        probed += 1;
        return { binaryFound: true };
      },
    });
    await agentsExternalCommand(["probe"], d);
    expect(process.exitCode).toBe(1);
    expect(probed).toBe(0);
  });
});

describe("probe accepts a short name (flow 373, AC3)", () => {
  test("`probe claude` probes claude-cli's own binary", async () => {
    const seen: string[] = [];
    await agentsExternalCommand(
      ["probe", "claude"],
      deps({
        probe: async (binary) => {
          seen.push(binary);
          return { binaryFound: true };
        },
      }),
    );
    const claude = EXTERNAL_AGENTS.find((e) => e.id === "claude-cli");
    expect(seen).toEqual([claude?.binary ?? "unreachable"]);
    expect(process.exitCode).toBe(0);
  });
});

describe("enable / disable (flow 373, AC1/AC2)", () => {
  const manifestPath = (): string => path.join(configDir, ".metaproject", "metaproject.json");
  async function writeManifest(enabled: boolean): Promise<string> {
    const text = `${JSON.stringify({ modules: { gdskills: { enabled: true, capabilities: [{ id: "gdskills.external-agents", enabled, kind: "ceiling" }] } } }, null, 2)}\n`;
    await mkdir(path.dirname(manifestPath()), { recursive: true });
    await writeFile(manifestPath(), text, "utf8");
    return text;
  }

  test("enable turns both flags on and says what it changed; disable puts the manifest back byte for byte", async () => {
    const original = await writeManifest(false);
    const on = deps();
    await agentsExternalCommand(["enable"], on);
    expect(process.exitCode).toBe(0);
    expect(on.lines.join("\n")).toContain("externalAgents.enabled set to true");
    expect(on.lines.join("\n")).toContain("gdskills.external-agents set to enabled: true");
    expect(loadExternalAgentsConfig(configDir).enabled).toBe(true);

    const off = deps();
    await agentsExternalCommand(["disable"], off);
    expect(off.lines.join("\n")).toContain("externalAgents.enabled set to false");
    expect(await readFile(manifestPath(), "utf8")).toBe(original);
    expect(loadExternalAgentsConfig(configDir).enabled).toBe(false);
  });

  test("a second enable prints that nothing changed", async () => {
    await agentsExternalCommand(["enable"], deps());
    const again = deps();
    await agentsExternalCommand(["enable"], again);
    expect(again.lines.join("\n")).toContain("nothing changed");
    expect(process.exitCode).toBe(0);
  });

  test("--json carries the structured result", async () => {
    const d = deps();
    await agentsExternalCommand(["enable", "--json"], d);
    const parsed = JSON.parse(d.lines.join("\n")) as { target: boolean; user: string; project: string };
    expect(parsed).toMatchObject({ target: true, user: "changed", project: "no-manifest" });
  });

  test("a manifest that is not valid JSON is refused, exit 1, and left untouched", async () => {
    await mkdir(path.dirname(manifestPath()), { recursive: true });
    await writeFile(manifestPath(), "{nope", "utf8");
    const d = deps();
    await agentsExternalCommand(["enable"], d);
    expect(process.exitCode).toBe(1);
    expect(d.lines.join("\n")).toContain("not valid JSON");
    expect(await readFile(manifestPath(), "utf8")).toBe("{nope");
    expect(loadExternalAgentsConfig(configDir).enabled).toBe(false);
  });

  test("--help on enable changes nothing", async () => {
    await agentsExternalCommand(["enable", "--help"], deps());
    expect(loadExternalAgentsConfig(configDir).enabled).toBe(false);
  });
});

describe("dispatch", () => {
  test("an unknown subcommand fails rather than guessing", async () => {
    const d = deps();
    await agentsExternalCommand(["frobnicate"], d);
    expect(process.exitCode).toBe(1);
  });

  test("--help prints usage and touches nothing", async () => {
    let probed = 0;
    const d = deps({
      probe: async () => {
        probed += 1;
        return { binaryFound: true };
      },
    });
    await agentsExternalCommand(["--help"], d);
    expect(probed).toBe(0);
  });
});
