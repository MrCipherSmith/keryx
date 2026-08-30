// Flow 207, AC10 + AC11 at the CLI boundary.
//
// `provider-config.cross-family.test.ts` proves the decision. This proves the
// COMMAND, because AC11 is a claim about an exit code and a function cannot make
// one. It spawns the real CLI so the assertion covers routing, argument parsing
// and `process.exitCode` — the three places a correct decision can still surface
// as a failing gate.
//
// A temp `XDG_DATA_HOME` and `HOME` are the seam `keryxConfigDir` documents, and
// the API-key variables are cleared explicitly: a developer with
// `DEEPSEEK_API_KEY` exported would otherwise have a second family configured
// and would see a different answer from CI.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_ROUTES } from "../cli";
import { COMMAND_DESCRIPTORS } from "../standard/command-registry";
import { crossFamilyReviewForSession, providersCommand } from "./providers";

const CLI = path.join(import.meta.dir, "..", "cli.ts");

/** Env with every provider credential removed, pointing at an empty config dir. */
function isolatedEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/_API_KEY$/.test(key)) continue;
    env[key] = value;
  }
  env.HOME = dir;
  env.XDG_DATA_HOME = dir;
  delete env.APPDATA;
  return env;
}

async function runCli(args: string[], dir: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: isolatedEnv(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

describe("keryx providers is wired", () => {
  test("the verb dispatches and is described rather than excluded", () => {
    expect(CLI_ROUTES.providers).toBe(providersCommand);
    const described = COMMAND_DESCRIPTORS.filter((d) => d.command.startsWith("providers "));
    expect(described.map((d) => d.command).sort()).toEqual([
      "providers cross-family",
      "providers list",
    ]);
    // Read-only and token-free, which is what makes the descriptors honest.
    for (const descriptor of described) {
      expect(descriptor.read).toBe(true);
      expect(descriptor.model).not.toBe(true);
      expect(descriptor.sideEffects ?? []).toEqual([]);
    }
  });
});

describe("the seam the review pipeline calls", () => {
  test("crossFamilyReviewForSession takes opt-in plus a session and returns the record", () => {
    // The exact signature `src/commands/review.ts` calls. Asserted so a change
    // to it is a red test here rather than a silent break on the other side of
    // the boundary.
    const decision = crossFamilyReviewForSession(false, {
      providerId: "anthropic",
      modelId: "claude-opus-5",
    });
    expect(decision.schemaVersion).toBe(1);
    expect(decision.mode).toBe("single-family");
    expect(decision.requested).toBe(false);
    expect(decision.author_family).toBe("anthropic");
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  test("it falls back to the persisted shell selection when the session is omitted", () => {
    // Same fallback `keryx review tier` uses, so the two seams read one session.
    const decision = crossFamilyReviewForSession(false);
    expect(decision.schemaVersion).toBe(1);
    expect(typeof decision.reason).toBe("string");
  });
});

describe("AC11: one configured vendor degrades to single-family and exits 0", () => {
  test("with nothing configured the command reports single-family and exits 0", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-cross-family-cli-"));
    const result = await runCli(["providers", "cross-family", "--opt-in"], dir);

    expect(result.code).toBe(0);
    expect(result.out).toContain("mode: single-family");
    expect(result.out).toContain("reason: ");
    // The reason names WHY, not just that it happened.
    expect(result.out).toMatch(/no provider is configured beyond|carry no vendor marker|resolves to a family other than/);
  });

  test("--json emits the record the round should carry, still exit 0", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-cross-family-cli-"));
    const result = await runCli(["providers", "cross-family", "--json"], dir);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as { cross_family_review: Record<string, unknown> };
    expect(parsed.cross_family_review).toMatchObject({
      schemaVersion: 1,
      mode: "single-family",
      requested: false,
    });
    expect(typeof parsed.cross_family_review.reason).toBe("string");
  });
});

describe("AC10: the CLI never opts anybody in by default", () => {
  test("a configured second family is still single-family without --opt-in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-cross-family-cli-"));
    // `keryxConfigDir` resolves to `<XDG_DATA_HOME>/keryx`, so the operator's
    // custom-provider file has to sit there for the CLI to read it.
    mkdirSync(path.join(dir, "keryx"), { recursive: true });
    writeFileSync(
      path.join(dir, "keryx", "llm-providers.json"),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "internal-gpt": { name: "internal-gpt", baseUrl: "http://10.0.0.5:8080", models: ["gpt-oss-120b"] },
        },
      }),
    );

    const without = await runCli(
      ["providers", "cross-family", "--session-provider", "anthropic", "--session-model", "claude-opus-5"],
      dir,
    );
    expect(without.code).toBe(0);
    expect(without.out).toContain("mode: single-family");
    expect(without.out).toContain("was not requested");
    // The declined option is still recorded — "we chose not to" and "there was
    // nothing to choose" must not read the same.
    expect(without.out).toContain("openai via internal-gpt");

    const withOptIn = await runCli(
      [
        "providers",
        "cross-family",
        "--opt-in",
        "--session-provider",
        "anthropic",
        "--session-model",
        "claude-opus-5",
      ],
      dir,
    );
    expect(withOptIn.code).toBe(0);
    expect(withOptIn.out).toContain("mode: cross-family");
    expect(withOptIn.out).toContain("reviewer_family: openai");
    expect(withOptIn.out).toContain("reviewer_provider: internal-gpt");
  });
});
