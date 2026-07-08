import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { exportProjectSkill } from "./export";
import { importPluginSkill } from "./export-plugin";

let root: string;

const SKILL_MD = `# Demo Skill

Version: 1.2.3
Status: fresh

A demo project skill used to test the plugin export round-trip.

## Workflow

1. Do the thing.
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-plugin-"));
  const skillDir = path.join(root, ".metaproject", "project-skills", "demo", "my-skill");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), SKILL_MD, "utf8");
  await writeFile(path.join(skillDir, "references", "notes.md"), "reference notes\n", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("skills export --runtime plugin produces a plugin/marketplace package", async () => {
  const result = await exportProjectSkill(root, {
    input: "demo/my-skill",
    runtime: "plugin",
  });
  expect(result.runtime).toBe("plugin");
  expect(result.files.some((f) => f.endsWith(".claude-plugin/plugin.json"))).toBe(true);
  expect(result.files.some((f) => f.endsWith(".claude-plugin/marketplace.json"))).toBe(true);
  expect(result.files.some((f) => f.endsWith("skills/my-skill/SKILL.md"))).toBe(true);
  expect(result.files.some((f) => f.endsWith("references/notes.md"))).toBe(true);
});

test("export -> import round-trips to an equivalent skill (AC7)", async () => {
  const result = await exportProjectSkill(root, {
    input: "demo/my-skill",
    runtime: "plugin",
  });
  const imported = await importPluginSkill(path.join(root, result.outputPath));
  expect(imported).not.toBeNull();
  expect(imported?.module).toBe("demo");
  expect(imported?.name).toBe("my-skill");
  expect(imported?.pluginName).toBe("demo-my-skill");
  // The exported SKILL.md matches the source byte-for-byte.
  expect(imported?.skillMd).toBe(SKILL_MD);
});
