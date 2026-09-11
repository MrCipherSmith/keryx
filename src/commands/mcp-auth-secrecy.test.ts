// AC3 — no surface prints token material. Every surface, not one.
//
// 0.2.91 shipped a `keryx mcp list` that printed a password. The
// lesson taken from that was not "fix list" but "assert it per
// surface", because the defect was never in the renderer that was
// looked at — it was in the one that was not.
//
// So this enumerates `MCP_CONSUMER_SUBCOMMANDS` rather than naming
// surfaces by hand: a tenth subcommand added later is covered on the
// day it is added, without anybody remembering to come back here.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCredential } from "../mcp-servers/credentials";
import { MCP_CONSUMER_SUBCOMMANDS, runMcpConsumerCommand } from "./mcp-servers";

const URL_ = "https://mcp.linear.app/mcp";
const ACCESS = "ACCESS-sk-live-0123456789abcdef";
const REFRESH = "REFRESH-rt-live-fedcba9876543210";
const VERIFIER = "VERIFIER-pkce-aaaaaaaaaaaaaaaaaaa";
const CLIENT_SECRET = "CLIENTSECRET-cs-0000111122223333";

const MATERIAL = [ACCESS, REFRESH, VERIFIER, CLIENT_SECRET];

function fixture(): { configDir: string; projectRoot: string; home: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-secrecy-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  const home = path.join(base, "home");
  for (const dir of [configDir, projectRoot, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(configDir, "mcp-servers.json"),
    JSON.stringify({
      schemaVersion: 1,
      servers: { linear: { url: URL_, oauth: { clientId: "public-id" } } },
    }),
  );
  writeCredential(
    "linear",
    URL_,
    {
      tokens: { access_token: ACCESS, refresh_token: REFRESH, expires_at: Date.now() + 600_000 },
      client: { client_id: "public-id", client_secret: CLIENT_SECRET },
      code_verifier: VERIFIER,
    },
    configDir,
  );
  return { configDir, projectRoot, home };
}

async function surface(
  sub: (typeof MCP_CONSUMER_SUBCOMMANDS)[number],
  args: string[],
): Promise<string> {
  const { configDir, projectRoot, home } = fixture();
  const lines: string[] = [];
  await runMcpConsumerCommand(sub, args, {
    cwd: projectRoot,
    configDir,
    projectRoot,
    home,
    interactive: false,
    openBrowser: () => {},
    // Both streams. A secret on stderr is as leaked as one on stdout,
    // and it is the stream error paths write to.
    log: (line) => lines.push(line),
    err: (line) => lines.push(line),
    connect: async () => ({ listTools: async () => [{ name: "issue" }], close: async () => {} }) as never,
  });
  return lines.join("\n");
}

describe("AC3 — token material reaches no surface", () => {
  // Every subcommand, with arguments that make it do its most
  // verbose thing against the server that has the credential.
  const INVOCATIONS: Array<[(typeof MCP_CONSUMER_SUBCOMMANDS)[number], string[]]> = [
    ["list", []],
    ["list", ["--json"]],
    ["doctor", []],
    ["doctor", ["--json"]],
    ["doctor", ["linear"]],
    ["auth", ["linear"]],
    ["trust", ["linear"]],
    ["untrust", ["linear"]],
    ["enable", ["linear"]],
    ["disable", ["linear"]],
    ["remove", ["linear"]],
    ["add", ["linear", "--url", URL_]],
    ["logout", ["linear"]],
  ];

  for (const [sub, args] of INVOCATIONS) {
    const label = `${sub}${args.length === 0 ? "" : ` ${args.join(" ")}`}`;
    test(`\`keryx mcp ${label}\` prints none of it`, async () => {
      const output = await surface(sub, args);
      for (const secret of MATERIAL) expect(output).not.toContain(secret);
    });
  }

  test("every subcommand is covered — a new one cannot be forgotten", () => {
    // The guard that makes the list above a property rather than a
    // snapshot of what somebody thought of in September.
    const covered = new Set(INVOCATIONS.map(([sub]) => sub));
    expect([...MCP_CONSUMER_SUBCOMMANDS].filter((sub) => !covered.has(sub))).toEqual([]);
  });

  test("BOUNDARY — every surface actually produced output", async () => {
    // The previous version of this test ended with
    //   expect(`${lines.join("\n")}\n${ACCESS}`).toContain(ACCESS)
    // which interpolates the expectation into its own subject: true
    // for every possible value of `lines`, and therefore proof of
    // nothing. It was the only backstop against a `surface()` call
    // that renders nothing at all, so `not.toContain` was passing
    // vacuously for any silent subcommand.
    //
    // The real guard is per-invocation: each surface must have
    // rendered something before its secrecy assertion means anything.
    for (const [sub, args] of INVOCATIONS) {
      const output = await surface(sub, args);
      expect({ sub, empty: output.trim().length === 0 }).toEqual({ sub, empty: false });
    }
  });

  test("nor does the JSON report carry it in a field nobody renders", async () => {
    // `--json` is the surface where a secret hides best: it is not
    // read by a person, it is piped, and a token in an unrendered
    // field lands in whatever consumed the pipe.
    const output = await surface("doctor", ["--json"]);
    const parsed: unknown = JSON.parse(output);
    for (const secret of MATERIAL) expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});
