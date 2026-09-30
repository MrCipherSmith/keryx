import { describe, expect, test } from "bun:test";
import {
  defaultEntrypointTargets,
  localTargetPaths,
  normalizeEntrypointTargets,
  ruleImportSources,
  sharedEntrypointTargets,
} from "./entrypoint-targets";

const CLAUDE_LOCAL = { runtime: "claude", path: "CLAUDE.local.md", scope: "local" } as const;
const CODEX_LOCAL = {
  runtime: "codex",
  path: "AGENTS.override.md",
  scope: "local",
  mode: "override",
  source: "AGENTS.md",
} as const;
const SETTINGS_LOCAL = { path: ".claude/settings.local.json", scope: "local" } as const;

describe("defaultEntrypointTargets", () => {
  test("a fresh init is local for both runtimes and the settings file", () => {
    expect(defaultEntrypointTargets()).toEqual({
      root: [CLAUDE_LOCAL, CODEX_LOCAL],
      claudeSettings: SETTINGS_LOCAL,
    });
  });

  test("the shared counterparts are the team files", () => {
    expect(sharedEntrypointTargets()).toEqual({
      root: [
        { runtime: "claude", path: "CLAUDE.md", scope: "shared" },
        { runtime: "codex", path: "AGENTS.md", scope: "shared" },
      ],
      claudeSettings: { path: ".claude/settings.json", scope: "shared" },
    });
  });

  test("each call returns a fresh object", () => {
    const first = defaultEntrypointTargets();
    first.root.pop();
    expect(defaultEntrypointTargets().root).toHaveLength(2);
  });
});

