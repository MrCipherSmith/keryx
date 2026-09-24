// F9 (flow 309 review round 1): `keryx skills eval` argument validation.
// `--trials abc` used to parse as `NaN` and flow straight through; `--trials=N`
// (the `=` spelling) was silently ignored by a hand-rolled `args.indexOf`
// parser and fell back to the default; an unknown `--strictness` value fell
// back to "low" (the weakest gate) instead of being refused. All three are
// now refused up front with `process.exitCode = 1` and a named message.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";
import { skillsGovernanceCommand } from "./skills-governance";

// R3-4 (flow 309 review round 3): chmod 000 has no effect for the root user
// (root can read/write regardless of mode bits) — same caveat as
// catalog-index.test.ts's own chmod-based repro.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  process.exitCode = 0;
});

afterEach(() => {
  errorSpy?.mockRestore();
  process.exitCode = 0;
});

describe("keryx skills eval: --trials validation", () => {
  test("--trials abc (non-numeric) is refused, not silently NaN", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials", "abc"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(true);
  });

  test("--trials 0 is refused (not a positive integer)", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials", "0"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(true);
  });

  test("--trials=3 (equals form) is honored, not silently ignored", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials=3", "--json"]);
    // A valid --trials=3 must not hit the validation-error exit path.
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(false);
  });
});

describe("keryx skills eval: --strictness validation", () => {
  test("an unknown --strictness value is refused, not silently downgraded to 'low'", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness", "hihg"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--strictness must be one of low, medium, high"))).toBe(true);
  });

  test("a valid --strictness value is accepted", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness", "medium", "--json"]);
    expect(errors.some((line) => line.includes("--strictness must be one of"))).toBe(false);
  });
});

// R2-8 (flow 309 review round 2): a value-taking flag given with NO value at
// all (trailing, or immediately followed by another flag) used to read
// exactly like the flag being absent (`optionValue` returns `undefined`
// either way) and silently fall back to the default instead of being
// refused — same class as F3/F9/F13.
describe("R2-8: valueless flags are refused, not silently defaulted", () => {
  test("--strictness with no value (trailing) is refused", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--strictness requires a value"))).toBe(true);
  });

  test("--strictness with no value (followed by another flag) is refused", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--strictness", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--strictness requires a value"))).toBe(true);
  });

  test("--trials with no value is refused, not silently defaulted to 3", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--trials", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--trials must be a positive integer"))).toBe(true);
  });

  test("--runner with no value is refused, not silently treated as omitted", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--runner", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--runner requires a value"))).toBe(true);
  });

  test("keryx skills scout --scope with no value is refused, not silently defaulted to 'bundled'", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--scope"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope requires a value"))).toBe(true);
  });

  test("keryx skills scout --scope with an unknown value is refused, not silently defaulted to 'bundled'", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--scope", "everything"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope must be 'bundled' or 'all'"))).toBe(true);
  });

  test("keryx skills stocktake --scope with no value is refused, not silently defaulted to 'bundled'", async () => {
    await skillsGovernanceCommand(["stocktake", "--scope"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope requires a value"))).toBe(true);
  });

  test("keryx skills scout --record with no value is refused, not silently swallowing the next flag as its value", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--record", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--record requires a value"))).toBe(true);
  });
});

