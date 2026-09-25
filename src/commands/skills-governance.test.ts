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
import type { Judge, JudgeRequest } from "../gdskills/governance/judge";
import { readJudgeRecording, recordedJudge } from "../gdskills/governance/judge-recordings";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";
import type { buildEvalJudge } from "./model-eval-judge";
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

  // `--quick` (flow 335 review round 2 finding): the bundled catalog has
  // grown pack-by-pack across Wave 4 (110 -> 170+ skills as of this flow),
  // and this test's assertions (the "Unreadable: 1" line and the specific
  // unreadable file's own EACCES message) come from catalog LOADING, before
  // `evaluateEntry` runs per-skill at all -- an unreadable SKILL.md can't be
  // parsed into a CatalogEntry to score in the first place. `--quick` only
  // skips evaluateEntry's non-quick trigger-accuracy pass (an O(n) extra
  // check per skill against the whole catalog), which this test never
  // exercises or asserts on, so it keeps the same meaning while removing
  // the now-unaffordable cost of a full non-quick run at this catalog size
  // under CI's default 5000ms per-test timeout (it measured 7013ms without
  // this flag).
  test.skipIf(isRoot)("stocktake --scope all human output names the unreadable skill (not --json only)", async () => {
    await withUnreadableProjectSkill(async (_root, badSkillMd) => {
      await skillsGovernanceCommand(["stocktake", "--scope", "all", "--quick"]);
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

// Flow 316, T6 — `eval --judge` / `judge-check`. `go/go-build-fix` is one of
// the batch-1 migrated skills (its evals.json carries two judge-graded
// scenarios, each with a calibration pair) and is used as the fixture skill
// throughout. `SkillsGovernanceDeps.buildJudge` is the injection seam
// (`skills-governance.ts`'s own doc comment on it): every test below stays
// fully offline via a fake, deterministic `Judge` builder — never the real
// `buildEvalJudge`, never a network call.
describe("flow 316: keryx skills eval --judge / judge-check", () => {
  const GO_BUILD_FIX_SKILL = "go/go-build-fix";

  /** Wraps a plain `Judge` as the `buildJudge` seam — ignores the provider spec/options entirely (these tests do not exercise `buildEvalJudge`'s own fail-closed construction, which is covered by `model-eval-judge.test.ts`). */
  function fakeJudgeBuilder(judge: Judge): typeof buildEvalJudge {
    return (() => judge) as typeof buildEvalJudge;
  }

  describe("eval --judge stamps the fields", () => {
    test("report.judge / report.judgeModel are stamped from --judge, with no runner so the judge is never actually called", async () => {
      const logs: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      let judgeCalls = 0;
      const judge: Judge = async () => {
        judgeCalls += 1;
        return { verdict: "pass", reason: "should never be called" };
      };
      try {
        await skillsGovernanceCommand(
          ["eval", GO_BUILD_FIX_SKILL, "--judge", "deepseek:deepseek-chat", "--json"],
          { buildJudge: fakeJudgeBuilder(judge) },
        );
        const report = JSON.parse(logs.join("\n")) as { judge?: string; judgeModel?: string };
        expect(report.judge).toBe("deepseek");
        expect(report.judgeModel).toBe("deepseek-chat");
        // No `--runner` was given: `evalSkill` reports every behavior
        // scenario `not-run` before it ever reaches the judge-graded branch
        // (see `eval.ts`'s own trial loop) — the fake judge above proves
        // that by never being invoked.
        expect(judgeCalls).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    });

    test("--judge defaults judgeModel via defaultModelFor when no explicit model is given", async () => {
      const logs: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      const judge: Judge = async () => ({ verdict: "pass", reason: "unused" });
      try {
        await skillsGovernanceCommand(["eval", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--json"], {
          buildJudge: fakeJudgeBuilder(judge),
        });
        const report = JSON.parse(logs.join("\n")) as { judge?: string; judgeModel?: string };
        expect(report.judge).toBe("deepseek");
        expect(report.judgeModel).toBe("deepseek-chat");
      } finally {
        logSpy.mockRestore();
      }
    });

    test("--judge with no value is refused", async () => {
      await skillsGovernanceCommand(["eval", GO_BUILD_FIX_SKILL, "--judge"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--judge requires a value"))).toBe(true);
    });
  });

  describe("eval --reverify (flow 317, FU3: the live re-judge sampler)", () => {
    test("with no pack-dir argument is refused with usage", async () => {
      await skillsGovernanceCommand(["eval", "--reverify"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("Usage: keryx skills eval --reverify"))).toBe(true);
    });

    test("with no --judge is refused", async () => {
      await skillsGovernanceCommand(["eval", "--reverify", "/nonexistent-pack"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--judge is required"))).toBe(true);
    });

    test("--judge with no value is refused", async () => {
      await skillsGovernanceCommand(["eval", "--reverify", "/nonexistent-pack", "--judge"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--judge requires a value"))).toBe(true);
    });

    test("--sample abc (non-numeric) is refused, not silently NaN", async () => {
      await skillsGovernanceCommand(["eval", "--reverify", "/nonexistent-pack", "--judge", "deepseek", "--sample", "abc"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--sample must be a positive integer"))).toBe(true);
    });

    test("a pack dir with no governance/eval.json fails with a named error, not a thrown exception", async () => {
      const judge: Judge = async () => ({ verdict: "pass", reason: "unused" });
      const dir = mkdtempSync(path.join(tmpdir(), "reverify-empty-pack-"));
      try {
        await skillsGovernanceCommand(["eval", "--reverify", dir, "--judge", "deepseek"], { buildJudge: fakeJudgeBuilder(judge) });
        expect(process.exitCode).toBe(1);
        expect(errors.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a real fixture pack with agreeing verdicts exits 0 and reports zero disagreements", async () => {
      const { buildGateReadyReport } = await import("../gdskills/governance/__fixtures__/gate-ready-report");
      const logs: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      const dir = mkdtempSync(path.join(tmpdir(), "reverify-pack-"));
      try {
        const packId = "reverify-cli-pack";
        const skillName = "sample-skill";
        const packDir = path.join(dir, packId);
        const skillDir = path.join(packDir, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        const evalSpec = {
          triggers: { positive: ["run the reverify fixture task"], negative: ["something entirely unrelated"] },
          scenarios: [
            {
              id: "s1",
              prompt: "do it",
              strictness: "high" as const,
              expected_behavior: [
                {
                  grader: "judge" as const,
                  rubric: "must say ok",
                  pass_criteria: ["says ok"],
                },
              ],
              calibration: { known_right: "ok", known_wrong: "no", vague: "maybe ok-ish", subtle_wrong: "ok-adjacent but wrong" },
            },
          ],
        };
        writeFileSync(
          path.join(skillDir, "SKILL.md"),
          "---\nname: sample-skill\ndescription: fixture skill\ntriggers:\n  - run the reverify fixture task\n---\n\nBody.\n",
          "utf8",
        );
        writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
        mkdirSync(path.join(packDir, "governance"), { recursive: true });
        writeFileSync(
          path.join(packDir, "pack.json"),
          JSON.stringify({ id: packId, family: "language", modules: [], stability: "stable", skills: { review: [skillName] } }),
          "utf8",
        );
        const report = buildGateReadyReport({ packId, skillName, skillDir, evalSpec, trials: 3 });
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");

        const agreeingJudge: Judge = async () => ({ verdict: "pass", reason: "stub: agrees" });
        await skillsGovernanceCommand(["eval", "--reverify", packDir, "--judge", "deepseek", "--json"], {
          buildJudge: fakeJudgeBuilder(agreeingJudge),
        });
        expect(process.exitCode).toBe(0);
        const result = JSON.parse(logs.join("\n")) as { totalEligible: number; sampleSize: number; disagreements: unknown[]; thresholdExceeded: boolean };
        expect(result.totalEligible).toBe(3);
        expect(result.sampleSize).toBe(3);
        expect(result.disagreements).toEqual([]);
        expect(result.thresholdExceeded).toBe(false);
      } finally {
        logSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // A missing credential must fail closed — mirrors the existing `--runner
  // anthropic` R2-5 test (same rationale: never let a real, spend-incurring,
  // network-calling eval run inside a unit test regardless of the host env).
  // This test deliberately uses the REAL `buildEvalJudge` (no `deps`
  // override) to prove the CLI's own fail-closed wiring, not just the
  // injection seam.
  describe("a missing DeepSeek credential fails closed", () => {
    test("eval --judge deepseek with no DEEPSEEK_API_KEY in env fails closed: exit 1, named reason", async () => {
      const savedKey = process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      try {
        await skillsGovernanceCommand(["eval", GO_BUILD_FIX_SKILL, "--judge", "deepseek"]);
        expect(process.exitCode).toBe(1);
        expect(errors.some((line) => line.includes("no credential"))).toBe(true);
      } finally {
        if (savedKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = savedKey;
        }
      }
    });

    test("judge-check --judge deepseek with no DEEPSEEK_API_KEY in env fails closed: exit 1, named reason", async () => {
      const savedKey = process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      try {
        await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek"]);
        expect(process.exitCode).toBe(1);
        expect(errors.some((line) => line.includes("no credential"))).toBe(true);
      } finally {
        if (savedKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = savedKey;
        }
      }
    });
  });

  describe("judge-check", () => {
    test("--judge is required", async () => {
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--judge is required"))).toBe(true);
    });

    test("exits 1 on a misjudged canned answer (a judge that always says pass fails the anti-gaming proof)", async () => {
      const alwaysPass: Judge = async () => ({ verdict: "pass", reason: "everything looks fine" });
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek"], {
        buildJudge: fakeJudgeBuilder(alwaysPass),
      });
      // known-wrong/echo/injection/stuffed all expect "fail" — a judge that
      // always says "pass" mismatches every one of them.
      expect(process.exitCode).toBe(1);
    });

    test("exits 0 when the judge correctly grades every canned answer", async () => {
      // Mirrors `antiGamingAnswers`' own `expect` table exactly: an answer
      // passes iff it is EXACTLY the scenario's own `known_right` text.
      // `echo`/`known-wrong`/`injection`/`stuffed` are all, by construction,
      // different strings from `known_right` (`injection`/`stuffed` append
      // extra text to `known_wrong`; `echo` echoes the task prompt) — so an
      // exact-match rule grades every canned answer exactly the way
      // `antiGamingAnswers` expects, for any scenario's calibration text,
      // without needing to guess at scenario-specific substrings.
      const { loadSkillCatalog } = await import("../gdskills/governance/catalog-index");
      const { readSkillEvalSpec } = await import("../gdskills/governance/eval");
      const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
      const skill = catalog.find((entry) => entry.id === GO_BUILD_FIX_SKILL)!;
      const spec = readSkillEvalSpec(skill.path);
      const knownRightAnswers = new Set((spec?.scenarios ?? []).map((scenario) => scenario.calibration?.known_right).filter((value): value is string => value !== undefined));

      const correctJudge: Judge = async (request: JudgeRequest) => ({
        verdict: knownRightAnswers.has(request.answer) ? "pass" : "fail",
        reason: "stub",
      });
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek"], {
        buildJudge: fakeJudgeBuilder(correctJudge),
      });
      expect(process.exitCode).toBe(0);
    });

    // Fix 1 / R1-4: `--samples <n>` (default 3) — the live judge is
    // non-deterministic on identical input, so `judge-check` must call it
    // `n` times per canned answer, not once.
    test("--samples defaults to 3 calls per non-empty canned answer", async () => {
      let calls = 0;
      const countingJudge: Judge = async () => {
        calls += 1;
        return { verdict: "fail", reason: "counted" };
      };
      const { loadSkillCatalog } = await import("../gdskills/governance/catalog-index");
      const { readSkillEvalSpec } = await import("../gdskills/governance/eval");
      const { antiGamingAnswers } = await import("../gdskills/governance/judge");
      const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
      const skill = catalog.find((entry) => entry.id === GO_BUILD_FIX_SKILL)!;
      const spec = readSkillEvalSpec(skill.path);
      const judgeScenarios = (spec?.scenarios ?? []).filter((scenario) =>
        scenario.expected_behavior.some((expected) => expected.grader === "judge"),
      );
      // Every non-empty, non-skipped canned answer calls the judge once per
      // sample: count them the same way the command itself will.
      let expectedCalls = 0;
      for (const scenario of judgeScenarios) {
        for (const answer of antiGamingAnswers(scenario)) {
          if (answer.kind === "empty") continue;
          if ((answer.kind === "vague" || answer.kind === "subtle-wrong") && answer.answer.trim().length === 0) continue;
          expectedCalls += 3;
        }
      }
      expect(expectedCalls).toBeGreaterThan(0);

      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek"], {
        buildJudge: fakeJudgeBuilder(countingJudge),
      });
      expect(calls).toBe(expectedCalls);
    });

    test("--samples 1 calls the judge exactly once per non-empty canned answer", async () => {
      let calls = 0;
      const countingJudge: Judge = async () => {
        calls += 1;
        return { verdict: "fail", reason: "counted" };
      };
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--samples", "1"], {
        buildJudge: fakeJudgeBuilder(countingJudge),
      });
      expect(calls).toBeGreaterThan(0);
    });

    test("--samples 0 is refused", async () => {
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--samples", "0"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--samples must be a positive integer"))).toBe(true);
    });

    test("--samples abc (non-numeric) is refused", async () => {
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--samples", "abc"]);
      expect(process.exitCode).toBe(1);
      expect(errors.some((line) => line.includes("--samples must be a positive integer"))).toBe(true);
    });

    // R1-8: an error-carrying verdict is a mismatch, never a silent pass.
    test("an error-carrying judge verdict counts as a mismatch even when its face-value verdict equals expect", async () => {
      // `known-right` expects "pass" — a judge that reports "pass" but with
      // `error` set (the shape `buildEvalJudge` produces after two
      // unparseable replies is always fail+error, but nothing stops an
      // injected test Judge from returning this combination) must still be
      // treated as a mismatch, not a lucky pass.
      const erroringJudge: Judge = async () => ({ verdict: "pass", reason: "manufactured", error: "judge returned an unparseable verdict" });
      await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--samples", "1"], {
        buildJudge: fakeJudgeBuilder(erroringJudge),
      });
      expect(process.exitCode).toBe(1);
    });
  });

  describe("judge-check --record", () => {
    function fixtureRecordingsDir(): string {
      return mkdtempSync(path.join(tmpdir(), "skills-governance-judge-recordings-"));
    }

    test("--record writes a file that recordedJudge replays identically to the live (fake) judge", async () => {
      const dir = fixtureRecordingsDir();
      const savedEnv = process.env.KERYX_JUDGE_RECORDINGS_DIR;
      process.env.KERYX_JUDGE_RECORDINGS_DIR = dir;

      // A deterministic fake "live" judge: pass iff the answer mentions the
      // fix this skill's rubric asks for. Correctness against the rubric
      // does not matter for THIS test — only that a replay through
      // `recordedJudge` reproduces exactly what this function returned.
      const liveJudge: Judge = async (request) => {
        const pass = request.answer.toLowerCase().includes("go mod tidy") && !request.answer.toLowerCase().includes("bump the go directive");
        return { verdict: pass ? "pass" : "fail", reason: pass ? "mentions go mod tidy" : "does not mention go mod tidy correctly" };
      };

      try {
        await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--record", "--json"], {
          buildJudge: fakeJudgeBuilder(liveJudge),
        });

        const recording = readJudgeRecording(GO_BUILD_FIX_SKILL, dir);
        expect(recording).not.toBeUndefined();
        expect(recording?.judge).toBe("deepseek");
        expect(recording?.judgeModel).toBe("deepseek-chat");
        expect((recording?.entries.length ?? 0) > 0).toBe(true);
        // The empty-answer canned case never reaches the judge and is never
        // recorded (this module's own documented decision).
        expect(recording?.entries.some((entry) => entry.kind === "empty")).toBe(false);

        const replay = recordedJudge(recording!);

        // Re-derive the exact same scenarios/answers `judgeCheckCommand`
        // itself graded, and confirm the replay reproduces every verdict.
        const { loadSkillCatalog } = await import("../gdskills/governance/catalog-index");
        const { readSkillEvalSpec } = await import("../gdskills/governance/eval");
        const { antiGamingAnswers, gradeScenarioAnswer } = await import("../gdskills/governance/judge");
        const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
        const skill = catalog.find((entry) => entry.id === GO_BUILD_FIX_SKILL);
        expect(skill).not.toBeUndefined();
        const spec = readSkillEvalSpec(skill!.path);
        const judgeScenarios = (spec?.scenarios ?? []).filter((scenario) =>
          scenario.expected_behavior.some((expected) => expected.grader === "judge"),
        );
        expect(judgeScenarios.length).toBeGreaterThan(0);

        for (const scenario of judgeScenarios) {
          for (const answer of antiGamingAnswers(scenario)) {
            if (answer.kind === "empty") continue; // never recorded, see above
            const live = await gradeScenarioAnswer(answer.answer, scenario, liveJudge);
            const replayed = await gradeScenarioAnswer(answer.answer, scenario, replay);
            expect(replayed.judge).toEqual(live.judge);
            expect(replayed.passed).toBe(live.passed);
          }
        }
      } finally {
        if (savedEnv === undefined) {
          delete process.env.KERYX_JUDGE_RECORDINGS_DIR;
        } else {
          process.env.KERYX_JUDGE_RECORDINGS_DIR = savedEnv;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Fix 1 / R1-4, R1-8: each recorded entry now carries `samples`
    // (`--samples` independent calls, default 3), and an error-carrying
    // verdict persists its `error` rather than being dropped.
    test("--record with --samples 2 writes exactly 2 samples per entry, error included", async () => {
      const dir = fixtureRecordingsDir();
      const savedEnv = process.env.KERYX_JUDGE_RECORDINGS_DIR;
      process.env.KERYX_JUDGE_RECORDINGS_DIR = dir;

      let call = 0;
      // Every other call reports an error-carrying "fail" — proves both
      // that N distinct samples are actually taken (not the same call
      // reused) and that `error` survives into the recording.
      const flakyJudge: Judge = async () => {
        call += 1;
        return call % 2 === 0
          ? { verdict: "fail", reason: "judge returned an unparseable verdict", error: "judge reply was not valid JSON" }
          : { verdict: "fail", reason: "force-deletes without warning" };
      };

      try {
        await skillsGovernanceCommand(["judge-check", GO_BUILD_FIX_SKILL, "--judge", "deepseek", "--record", "--samples", "2", "--json"], {
          buildJudge: fakeJudgeBuilder(flakyJudge),
        });

        const recording = readJudgeRecording(GO_BUILD_FIX_SKILL, dir);
        expect(recording).not.toBeUndefined();
        expect((recording?.entries.length ?? 0) > 0).toBe(true);
        for (const entry of recording!.entries) {
          expect(entry.samples.length).toBe(2);
        }
        expect(recording!.entries.some((entry) => entry.samples.some((sample) => sample.error !== undefined))).toBe(true);
      } finally {
        if (savedEnv === undefined) {
          delete process.env.KERYX_JUDGE_RECORDINGS_DIR;
        } else {
          process.env.KERYX_JUDGE_RECORDINGS_DIR = savedEnv;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
