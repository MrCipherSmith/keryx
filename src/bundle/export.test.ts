// Flow 313 (W4 portability), T6 — exportBundle: every kind, provenance never
// a raw path, agent origin rewrite, and sha256/sizeBytes correctness.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parseAgentFrontmatter } from "../agents/frontmatter";
import { exportBundle } from "./export";
import { sha256Hex } from "./checksum";

let root: string;
let projectRoot: string;
let metaRoot: string;

const AGENT_MD = `---
name: code-explorer
description: Read-only location search.
role: You locate code.
tools: [read_file]
model_tier: light
policy_profile: read-only
output_contract: subagent-result
---

Find things.
`;

const HOOK_CONFIG = JSON.stringify({ schemaVersion: "1.0.0", hooks: {} }, null, 2);

function learnedPatternJson(status: "candidate" | "accepted" = "candidate"): string {
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    id: "example-pattern",
    trigger: "when doing X across the repo",
    action: "always do Y first",
    domain: "tooling",
    scope: "user",
    project: { identity: "a".repeat(64), identityKind: "path-hash" },
    confidence: 0.6,
    status,
    supersededBy: null,
    evidence: [{ kind: "reinforcement", sourceType: "observation", sourceRef: "obs/1.jsonl", observedAt: "2026-09-24T00:00:00.000Z" }],
    redaction: { scanned: true, findings: [] },
    provenance: { extractor: "repeated-correction" },
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
  if (status === "candidate") {
    record.ttl = { expiresAt: "2026-10-24T00:00:00.000Z" };
  }
  return JSON.stringify(record, null, 2);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-export-"));
  projectRoot = path.join(root, "project");
  metaRoot = path.join(projectRoot, ".metaproject");
  mkdirSync(metaRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAll(): void {
  mkdirSync(path.join(metaRoot, "skills", "my-skill"), { recursive: true });
  writeFileSync(path.join(metaRoot, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: does things\n---\nbody\n");

  mkdirSync(path.join(metaRoot, "rules"), { recursive: true });
  writeFileSync(path.join(metaRoot, "rules", "style.md"), "# style rule\n");

  mkdirSync(path.join(metaRoot, "agents"), { recursive: true });
  writeFileSync(path.join(metaRoot, "agents", "code-explorer.md"), AGENT_MD);

  mkdirSync(path.join(metaRoot, "memory", "lessons"), { recursive: true });
  writeFileSync(path.join(metaRoot, "memory", "lessons", "a.md"), "# lesson\n");

  writeFileSync(path.join(metaRoot, "hooks.json"), HOOK_CONFIG);

  mkdirSync(path.join(metaRoot, "data", "learning", "candidates"), { recursive: true });
  writeFileSync(path.join(metaRoot, "data", "learning", "candidates", "example-pattern.json"), learnedPatternJson());
}

describe("exportBundle", () => {
  test("exports every kind with matching sha256/sizeBytes and no raw path in provenance", async () => {
    writeAll();
    const outDir = path.join(root, "out-bundle");
    const outcome = await exportBundle({
      projectRoot,
      scope: "project",
      out: outDir,
      keryxVersion: "0.2.999-test",
      homeDir: path.join(root, "home"),
      env: {},
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const kinds = new Set(outcome.result.entries.map((e) => e.kind));
    expect(kinds.has("skill")).toBe(true);
    expect(kinds.has("rule")).toBe(true);
    expect(kinds.has("agent")).toBe(true);
    expect(kinds.has("memory-entry")).toBe(true);
    expect(kinds.has("hook-config")).toBe(true);
    expect(kinds.has("learned-pattern")).toBe(true);

    for (const entry of outcome.result.entries) {
      const bytes = readFileSync(path.join(outDir, ...entry.path.split("/")));
      expect(sha256Hex(bytes)).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.sizeBytes);
    }

    const provenanceJson = JSON.stringify(outcome.result.manifest.provenance);
    expect(provenanceJson.includes(root)).toBe(false);
    expect(provenanceJson.includes(projectRoot)).toBe(false);
  });

  test("agent export rewrites origin.kind=imported/sourceRef=bundleId and stays parseable", async () => {
    writeAll();
    const outDir = path.join(root, "out-bundle-agent");
    const outcome = await exportBundle({
      projectRoot,
      scope: "project",
      out: outDir,
      keryxVersion: "0.2.999-test",
      homeDir: path.join(root, "home"),
      env: {},
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const agentBytes = readFileSync(path.join(outDir, "agents", "code-explorer.md"), "utf8");
    const parsed = parseAgentFrontmatter(agentBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.data.origin).toEqual({ kind: "imported", sourceRef: outcome.result.manifest.bundleId });
    expect(parsed.result.body).toBe("\nFind things.\n");
  });

  test("export is deterministic (same manifest bytes given the same clock)", async () => {
    writeAll();
    const fixedNow = () => new Date("2026-09-24T00:00:00.000Z");
    const out1 = path.join(root, "out1");
    const out2 = path.join(root, "out2");
    const o1 = await exportBundle({ projectRoot, scope: "project", out: out1, keryxVersion: "0.2.999", now: fixedNow, homeDir: path.join(root, "home"), env: {} });
    const o2 = await exportBundle({ projectRoot, scope: "project", out: out2, keryxVersion: "0.2.999", now: fixedNow, homeDir: path.join(root, "home"), env: {} });
    expect(o1.ok).toBe(true);
    expect(o2.ok).toBe(true);
    if (!o1.ok || !o2.ok) return;
    expect(JSON.stringify(o1.result.manifest)).toBe(JSON.stringify(o2.result.manifest));
  });
});