// Flow 312, W3 T10: `--origin learned --source-ref <id>` — the provenance a
// `keryx learn graduate` skill-target proposal's own `nextSteps` prints.
describe("keryx skills scout --origin/--source-ref (flow 312, W3 T10)", () => {
  test("--origin without --source-ref is refused", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--record", "/tmp/x", "--origin", "learned"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--origin and --source-ref must be given together"))).toBe(true);
  });

  test("--source-ref without --origin is refused", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--record", "/tmp/x", "--source-ref", "testing.some-pattern-aaaaaaaa"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--origin and --source-ref must be given together"))).toBe(true);
  });

  test("--origin/--source-ref without --record is refused", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--origin", "learned", "--source-ref", "testing.some-pattern-aaaaaaaa"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--origin/--source-ref require --record"))).toBe(true);
  });

  test("an --origin value other than 'learned' is refused", async () => {
    await skillsGovernanceCommand([
      "scout",
      "some query",
      "--record",
      "/tmp/x",
      "--origin",
      "generated",
      "--source-ref",
      "testing.some-pattern-aaaaaaaa",
    ]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--origin must be one of learned"))).toBe(true);
  });

  test("a --source-ref that matches neither the learned-pattern id pattern nor grad- is refused", async () => {
    await skillsGovernanceCommand(["scout", "some query", "--record", "/tmp/x", "--origin", "learned", "--source-ref", "NOT VALID!"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("is not a valid learned-pattern or graduation-proposal id"))).toBe(true);
  });

  test("a well-formed learned-pattern id source-ref is accepted and recorded", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "scout-origin-record-"));
    try {
      await skillsGovernanceCommand([
        "scout",
        "extract shared helper logic",
        "--record",
        packDir,
        "--origin",
        "learned",
        "--source-ref",
        "code-style.extract-helper-aaaaaaaa",
      ]);
      expect(process.exitCode).toBe(0);
      const { readScoutRecord } = await import("../gdskills/governance/scout");
      const record = readScoutRecord(packDir);
      expect(record).toHaveLength(1);
      expect(record[0]?.origin).toEqual({ kind: "learned", sourceRef: "code-style.extract-helper-aaaaaaaa" });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  test("a grad- proposal id source-ref is accepted", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "scout-origin-record-"));
    try {
      await skillsGovernanceCommand([
        "scout",
        "extract shared helper logic",
        "--record",
        packDir,
        "--origin",
        "learned",
        "--source-ref",
        "grad-skill-0123456789ab",
      ]);
      expect(process.exitCode).toBe(0);
      const { readScoutRecord } = await import("../gdskills/governance/scout");
      const record = readScoutRecord(packDir);
      expect(record[0]?.origin).toEqual({ kind: "learned", sourceRef: "grad-skill-0123456789ab" });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  test("scout without --origin/--source-ref records no origin field (existing behavior unchanged)", async () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "scout-origin-record-"));
    try {
      await skillsGovernanceCommand(["scout", "some query", "--record", packDir]);
      expect(process.exitCode).toBe(0);
      const { readScoutRecord } = await import("../gdskills/governance/scout");
      const record = readScoutRecord(packDir);
      expect(record[0]?.origin).toBeUndefined();
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});