describe("normalizeEntrypointTargets", () => {
  test("the entry form round-trips and needs no rewrite", () => {
    const raw = { index: ".metaproject/index.md", root: [CLAUDE_LOCAL, CODEX_LOCAL], claudeSettings: SETTINGS_LOCAL };
    const result = normalizeEntrypointTargets(raw);
    expect(result.targets).toEqual({ root: [CLAUDE_LOCAL, CODEX_LOCAL], claudeSettings: SETTINGS_LOCAL });
    expect(result.needsRewrite).toBe(false);
    expect(result.legacy).toEqual([]);
    expect(result.ignored).toEqual([]);
  });

  test("a shared entry form round-trips too", () => {
    const raw = sharedEntrypointTargets();
    const result = normalizeEntrypointTargets(raw);
    expect(result.targets).toEqual(raw);
    expect(result.needsRewrite).toBe(false);
    expect(result.legacy).toEqual([]);
  });

  test("the legacy string array becomes provisional shared entries that await a migration decision", () => {
    const result = normalizeEntrypointTargets({ root: ["AGENTS.md", "CLAUDE.md"] });
    expect(result.targets).toEqual({
      root: [
        { runtime: "codex", path: "AGENTS.md", scope: "shared" },
        { runtime: "claude", path: "CLAUDE.md", scope: "shared" },
      ],
      claudeSettings: { path: ".claude/settings.json", scope: "shared" },
    });
    expect(result.needsRewrite).toBe(true);
    expect(result.legacy).toEqual([
      { kind: "root", runtime: "codex", path: "AGENTS.md" },
      { kind: "root", runtime: "claude", path: "CLAUDE.md" },
      { kind: "claudeSettings", path: ".claude/settings.json" },
    ]);
  });

  test("a legacy array naming one runtime leaves the other as a legacy candidate at its team file", () => {
    const result = normalizeEntrypointTargets({ root: ["AGENTS.md"] });
    expect(result.targets.root).toEqual([
      { runtime: "codex", path: "AGENTS.md", scope: "shared" },
      { runtime: "claude", path: "CLAUDE.md", scope: "shared" },
    ]);
    expect(result.legacy.map((entry) => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md", ".claude/settings.json"]);
    expect(result.needsRewrite).toBe(true);
  });

  test("a legacy lowercase file name keeps its own path", () => {
    const result = normalizeEntrypointTargets({ root: ["agents.md", "claude.md"] });
    expect(result.targets.root).toEqual([
      { runtime: "codex", path: "agents.md", scope: "shared" },
      { runtime: "claude", path: "claude.md", scope: "shared" },
    ]);
  });

  test("an empty legacy array and a missing root both yield legacy candidates for every target", () => {
    for (const raw of [{ root: [] }, {}, undefined, null]) {
      const result = normalizeEntrypointTargets(raw);
      expect(result.targets).toEqual(sharedEntrypointTargets());
      expect(result.legacy).toHaveLength(3);
      expect(result.needsRewrite).toBe(true);
    }
  });

  test("a mix keeps the entry and treats the string as legacy", () => {
    const result = normalizeEntrypointTargets({ root: [CLAUDE_LOCAL, "AGENTS.md"], claudeSettings: SETTINGS_LOCAL });
    expect(result.targets).toEqual({
      root: [CLAUDE_LOCAL, { runtime: "codex", path: "AGENTS.md", scope: "shared" }],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(result.legacy).toEqual([{ kind: "root", runtime: "codex", path: "AGENTS.md" }]);
    expect(result.needsRewrite).toBe(true);
  });

  test("a Codex local entry with missing mode and source is completed", () => {
    const result = normalizeEntrypointTargets({
      root: [CLAUDE_LOCAL, { runtime: "codex", path: "AGENTS.override.md", scope: "local" }],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(result.targets.root[1]).toEqual(CODEX_LOCAL);
    expect(result.needsRewrite).toBe(true);
    expect(result.legacy).toEqual([]);
  });

  test("Codex mode skip is preserved and an unknown mode falls back to override", () => {
    const skip = normalizeEntrypointTargets({
      root: [CLAUDE_LOCAL, { ...CODEX_LOCAL, mode: "skip" }],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(skip.targets.root[1]).toEqual({ ...CODEX_LOCAL, mode: "skip" });
    expect(skip.needsRewrite).toBe(false);

    const unknown = normalizeEntrypointTargets({
      root: [CLAUDE_LOCAL, { ...CODEX_LOCAL, mode: "sideways" }],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(unknown.targets.root[1]).toEqual(CODEX_LOCAL);
    expect(unknown.needsRewrite).toBe(true);
  });

  test("an entry with a missing scope or path is completed from the field that is present", () => {
    const result = normalizeEntrypointTargets({
      root: [
        { runtime: "claude", path: "CLAUDE.md" },
        { runtime: "codex", scope: "local" },
      ],
      claudeSettings: { scope: "shared" },
    });
    expect(result.targets).toEqual({
      root: [{ runtime: "claude", path: "CLAUDE.md", scope: "shared" }, CODEX_LOCAL],
      claudeSettings: { path: ".claude/settings.json", scope: "shared" },
    });
    expect(result.needsRewrite).toBe(true);
    expect(result.legacy).toEqual([]);
  });

  test("a shared Codex entry drops mode and source", () => {
    const result = normalizeEntrypointTargets({
      root: [CLAUDE_LOCAL, { runtime: "codex", path: "AGENTS.md", scope: "shared", mode: "override", source: "AGENTS.md" }],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(result.targets.root[1]).toEqual({ runtime: "codex", path: "AGENTS.md", scope: "shared" });
    expect(result.needsRewrite).toBe(true);
  });

  test("junk is ignored, reported, and never becomes a write target", () => {
    const junk = [42, null, "README.md", { runtime: "emacs", path: "x.md", scope: "local" }, ["CLAUDE.md"], { path: "CLAUDE.md" }];
    const result = normalizeEntrypointTargets({ root: junk, claudeSettings: "nope" });
    expect(result.targets).toEqual(sharedEntrypointTargets());
    expect(result.ignored).toEqual(junk);
    expect(result.needsRewrite).toBe(true);
    expect(result.legacy).toHaveLength(3);
  });

  test("a path that leaves the project root is junk", () => {
    const result = normalizeEntrypointTargets({
      root: [
        { runtime: "claude", path: "../CLAUDE.local.md", scope: "local" },
        { runtime: "codex", path: "/etc/AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" },
      ],
      claudeSettings: { path: "../../settings.json", scope: "local" },
    });
    expect(result.targets).toEqual(sharedEntrypointTargets());
    expect(result.ignored).toHaveLength(2);
  });

  test("a Codex source that leaves the project root falls back to AGENTS.md", () => {
    const result = normalizeEntrypointTargets({
      root: [CLAUDE_LOCAL, { ...CODEX_LOCAL, source: "../secrets.md" }],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(result.targets.root[1]).toEqual(CODEX_LOCAL);
    expect(result.needsRewrite).toBe(true);
  });

  // Flow 361 review round 1, F-001: local paths end up in `info/exclude` and
  // as write destinations. A cloned manifest must not be able to plant `!.env`
  // (un-ignoring a secret) or a newline-injected `# keryx:end` there.
  test("a local entry always resolves to its runtime's standard local path, whatever path the manifest states", () => {
    // `.env` as a local target would have keryx write its block into the secrets file.
    const result = normalizeEntrypointTargets({
      root: [
        { runtime: "claude", scope: "local", path: ".env" },
        { runtime: "codex", scope: "local", path: "docs/AGENTS.override.md", mode: "override", source: "AGENTS.md" },
      ],
      claudeSettings: { scope: "local", path: ".claude/other.json" },
    });
    expect(result.targets).toEqual({ root: [CLAUDE_LOCAL, CODEX_LOCAL], claudeSettings: SETTINGS_LOCAL });
    expect(localTargetPaths(result.targets)).toEqual(["CLAUDE.local.md", "AGENTS.override.md", ".claude/settings.local.json"]);

    const inferred = normalizeEntrypointTargets({ root: ["claude.local.md", { runtime: "codex", path: "agents.override.md" }] });
    expect(inferred.targets.root).toEqual([CLAUDE_LOCAL, CODEX_LOCAL]);

    // One that would un-ignore a file or inject lines is junk, like a path leaving the project.
    const hostile = normalizeEntrypointTargets({
      root: [
        { runtime: "claude", scope: "local", path: "!.env" },
        { runtime: "codex", scope: "local", path: "AGENTS.override.md\n!*.pem\n# keryx:end", mode: "override", source: "AGENTS.md" },
      ],
      claudeSettings: { scope: "local", path: "!secrets.json" },
    });
    expect(hostile.ignored).toHaveLength(2);
    expect(hostile.targets).toEqual(sharedEntrypointTargets());
    expect(localTargetPaths(hostile.targets)).toEqual([]);
  });

  test("a path or Codex source with a control character, or starting with ! or #, is refused", () => {
    const result = normalizeEntrypointTargets({
      root: [
        { runtime: "claude", scope: "shared", path: "CLAUDE.md\n!.env" },
        { runtime: "codex", scope: "local", mode: "override", source: "!AGENTS.md" },
      ],
      claudeSettings: SETTINGS_LOCAL,
    });
    expect(result.ignored).toEqual([{ runtime: "claude", scope: "shared", path: "CLAUDE.md\n!.env" }]);
    expect(result.targets.root).toEqual([CODEX_LOCAL, { runtime: "claude", path: "CLAUDE.md", scope: "shared" }]);
    for (const source of ["#notes.md", "AGENTS.md\r", "AGENTS.md\n# keryx:end", "docs/\tAGENTS.md"]) {
      const codex = normalizeEntrypointTargets({ root: [{ ...CODEX_LOCAL, source }] }).targets.root[0];
      expect(codex).toEqual(CODEX_LOCAL);
    }
  });

  test("the first entry per runtime wins; a duplicate is ignored", () => {
    const duplicate = { runtime: "claude", path: "CLAUDE.md", scope: "shared" };
    const result = normalizeEntrypointTargets({ root: [CLAUDE_LOCAL, duplicate, CODEX_LOCAL], claudeSettings: SETTINGS_LOCAL });
    expect(result.targets.root).toEqual([CLAUDE_LOCAL, CODEX_LOCAL]);
    expect(result.ignored).toEqual([duplicate]);
    expect(result.needsRewrite).toBe(true);
  });

  test("normalizing its own output is a fixed point", () => {
    const once = normalizeEntrypointTargets({ root: [CLAUDE_LOCAL, { runtime: "codex", scope: "local" }] });
    const twice = normalizeEntrypointTargets(once.targets);
    expect(twice.targets).toEqual(once.targets);
    expect(twice.needsRewrite).toBe(false);
  });
});

describe("ruleImportSources", () => {
  test("local targets import the team files, never the local ones", () => {
    expect(ruleImportSources(defaultEntrypointTargets())).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  test("shared targets import the same team files", () => {
    expect(ruleImportSources(sharedEntrypointTargets())).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });

  test("a shared entry at a non-default path is imported ahead of the defaults", () => {
    const targets = normalizeEntrypointTargets({ root: ["agents.md"] }).targets;
    expect(ruleImportSources(targets)).toEqual(["agents.md", "CLAUDE.md", "AGENTS.md"]);
  });

  test("a custom Codex override source is a team file", () => {
    const targets = defaultEntrypointTargets();
    targets.root[1] = { ...CODEX_LOCAL, source: "docs/AGENTS.md" };
    expect(ruleImportSources(targets)).toEqual(["docs/AGENTS.md", "AGENTS.md", "CLAUDE.md"]);
  });
});

describe("localTargetPaths", () => {
  test("lists every local write target", () => {
    expect(localTargetPaths(defaultEntrypointTargets())).toEqual([
      "CLAUDE.local.md",
      "AGENTS.override.md",
      ".claude/settings.local.json",
    ]);
  });

  test("shared targets have no local paths", () => {
    expect(localTargetPaths(sharedEntrypointTargets())).toEqual([]);
  });
});
