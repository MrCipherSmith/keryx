// Flow 308 (W8, Lane B, T6): `keryx security impact-evidence` CLI.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleImpactEvidence } from "./security-impact-evidence";

async function snapshotTree(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        results.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  return results.sort();
}

function stdinFrom(text: string): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, "utf8");
    },
  };
}

function claudePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "cli-test-session",
    tool_name: "Edit",
    tool_input: {},
    ...overrides,
  });
}

describe("keryx security impact-evidence", () => {
  let root = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-cli-"));
    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
      "utf8",
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("`test <file>` is a dry run: it writes nothing under .metaproject/data/security/impact-evidence", async () => {
    const before = await snapshotTree(path.join(root, ".metaproject"));

    await handleImpactEvidence(root, ["test", "src/a.ts"]);
    expect(loggedOut.join("\n")).toContain("src/a.ts");

    const after = await snapshotTree(path.join(root, ".metaproject"));
    expect(after).toEqual(before);
  });

  test("`test <file> --json` prints a schemaVersion'd evidence payload", async () => {
    await handleImpactEvidence(root, ["test", "src/a.ts", "--json"]);
    const payload = JSON.parse(loggedOut.join("\n")) as { files: string[]; evidences: Array<{ file: string }> };
    expect(payload.files).toEqual(["src/a.ts"]);
    expect(payload.evidences[0]?.file).toBe("src/a.ts");
  });

  test("`status --json` reports config, host delivery and env kill switch", async () => {
    await handleImpactEvidence(root, ["status", "--json"]);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      config: { enabled: boolean };
      hostDelivery: Array<{ adapterId: string; status: string }>;
      envKillSwitch: boolean;
    };
    expect(payload.config.enabled).toBe(true);
    expect(payload.envKillSwitch).toBe(false);
    expect(payload.hostDelivery.length).toBeGreaterThan(0);
    // No `pre-tool-context` surface is registered for any adapter yet.
    expect(payload.hostDelivery.every((entry) => entry.status === "not-registered")).toBe(true);
  });

  test("`hook --runtime other` refuses without blocking (exit 0, no throw)", async () => {
    await handleImpactEvidence(root, ["hook", "--runtime", "some-other-runtime"]);
    expect(process.exitCode).toBe(0);
  });

  test("F1: an allow outcome omits permissionDecision entirely — it must never auto-approve the tool call", async () => {
    // No file, no command in the payload -> the provider's "not-applicable"
    // allow path (nothing to gate).
    await handleImpactEvidence(root, ["hook"], { stdin: stdinFrom(claudePayload({ tool_input: {} })) });

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(loggedOut.join("\n")) as { hookSpecificOutput: Record<string, unknown> };
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecisionReason");
  });

  test("F1: an ask/deny outcome DOES carry permissionDecision + reason", async () => {
    // A destructive command with no rollback line -> outcome "ask".
    await handleImpactEvidence(root, ["hook"], {
      stdin: stdinFrom(claudePayload({ tool_name: "Bash", tool_input: { command: "rm -rf /" } })),
    });

    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("rollback-line-required");
  });

  test("F13: malformed stdin JSON under the default (supervised, non-strict) profile refuses without blocking — no decision on stdout", async () => {
    await handleImpactEvidence(root, ["hook"], { stdin: stdinFrom("{ not valid json") });

    expect(process.exitCode).toBe(0);
    expect(loggedOut.length).toBe(0); // no decision printed at all
    expect(loggedErr.some((line) => line.includes("not valid JSON") || line.includes("was not valid JSON"))).toBe(true);
  });

  test("F13: malformed stdin JSON under unattended-untrusted fails CLOSED (deny, hook-failed)", async () => {
    await handleImpactEvidence(root, ["hook", "--profile", "unattended-untrusted"], {
      stdin: stdinFrom("{ not valid json"),
    });

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("hook-failed");
  });

  test("F13: malformed stdin JSON under strict (impactEvidence.strict:true) fails CLOSED regardless of profile", async () => {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const { mergeSecurityConfig, computeConfigChecksum } = await import("../security/config");
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: true, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify(sealed, null, 2), "utf8");

    await handleImpactEvidence(root, ["hook", "--profile", "read-only-review"], {
      stdin: stdinFrom("{ not valid json"),
    });

    const output = JSON.parse(loggedOut.join("\n")) as { hookSpecificOutput: { permissionDecision?: string } };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("F18: warnings from the decision are surfaced via systemMessage and stderr, not dropped", async () => {
    const outsideAbsolute = path.join(tmpdir(), "not-under-root", "secret.ts");
    await handleImpactEvidence(root, ["hook"], {
      stdin: stdinFrom(claudePayload({ tool_input: { file_path: outsideAbsolute } })),
    });

    const output = JSON.parse(loggedOut.join("\n")) as { systemMessage?: string };
    expect(output.systemMessage).toBeDefined();
    expect(output.systemMessage).toContain("outside the project root");
    expect(loggedErr.some((line) => line.includes("outside the project root"))).toBe(true);
  });
});
