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
