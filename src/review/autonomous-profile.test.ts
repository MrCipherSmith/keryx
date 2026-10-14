// The autonomous review profile is defined once; every consumer reads it from here.

import { describe, expect, test } from "bun:test";
import {
  AUTONOMOUS_EXIT,
  AUTONOMOUS_PROFILE,
  AUTONOMOUS_PROFILE_ID,
  AUTONOMOUS_STATUSES,
  buildAutonomousShellArgv,
  buildAutonomousPrompt,
  exitCodeFor,
  isFloorRefusal,
  parseAutonomousTarget,
} from "./autonomous-profile";

describe("profile", () => {
  test("is trust mode with review-auto, source-only and bounded rounds", () => {
    expect(AUTONOMOUS_PROFILE_ID).toBe("review-autonomous");
    expect(AUTONOMOUS_PROFILE.permissionMode).toBe("trust");
    expect(AUTONOMOUS_PROFILE.reviewSystem).toBe("review-auto");
    expect(AUTONOMOUS_PROFILE.sourceOnly).toBe(true);
    expect(AUTONOMOUS_PROFILE.roundLimit).toBeGreaterThan(0);
    expect(AUTONOMOUS_PROFILE.waveSize).toBeGreaterThan(0);
    expect(AUTONOMOUS_PROFILE.stallMinutes).toBe(10);
  });

  test("exit codes are the documented five", () => {
    expect(AUTONOMOUS_EXIT).toEqual({ complete: 0, incomplete: 2, floor: 3, budget: 4, stalled: 5 });
  });

  test("every status maps to its exit code", () => {
    expect(AUTONOMOUS_STATUSES.map((s) => exitCodeFor(s))).toEqual([0, 2, 3, 4, 5]);
  });
});

describe("shell argv", () => {
  test("is a one-turn print shell in trust mode under review-auto, with an events file", () => {
    const argv = buildAutonomousShellArgv({ prompt: "do the review", eventsFile: "/tmp/e.ndjson" });
    expect(argv.slice(0, 1)).toEqual(["shell"]);
    expect(argv).toContain("--print");
    expect(argv[argv.indexOf("--print") + 1]).toBe("do the review");
    expect(argv).toContain("--trust");
    expect(argv[argv.indexOf("--review-system") + 1]).toBe("review-auto");
    expect(argv[argv.indexOf("--events-file") + 1]).toBe("/tmp/e.ndjson");
    expect(argv).toContain("--no-tui");
  });

  test("passes provider and model only when given", () => {
    const bare = buildAutonomousShellArgv({ prompt: "p", eventsFile: "e" });
    expect(bare).not.toContain("--model");
    const withModel = buildAutonomousShellArgv({ prompt: "p", eventsFile: "e", provider: "openai-codex", model: "gpt-6.1-sol" });
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
    expect(withModel[withModel.indexOf("--provider") + 1]).toBe("openai-codex");
  });
});

describe("prompt", () => {
  test("names the target, the round limit, the wave size and source-only, and forbids asking", () => {
    const text = buildAutonomousPrompt({ ref: "https://github.com/o/r/pull/7" });
    expect(text).toContain("https://github.com/o/r/pull/7");
    expect(text).toContain(String(AUTONOMOUS_PROFILE.roundLimit));
    expect(text).toContain(String(AUTONOMOUS_PROFILE.waveSize));
    expect(text).toMatch(/source-only/i);
    expect(text).toMatch(/keryx review complete/);
    expect(text).toMatch(/nobody (is )?(at the keyboard|answering)/i);
  });

  test("dispatches the full reviewer set and never the diff-derived one", () => {
    const text = buildAutonomousPrompt({ ref: "https://github.com/o/r/pull/7" });
    expect(text).toContain("keryx review required --mode all");
    expect(text).toMatch(/do not use mode "diff"/);
  });

  test("keeps the orchestration in the main session and says why a subagent cannot take it", () => {
    const text = buildAutonomousPrompt({ ref: "https://github.com/o/r/pull/7" });
    expect(text).toContain("Run the whole orchestration yourself in this session");
    expect(text).toContain("nested_dispatch_unavailable");
  });

  test("a known pull request head is named and --head is required on start, ingest and complete", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const text = buildAutonomousPrompt({ ref: "https://github.com/o/r/pull/7", head });
    expect(text).toContain(`The pull request head is ${head}`);
    expect(text).toContain(`--head ${head}`);
    expect(text).toContain("keryx review ingest");
    expect(text).toContain("`keryx review complete`");
  });

  test("an unknown head leaves the prompt unchanged", () => {
    const ref = "https://github.com/o/r/pull/7";
    expect(buildAutonomousPrompt({ ref, head: null })).toBe(buildAutonomousPrompt({ ref }));
    expect(buildAutonomousPrompt({ ref, head: null })).not.toContain("--head");
  });

  test("a resumed run names the package to continue", () => {
    const text = buildAutonomousPrompt({ ref: "https://github.com/o/r/pull/7", resumePackage: "rv-123" });
    expect(text).toContain("rv-123");
    expect(text).toMatch(/resume|continue/i);
  });
});

describe("target", () => {
  test("accepts a pull request URL and reads its number", () => {
    expect(parseAutonomousTarget("https://github.com/o/r/pull/7435")).toEqual({
      kind: "pr",
      ref: "https://github.com/o/r/pull/7435",
      repository: "o/r",
      number: 7435,
    });
  });

  test("refuses a ref that is not a pull request URL", () => {
    expect(() => parseAutonomousTarget("main")).toThrow(/pull request URL/);
    expect(() => parseAutonomousTarget("https://github.com/o/r/issues/3")).toThrow(/pull request URL/);
  });
});

describe("floor refusal", () => {
  test("recognises the denial texts an unattended floor ask produces", () => {
    expect(isFloorRefusal("command not approved by the user; not executed")).toBe(true);
    expect(isFloorRefusal("subagent spawn not approved by the user; not executed")).toBe(true);
    expect(isFloorRefusal("refused earlier: choose another path")).toBe(true);
  });

  test("does not mistake an ordinary failure for a floor", () => {
    expect(isFloorRefusal("exit code 1: tests failed")).toBe(false);
    expect(isFloorRefusal("")).toBe(false);
  });
});
