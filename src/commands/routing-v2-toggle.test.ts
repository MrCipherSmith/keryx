import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routingV2Mode, setRoutingV2Active } from "./routing";

describe("/route-v2 toggle (routingV2Mode + setRoutingV2Active)", () => {
  let cwd: string;
  let userConfigDir: string;
  const savedOverride = process.env.KERYX_SUBAGENT_MODEL;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "route-v2-proj-"));
    userConfigDir = mkdtempSync(join(tmpdir(), "route-v2-user-"));
    delete process.env.KERYX_SUBAGENT_MODEL;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(userConfigDir, { recursive: true, force: true });
    if (savedOverride === undefined) delete process.env.KERYX_SUBAGENT_MODEL;
    else process.env.KERYX_SUBAGENT_MODEL = savedOverride;
  });

  test("a fresh project reports legacy mode", () => {
    expect(routingV2Mode({ cwd, userConfigDir })).toBe("legacy");
  });

  test("on activates v2, a second on is idempotent, off returns to legacy", async () => {
    expect(await setRoutingV2Active(true, { cwd, userConfigDir })).toContain("on");
    expect(routingV2Mode({ cwd, userConfigDir })).toBe("v2");
    expect(await setRoutingV2Active(true, { cwd, userConfigDir })).toContain("already on");
    expect(await setRoutingV2Active(false, { cwd, userConfigDir })).toContain("off");
    expect(routingV2Mode({ cwd, userConfigDir })).toBe("legacy");
  });

  test("on refuses while KERYX_SUBAGENT_MODEL is set, and the mode stays legacy", async () => {
    process.env.KERYX_SUBAGENT_MODEL = "openai/gpt-x";
    await expect(setRoutingV2Active(true, { cwd, userConfigDir })).rejects.toThrow("KERYX_SUBAGENT_MODEL");
    expect(routingV2Mode({ cwd, userConfigDir })).toBe("legacy");
  });
});
