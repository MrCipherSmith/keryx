// Flow 308 (W8, Lane B, T6): `keryx security impact-evidence` CLI.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleImpactEvidence } from "./security-impact-evidence";
import { readLogRecords } from "../security/service";

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
    // Flow 306 (W6, T20): keryx-shell now registers a `pre-tool-context`
    // surface (its own compiled-in hook runtime, `verified` confidence) —
    // every OTHER adapter still has none registered.
    const byAdapter = new Map(payload.hostDelivery.map((entry) => [entry.adapterId, entry.status]));
    expect(byAdapter.get("keryx-shell")).toBe("verified");
    for (const entry of payload.hostDelivery) {
      if (entry.adapterId === "keryx-shell") continue;
      expect(entry.status).toBe("not-registered");
    }
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

  test("F13/NEW-2: malformed stdin JSON under the default (supervised, non-strict) profile refuses without blocking — no permissionDecision, but a systemMessage warning", async () => {
    await handleImpactEvidence(root, ["hook"], { stdin: stdinFrom("{ not valid json") });

    expect(process.exitCode).toBe(0);
    expect(loggedErr.some((line) => line.includes("not valid JSON") || line.includes("was not valid JSON"))).toBe(true);

    // NEW-2: still a true refuse-without-blocking (no permissionDecision key
    // at all), but no longer silent — the warning is surfaced as
    // systemMessage, same as an ordinary decision's warnings (F18).
    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: Record<string, unknown>;
      systemMessage?: string;
    };
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(output.systemMessage).toContain("not valid JSON");

    // Follow-up (review round 3, part 2): the failure now also leaves a
    // durable `service-failed` record under the ANCHORED root (not wherever
    // a payload cwd might have pointed), via `appendLogRecord` reached
    // through the `security/service.ts` facade.
    const records = await readLogRecords(root);
    const record = records.find((r) => r.event === "service-failed");
    expect(record).toBeDefined();
    expect(record?.detail).toContain("not valid JSON");
  });

  test("NEW-2: a hook-level failure under unattended-untrusted (non-strict config) fails closed with reason hook-advisory-failed, not hook-crashed", async () => {
    await handleImpactEvidence(root, ["hook", "--profile", "unattended-untrusted"], {
      stdin: stdinFrom("{ not valid json"),
    });

    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
      systemMessage?: string;
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("hook-advisory-failed");
    expect(output.systemMessage).toContain("not valid JSON");

    const records = await readLogRecords(root);
    const record = records.find((r) => r.event === "service-failed");
    expect(record).toBeDefined();
    expect(record?.detail).toContain("profile=unattended-untrusted");
    expect(record?.detail).toContain("strict=false");
  });

  test("NEW-2: a hook-level failure under strict (impactEvidence.strict:true) still fails closed with reason hook-crashed", async () => {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const { mergeSecurityConfig, computeConfigChecksum } = await import("../security/config");
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: true, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify(sealed, null, 2), "utf8");

    await handleImpactEvidence(root, ["hook", "--profile", "read-only-review"], {
      stdin: stdinFrom("{ not valid json"),
    });

    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("hook-crashed");
  });

  test("NEW-1: a hook payload cwd pointing at a sibling directory with its own .metaproject does not move the gate's root — state/log still land under the anchored root, and strict still asks", async () => {
    // Anchor: this process's own cwd is `root` (has `.metaproject`). The
    // payload claims the tool call ran from a SIBLING directory that has its
    // OWN `.metaproject` — a foreign ancestor an agent-steered `cwd` could
    // point resolveProjectRoot(payload.cwd) at, if the root were still
    // anchored on the payload.
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-sibling`);
    await mkdir(path.join(sibling, ".metaproject"), { recursive: true });

    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const { mergeSecurityConfig, computeConfigChecksum } = await import("../security/config");
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: true, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify(sealed, null, 2), "utf8");

    try {
      await handleImpactEvidence(root, ["hook"], {
        stdin: stdinFrom(
          claudePayload({ cwd: sibling, tool_input: { file_path: path.join(root, "src", "a.ts") } }),
        ),
      });

      expect(process.exitCode).toBe(0);
      const output = JSON.parse(loggedOut.join("\n")) as {
        hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      // Strict mode's acknowledgement gate still fires — it was not lost by
      // the root silently moving to the sibling project.
      expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(output.hookSpecificOutput.permissionDecisionReason).toBe("acknowledgement-required");

      const { pathExists } = await import("../lib/fs");
      const realLog = path.join(root, ".metaproject", "data", "security", "impact-evidence", "log.jsonl");
      const siblingLog = path.join(sibling, ".metaproject", "data", "security", "impact-evidence", "log.jsonl");
      expect(await pathExists(realLog)).toBe(true);
      expect(await pathExists(siblingLog)).toBe(false);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  test("Follow-up (review round 3, part 2): a hook-level failure's service-failed record lands under the anchored root, even with a pivoted payload cwd", async () => {
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-sibling-failure`);
    await mkdir(path.join(sibling, ".metaproject"), { recursive: true });

    try {
      // Malformed JSON, so the payload's `cwd` is never even parsed out —
      // the CLI's OWN cwd (`root`, passed as the first arg) is what anchors
      // the root here. This exercises the same anchoring as NEW-1, but for
      // the emitHookFailure log-write path specifically.
      await handleImpactEvidence(root, ["hook"], { stdin: stdinFrom("{ not valid json") });

      const realLog = path.join(root, ".metaproject", "data", "security", "impact-evidence", "log.jsonl");
      const siblingLog = path.join(sibling, ".metaproject", "data", "security", "impact-evidence", "log.jsonl");
      const { pathExists } = await import("../lib/fs");
      expect(await pathExists(realLog)).toBe(true);
      expect(await pathExists(siblingLog)).toBe(false);

      const records = await readLogRecords(root);
      expect(records.some((r) => r.event === "service-failed")).toBe(true);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
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

  test("F14 (round 2): the hook payload's own cwd (not this process's cwd) decides the project root — state lands under the real root, not a subdirectory", async () => {
    await mkdir(path.join(root, "src", "sub"), { recursive: true });

    // Invoked with process cwd == root, but the Claude payload reports the
    // tool call ran from a SUBDIRECTORY (`root/src/sub`) — the common case
    // for a host that forwards its own cwd, not the project root.
    await handleImpactEvidence(root, ["hook"], {
      stdin: stdinFrom(claudePayload({ cwd: path.join(root, "src", "sub"), tool_input: { file_path: "src/a.ts" } })),
    });

    expect(process.exitCode).toBe(0);
    const logPath = path.join(root, ".metaproject", "data", "security", "impact-evidence", "log.jsonl");
    const stray = path.join(root, "src", "sub", ".metaproject");
    const { pathExists } = await import("../lib/fs");
    expect(await pathExists(logPath)).toBe(true);
    expect(await pathExists(stray)).toBe(false);
  });

  test("F14 (round 2): a request whose only file resolves outside root denies under unattended-untrusted, rather than silently proceeding", async () => {
    const outsideAbsolute = path.join(tmpdir(), "not-under-root-deny", "secret.ts");
    await handleImpactEvidence(root, ["hook", "--profile", "unattended-untrusted"], {
      stdin: stdinFrom(claudePayload({ tool_input: { file_path: outsideAbsolute } })),
    });

    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("path-outside-root");
  });

  test("F11 (round 2): a hand-written security.config.json with impactEvidence.enabled:false and NO configChecksum does not disable the gate via the hook CLI", async () => {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ impactEvidence: { enabled: false } }, null, 2),
      "utf8",
    );

    await handleImpactEvidence(root, ["hook", "--profile", "unattended-untrusted"], {
      stdin: stdinFrom(claudePayload({ tool_input: { file_path: "src/a.ts" } })),
    });

    const output = JSON.parse(loggedOut.join("\n")) as {
      hookSpecificOutput: { additionalContext?: string };
      systemMessage?: string;
    };
    // Disabled would mean an "allow" with no evidence and no warning; the
    // gate must still run (additionalContext present) and the untrusted
    // config surfaced.
    expect(output.hookSpecificOutput.additionalContext).toBeDefined();
    expect(output.systemMessage).toContain("configChecksum");
  });

  test("`test` command rejects an out-of-root path instead of reading it", async () => {
    const outsideAbsolute = path.join(tmpdir(), "impact-evidence-test-outside", "secret.ts");
    await handleImpactEvidence(root, ["test", outsideAbsolute]);
    expect(process.exitCode).toBe(1);
    expect(loggedErr.some((line) => line.includes("outside the project root"))).toBe(true);
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
