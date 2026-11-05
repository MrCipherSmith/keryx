import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoutingDecision } from "./decision";
import { appendRoutingJournal } from "./routing-journal";

test("journal records typed routing evidence without retaining the raw request id", async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), "routing-journal-"));
  try {
    const location = { cwd: configDir, configDir };
    const decision: RoutingDecision = {
      schemaVersion: 2, decisionId: "decision", requestId: "private request text",
      configDigest: "config", snapshotDigest: "snapshot", assignmentSource: "user",
      recommendationSource: "none", status: "selected", selection: { providerId: "local", modelId: "test-model" },
      exclusions: [],
    };
    appendRoutingJournal(location, { kind: "dispatch", decision });
    appendRoutingJournal(location, { kind: "attempt", decisionId: decision.decisionId, attempt: 1, outcome: "completed", inputTokens: 5 });
    const root = path.join(configDir, "routing-v2", "journal");
    const [name] = await readdir(root);
    if (name === undefined) throw new Error("Missing routing journal");
    const file = path.join(root, name);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(decision.requestId);
    expect(text.trim().split("\n").map((line) => JSON.parse(line))).toMatchObject([
      { kind: "dispatch", decisionId: "decision", selection: decision.selection },
      { kind: "attempt", decisionId: "decision", outcome: "completed", inputTokens: 5 },
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") {
      await rm(file);
      await symlink(path.join(configDir, "outside.jsonl"), file);
      expect(() => appendRoutingJournal(location, { kind: "dispatch", decision })).toThrow();
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
