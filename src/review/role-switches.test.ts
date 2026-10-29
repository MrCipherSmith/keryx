import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageRolesNotRun, requiredReviewers } from "./coverage";
import {
  OPTIONAL_BY_DEFAULT,
  ROLE_LINE_PREFIX,
  ROUND_ROLES_FILE,
  decideRoleSwitches,
  optInRolesFromArgs,
  optionalRolesLine,
  packageEnabledRoles,
  readRoleConfig,
  recordEnabledRoles,
  rolesThatRan,
  upsertOptionalRolesLine,
} from "./role-switches";

const NO_CONFIG = { disabled: [], enabled: [], warnings: [] };
const CORE = new Set(["review-logic", "review-architecture", "review-regression"]);
const ROSTER = ["review-logic", "review-architecture", "review-clean-code", "review-style", "review-performance"];

describe("decideRoleSwitches", () => {
  test("the readability roles are off by default, with the reason", () => {
    const { off, warnings } = decideRoleSwitches({ roster: ROSTER, config: NO_CONFIG, optIn: [], protectedRoles: CORE });
    expect([...off.keys()].sort()).toEqual([...OPTIONAL_BY_DEFAULT].sort());
    expect(off.get("review-clean-code")).toContain("--style");
    expect(warnings).toEqual([]);
  });

  test("the opt-in turns a role on", () => {
    const { off } = decideRoleSwitches({ roster: ROSTER, config: NO_CONFIG, optIn: ["review-style"], protectedRoles: CORE });
    expect([...off.keys()]).toEqual(["review-clean-code"]);
  });

  test("the config switches any built-in role off, with a reason that names the key", () => {
    const { off } = decideRoleSwitches({ roster: ROSTER, config: { ...NO_CONFIG, disabled: ["review-performance"] }, optIn: [], protectedRoles: CORE });
    expect(off.get("review-performance")).toContain("reviewRoles.disabled");
    expect(off.get("review-performance")).toContain("--with-role review-performance");
  });

  test("an unknown name in the config is a warning, not a refusal", () => {
    const { off, warnings } = decideRoleSwitches({ roster: ROSTER, config: { ...NO_CONFIG, disabled: ["review-nope"] }, optIn: [], protectedRoles: CORE });
    expect(off.has("review-nope")).toBe(false);
    expect(warnings.join("\n")).toContain('unknown role "review-nope"');
  });

  test("a core role cannot be switched off", () => {
    const { off, warnings } = decideRoleSwitches({ roster: ROSTER, config: { ...NO_CONFIG, disabled: ["review-logic"] }, optIn: [], protectedRoles: CORE });
    expect(off.has("review-logic")).toBe(false);
    expect(warnings.join("\n")).toContain("review-logic is a core role");
  });

  test("the always-on list and --with-role beat the config", () => {
    const config = { ...NO_CONFIG, disabled: ["review-performance"], enabled: ["review-style"] };
    expect([...decideRoleSwitches({ roster: ROSTER, config, optIn: [], protectedRoles: CORE }).off.keys()].sort()).toEqual(["review-clean-code", "review-performance"]);
    expect(decideRoleSwitches({ roster: ROSTER, config, optIn: ["review-performance"], protectedRoles: CORE }).off.has("review-performance")).toBe(false);
  });

  test("a config that cannot be trusted this round is reported and not applied", () => {
    const { off, warnings } = decideRoleSwitches({
      roster: ROSTER,
      config: { ...NO_CONFIG, disabled: ["review-performance"] },
      optIn: [],
      protectedRoles: CORE,
      configIgnored: "routing.config.json is part of this change",
    });
    expect(off.has("review-performance")).toBe(false);
    expect(warnings.join("\n")).toContain("routing.config.json is part of this change");
  });
});

describe("optInRolesFromArgs", () => {
  test("--style means both readability roles; --with-role names one, in both spellings", () => {
    expect(optInRolesFromArgs(["--style"])).toEqual(["review-clean-code", "review-style"]);
    expect(optInRolesFromArgs(["--with-role", "review-performance", "--with-role=review-style"])).toEqual(["review-performance", "review-style"]);
    expect(optInRolesFromArgs(["--json"])).toEqual([]);
  });

  test("--with-role without a name is refused", () => {
    expect(() => optInRolesFromArgs(["--with-role"])).toThrow("needs a role name");
    expect(() => optInRolesFromArgs(["--with-role", "--json"])).toThrow("needs a role name");
    expect(() => optInRolesFromArgs(["--with-role="])).toThrow("needs a role name");
  });
});

describe("the report line", () => {
  test("lists the roles, sorted, and is absent for none", () => {
    const line = optionalRolesLine(["review-style", "review-clean-code"]) as string;
    expect(line.startsWith(`${ROLE_LINE_PREFIX} review-clean-code, review-style`)).toBe(true);
    expect(optionalRolesLine([])).toBeUndefined();
  });

  test("it goes under the evidence line, once, however often it is applied", () => {
    const report = "# Review\n\nEvidence level: source-only\n\n## Findings\nnone\n";
    const line = optionalRolesLine(["review-style"]);
    const once = upsertOptionalRolesLine(report, line);
    expect(once).toContain(`Evidence level: source-only\n${line}`);
    expect(upsertOptionalRolesLine(once, line)).toBe(once);
    expect(once.split(ROLE_LINE_PREFIX)).toHaveLength(2);
  });

  test("a report with no evidence line gets it at the end; a changed list replaces the old line", () => {
    const first = upsertOptionalRolesLine("# Review\n", optionalRolesLine(["review-style"]));
    expect(first.trimEnd().endsWith(")")).toBe(true);
    const second = upsertOptionalRolesLine(first, optionalRolesLine(["review-clean-code", "review-style"]));
    expect(second.split(ROLE_LINE_PREFIX)).toHaveLength(2);
    expect(second).toContain("review-clean-code, review-style");
  });

  test("with nothing to say the line is removed and the rest of the report stays", () => {
    const report = "# Review\n\nEvidence level: source-only\n\n## Findings\nnone\n";
    const withLine = upsertOptionalRolesLine(report, optionalRolesLine(["review-style"]));
    expect(upsertOptionalRolesLine(withLine, undefined)).toBe(report);
    expect(upsertOptionalRolesLine(report, undefined)).toBe(report);
  });
});

