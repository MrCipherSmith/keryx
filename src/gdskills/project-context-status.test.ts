import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProjectContextStatus } from "./project-context-status";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-status-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

async function put(root: string, relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text, "utf8");
}

const RESOLVE = { schema: 1, for: "implement", files: ["a.ts"], entries: [], budget: { limitBytes: 131072, usedBytes: 0, exceeded: false, limitSource: "default" }, warnings: [] };

test("S0: no rules, no config, no record reads as defaults with nothing set", async () => {
  const status = await loadProjectContextStatus(await project());
  expect(status).toEqual({ enforcement: "warn", enforcementSource: "default", maxBytes: 131072, maxBytesSource: "default", ruleCount: 0, linkedCount: 0 });
});

test("S1: copied rules are counted, nested ones too", async () => {
  const root = await project();
  await put(root, ".metaproject/rules/project/a.mdc", "x");
  await put(root, ".metaproject/rules/project/sub/b.md", "x");
  await put(root, ".metaproject/rules/project/notes.txt", "x");
  const status = await loadProjectContextStatus(root);
  expect(status.ruleCount).toBe(2);
  expect(status.linkedCount).toBe(0);
  expect(status.last).toBeUndefined();
});

test("config values and their source are read; the record is returned when valid (S2)", async () => {
  const root = await project();
  await put(root, ".metaproject/tasks.config.json", JSON.stringify({ gdskills: { projectContext: { enforcement: "block", maxBytes: 8192 } } }));
  await put(root, ".metaproject/data/skills/project-context/last.json", JSON.stringify({ recordedAt: "2026-10-17T00:00:00.000Z", result: RESOLVE }));
  const status = await loadProjectContextStatus(root);
  expect([status.enforcement, status.enforcementSource, status.maxBytes, status.maxBytesSource]).toEqual(["block", "config", 8192, "config"]);
  expect(status.last?.result.budget.exceeded).toBe(false);
  expect(status.lastError).toBeUndefined();
});

test("S4: an invalid tasks.config.json is reported and the defaults are used", async () => {
  const root = await project();
  await put(root, ".metaproject/tasks.config.json", "{ nope");
  const status = await loadProjectContextStatus(root);
  expect(status.configError).toContain("not valid JSON");
  expect(status.enforcement).toBe("warn");
});

test("a tasks.config.json that is not an object is reported", async () => {
  const root = await project();
  await put(root, ".metaproject/tasks.config.json", "[]");
  expect((await loadProjectContextStatus(root)).configError).toContain("not a JSON object");
});

test("S5: last.json that is not JSON, has no result, or has an unknown schema is lastError, never a throw", async () => {
  const root = await project();
  const file = ".metaproject/data/skills/project-context/last.json";
  await put(root, file, "{ nope");
  expect((await loadProjectContextStatus(root)).lastError).toContain("not valid JSON");
  await put(root, file, JSON.stringify({ hello: 1 }));
  expect((await loadProjectContextStatus(root)).lastError).toContain("not a recorded resolve");
  await put(root, file, JSON.stringify({ recordedAt: "x", result: { ...RESOLVE, schema: 2 } }));
  const status = await loadProjectContextStatus(root);
  expect(status.lastError).toContain("unknown schema");
  expect(status.last).toBeUndefined();
});

// flow 462 (AC16): the conditional references the TUI shows.
const REFERENCES_FILE = ".metaproject/rules/project/references.json";
const declaration = (extra: Record<string, unknown> = {}) => ({
  path: "STYLING.md",
  when: { globs: ["src/**/*.css"], keywords: ["className"] },
  anchor: "Class conventions",
  description: "Class naming and cascade rules for stylesheets.",
  ...extra,
});

test("no references file leaves the status without a references field", async () => {
  const status = await loadProjectContextStatus(await project());
  expect("references" in status).toBe(false);
});

test("a references file is reported with its declarations and the findings of the check", async () => {
  const root = await project();
  await put(root, REFERENCES_FILE, JSON.stringify({ schema: 1, references: [declaration({ anchor: "Missing heading" })] }));
  await put(root, "STYLING.md", "# Styling\n\n## Class conventions\n\nUse tokens.\n");
  const status = await loadProjectContextStatus(root);
  expect(status.references?.state).toBe("declared");
  if (status.references?.state !== "declared") return;
  expect(status.references.declarations.map((entry) => entry.path)).toEqual(["STYLING.md"]);
  const codes = status.references.findings.map((finding) => finding.code);
  expect(codes).toContain("anchor-not-found");
  expect(codes).toContain("unused-declaration");
});

test("an invalid references file is reported with the validation messages, never thrown", async () => {
  const root = await project();
  await put(root, REFERENCES_FILE, JSON.stringify({ schema: 1, references: [{ path: "STYLING.md", when: {}, description: "x" }] }));
  const status = await loadProjectContextStatus(root);
  expect(status.references?.state).toBe("invalid");
  if (status.references?.state !== "invalid") return;
  expect(status.references.errors.join("\n")).toContain("references[0]");
  await put(root, REFERENCES_FILE, "{ nope");
  const broken = await loadProjectContextStatus(root);
  expect(broken.references?.state).toBe("invalid");
});