// R4-2 (flow 309 review round 4): `report.unreadable` (R3-4) was JSON-only —
// the human `stocktake` output never mentioned a skipped skill, and `eval`
// on an unreadable-but-existing skill said "unknown skill id" instead of
// naming the read error.
describe("R4-2: an unreadable skill is named, not silently dropped or misreported", () => {
  let logs: string[] = [];
  let logSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  async function withUnreadableProjectSkill<T>(run: (root: string, badSkillMd: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(path.join(tmpdir(), "skills-governance-unreadable-"));
    const badDir = path.join(root, ".metaproject", "project-skills", "bad-skill");
    mkdirSync(badDir, { recursive: true });
    const badSkillMd = path.join(badDir, "SKILL.md");
    writeFileSync(badSkillMd, `---\nname: bad-skill\ndescription: Use when unreadable.\n---\n\nBody.\n`, "utf8");
    chmodSync(badSkillMd, 0o000);
    try {
      await acquireCwd(root);
      try {
        return await run(root, badSkillMd);
      } finally {
        releaseCwd();
      }
    } finally {
      chmodSync(badSkillMd, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  }

  test.skipIf(isRoot)("stocktake --scope all human output names the unreadable skill (not --json only)", async () => {
    await withUnreadableProjectSkill(async (_root, badSkillMd) => {
      await skillsGovernanceCommand(["stocktake", "--scope", "all"]);
      expect(logs.some((line) => line.includes("Unreadable: 1"))).toBe(true);
      expect(logs.some((line) => line.includes(badSkillMd) && line.includes("EACCES"))).toBe(true);
    });
  });

  test.skipIf(isRoot)("eval on an unreadable skill names the read error, not 'unknown skill id'", async () => {
    await withUnreadableProjectSkill(async (_root, badSkillMd) => {
      await skillsGovernanceCommand(["eval", "project-skills/bad-skill"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("unknown skill id"))).toBe(false);
      expect(errors.some((line) => line.includes(badSkillMd) && line.includes("EACCES"))).toBe(true);
    });
  });
});

// Flow 314 review round 1 (R1-14): CLI-level coverage for the new `eval
// --runner`/`--scope` wiring and `scout --record ... --skill-name`'s own-id
// exclusion — none of this was pinned at the CLI layer before, only checked
// by hand per the review's own evidence section.
describe("R1-14: keryx skills eval --runner / --scope CLI wiring", () => {
  test("eval --runner not-a-provider fails closed: exit 1, a named reason, never a thrown/uncaught error", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--runner", "not-a-provider"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("unknown provider"))).toBe(true);
  });

  // R2-5 (review round 2, PR #692): this test used to rely on
  // `ANTHROPIC_API_KEY` being unset in whatever environment `bun test` runs
  // in. On a machine/CI that exports a real key, `buildEvalRunner`'s
  // build-time check (`hasCredential`, `src/harness/provider/single-turn.ts`)
  // passes, and `skillsGovernanceCommand` proceeds to run a REAL,
  // network-calling, spend-incurring eval of `core/reviewer-skill-creator`
  // against Anthropic — inside a unit test. `hasCredential("anthropic", env)`
  // checks only `env.ANTHROPIC_API_KEY` (no other provider key applies to
  // "anthropic"); the saved-`auth.json` merge (`envWithSavedApiKeys`) is
  // already isolated globally by `src/lib/test-preload.ts` setting
  // `XDG_DATA_HOME` to a per-test-run temp dir, so only the raw env var needs
  // isolating here. Save/delete/restore it around the call so this test is
  // deterministic and never reaches the network regardless of the host env.
  test("eval --runner anthropic with no credential in env fails closed: exit 1, named reason", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--runner", "anthropic"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("no credential"))).toBe(true);
    } finally {
      if (savedKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
    }
  });

  test("eval --scope bogus is refused up front, not silently defaulted", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--scope", "bogus"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope must be 'bundled' or 'all'"))).toBe(true);
  });

  test("eval --scope with no value is refused, not silently defaulted to 'all'", async () => {
    await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--scope"]);
    expect(process.exitCode).toBe(1);
    expect(errors.some((line) => line.includes("--scope requires a value"))).toBe(true);
  });

  test("eval with a valid --scope bundled is accepted and recorded on the report", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--scope", "bundled", "--json"]);
      expect(errors.some((line) => line.includes("--scope must be"))).toBe(false);
      const report = JSON.parse(logs.join("\n")) as { scope?: string };
      expect(report.scope).toBe("bundled");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("eval with no --runner leaves runner/model/recordedAt off the report", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await skillsGovernanceCommand(["eval", "core/reviewer-skill-creator", "--json"]);
      const report = JSON.parse(logs.join("\n")) as { runner?: string; model?: string; recordedAt?: string };
      expect(report.runner).toBeUndefined();
      expect(report.model).toBeUndefined();
      expect(report.recordedAt).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("R1-14: keryx skills scout --record --skill-name excludes the candidate's own id", () => {
  // No fixture-bundled-root injection point exists for `loadSkillCatalog`
  // (`defaultBundledRoot()` is fixed to the real `src/gdskills/bundled`) —
  // the project-local `.metaproject/project-skills/**` tree IS an injection
  // point under `--scope all`, and exercises the exact same
  // `scoutCommand` code path (`excludeIds` built from `--record`/
  // `--skill-name`) the bundled case would. `category/name` for a project
  // skill is derived from its own two parent directory names
  // (`walkLooseSkillTree` in `catalog-index.ts`), so a `SKILL.md` at
  // `.metaproject/project-skills/<record-basename>/<skill-name>/SKILL.md`
  // gets exactly the catalog id `scoutCommand` would exclude.
  async function withCandidateProjectSkill<T>(
    body: string,
    run: (root: string, recordDir: string, skillName: string) => Promise<T>,
  ): Promise<T> {
    const root = mkdtempSync(path.join(tmpdir(), "skills-governance-scout-exclude-"));
    const recordBasename = "widget-pack";
    const skillName = "widget-dashboard-helper";
    const skillDir = path.join(root, ".metaproject", "project-skills", recordBasename, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), body, "utf8");
    try {
      await acquireCwd(root);
      try {
        return await run(root, path.join(".metaproject", "project-skills", recordBasename), skillName);
      } finally {
        releaseCwd();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("the candidate's own catalog id is excluded from its own scout matches", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const distinctivePhrase = "acme corp global widget dashboard configuration helper utility";
    const body = `---\nname: widget-dashboard-helper\ndescription: Use when ${distinctivePhrase} is needed.\ntriggers:\n  - ${distinctivePhrase}\n---\n\nBody.\n`;
    try {
      await withCandidateProjectSkill(body, async (_root, recordDir, skillName) => {
        await skillsGovernanceCommand([
          "scout",
          distinctivePhrase,
          "--record",
          recordDir,
          "--skill-name",
          skillName,
          "--scope",
          "all",
          "--json",
        ]);
      });
    } finally {
      logSpy.mockRestore();
    }
    const output = JSON.parse(logs.join("\n")) as { matches: ReadonlyArray<{ skillId: string }> };
    expect(output.matches.some((match) => match.skillId === "widget-pack/widget-dashboard-helper")).toBe(false);
  });

  test("without --record/--skill-name, the same query DOES find the candidate itself (control case)", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const distinctivePhrase = "acme corp global widget dashboard configuration helper utility";
    const body = `---\nname: widget-dashboard-helper\ndescription: Use when ${distinctivePhrase} is needed.\ntriggers:\n  - ${distinctivePhrase}\n---\n\nBody.\n`;
    try {
      await withCandidateProjectSkill(body, async () => {
        await skillsGovernanceCommand(["scout", distinctivePhrase, "--scope", "all", "--json"]);
      });
    } finally {
      logSpy.mockRestore();
    }
    const output = JSON.parse(logs.join("\n")) as { matches: ReadonlyArray<{ skillId: string }> };
    expect(output.matches.some((match) => match.skillId === "widget-pack/widget-dashboard-helper")).toBe(true);
  });
});