describe("on disk", () => {
  let root: string;
  let pkg: string;

  async function install(name: string): Promise<void> {
    const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-roles-"));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
    for (const name of ["review-orchestrator", "review-verifier", "review-logic", "review-architecture", "review-clean-code", "review-style", "review-performance"]) await install(name);
    pkg = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(pkg, { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const config = (value: unknown): Promise<void> => writeFile(path.join(root, "routing.config.json"), JSON.stringify(value), "utf8");

  test("readRoleConfig reads reviewRoles and warns, without failing, on a malformed one", async () => {
    expect(await readRoleConfig(root)).toEqual(NO_CONFIG);
    await config({ reviewRoles: { disabled: ["review-performance"], enabled: ["review-style"] } });
    expect(await readRoleConfig(root)).toEqual({ disabled: ["review-performance"], enabled: ["review-style"], warnings: [] });
    await config({ reviewRoles: { disabled: "review-performance" } });
    const bad = await readRoleConfig(root);
    expect(bad.disabled).toEqual([]);
    expect(bad.warnings.join("\n")).toContain("reviewRoles.disabled must be a list");
    await config({ reviewRoles: [] });
    expect((await readRoleConfig(root)).warnings.join("\n")).toContain("reviewRoles must be an object");
  });

  test("without the flag the engine leaves the two readability roles out; with it the roster is today's", async () => {
    const plain = await requiredReviewers(root, "all", undefined);
    expect(plain.required).toEqual(["review-architecture", "review-logic", "review-performance"]);
    expect(plain.rolesOff).toEqual(["review-clean-code", "review-style"]);
    const styled = await requiredReviewers(root, "all", undefined, { enabledRoles: ["review-clean-code", "review-style"] });
    expect(styled.required).toEqual(["review-architecture", "review-clean-code", "review-logic", "review-performance", "review-style"]);
    expect(styled.rolesOff ?? []).toEqual([]);
  });

  test("G2: the project config switches review-performance off, a name that is not there only warns", async () => {
    await config({ reviewRoles: { disabled: ["review-performance", "review-not-installed"] } });
    const need = await requiredReviewers(root, "all", undefined);
    expect(need.required).not.toContain("review-performance");
    expect(need.excluded.find((e) => e.reviewer === "review-performance")?.reason).toContain("reviewRoles.disabled");
    expect(need.warnings?.join("\n")).toContain('unknown role "review-not-installed"');
    const back = await requiredReviewers(root, "all", undefined, { enabledRoles: ["review-performance"] });
    expect(back.required).toContain("review-performance");
  });

  test("the config is not applied when this change edits routing.config.json itself", async () => {
    await config({ reviewRoles: { disabled: ["review-performance"] } });
    const need = await requiredReviewers(root, "all", ["src/a.ts", "routing.config.json"]);
    expect(need.required).toContain("review-performance");
    expect(need.warnings?.join("\n")).toContain("not applied");
  });

  test("G3: --depth light does not bring a switched-off role back", async () => {
    const light = await requiredReviewers(root, "all", ["src/a.ts"], { depth: "light" });
    expect(light.depth).toBe("light");
    expect(light.required).not.toContain("review-clean-code");
    expect(light.required).not.toContain("review-style");
  });

  test("recordEnabledRoles keeps what is recorded, sorted, and writes nothing for an empty opt-in", async () => {
    expect(await recordEnabledRoles(pkg, [])).toEqual([]);
    await expect(readFile(path.join(pkg, ROUND_ROLES_FILE), "utf8")).rejects.toThrow();
    expect(await recordEnabledRoles(pkg, ["review-style"])).toEqual(["review-style"]);
    expect(await recordEnabledRoles(pkg, ["review-clean-code"])).toEqual(["review-clean-code", "review-style"]);
    expect(await recordEnabledRoles(pkg, [])).toEqual(["review-clean-code", "review-style"]);
    expect(await packageEnabledRoles(pkg)).toEqual(["review-clean-code", "review-style"]);
  });

  test("rolesThatRan and packageRolesNotRun: a role with a driver or a raw reply ran, whatever the switches say now", async () => {
    expect(await packageRolesNotRun(pkg)).toEqual(["review-clean-code", "review-style"]);
    await mkdir(path.join(pkg, "raw"), { recursive: true });
    await writeFile(path.join(pkg, "raw", "review-style-1.txt"), "REVIEW_RESULT: {}\n", "utf8");
    expect([...(await rolesThatRan(pkg, ["review-style", "review-clean-code"]))]).toEqual(["review-style"]);
    expect(await packageRolesNotRun(pkg)).toEqual(["review-clean-code"]);
    await recordEnabledRoles(pkg, ["review-clean-code", "review-style"]);
    expect(await packageRolesNotRun(pkg)).toEqual([]);
  });
});
