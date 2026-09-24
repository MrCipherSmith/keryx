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

describe("keryx security impact-evidence", () => {
  let root = "";
  let loggedOut: string[] = [];
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
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = () => {};
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
});
