// Flow 344: the `/jevprofile` modal — pure formatting helpers, plus one
// real-render test driven by keypresses (the same harness
// `turn-guard-inspector.test.ts`/`ci-triage-inspector.test.ts` use).

import { expect, test } from "bun:test";
import { RECOMMENDED_JEV_PROFILE } from "../review/jev-profile";
import { formatJevProfileLines, isJevProfileCommand, JEV_PROFILE_COMMAND, JEV_PROFILE_FOOTER, openJevProfile } from "./jev-profile-inspector";
import { formatModalFooter } from "./modal-host";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

test("isJevProfileCommand: matches only the bare /jevprofile token", () => {
  expect(isJevProfileCommand("/jevprofile")).toBe(true);
  expect(isJevProfileCommand("  /jevprofile  ")).toBe(true);
  expect(isJevProfileCommand("/jevprofiled")).toBe(false);
  expect(isJevProfileCommand("/guard")).toBe(false);
  expect(JEV_PROFILE_COMMAND).toBe("/jevprofile");
});

test("formatJevProfileLines: one row per RECOMMENDED_JEV_PROFILE entry, marking the selected row and showing current/recommended", () => {
  const lines = formatJevProfileLines({ ci_triage: true, select: false }, 1);
  expect(lines.length).toBe(RECOMMENDED_JEV_PROFILE.length);
  expect(lines[0]?.startsWith(">")).toBe(false);
  expect(lines[0]).toContain("review.jev.ci_triage");
  expect(lines[0]).toContain("current: on");
  expect(lines[0]).toContain("recommended: on");
  expect(lines[1]?.startsWith(">")).toBe(true);
  expect(lines[1]).toContain("review.jev.select");
  expect(lines[1]).toContain("current: off");
  const riskIndex = RECOMMENDED_JEV_PROFILE.findIndex((entry) => entry.key === "risk");
  expect(lines[riskIndex]).toContain("current: (unset)");
  expect(lines[riskIndex]).toContain("recommended: off");
});

otuiTest("/jevprofile: lists every key, enter/space toggles the selected one, and 'a' applies the recommended profile", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let current: Record<string, unknown> = { ci_triage: false };
  const toggled: string[] = [];
  let applied = 0;
  const modal = openJevProfile(otui.core, h.chrome, {
    current: () => current,
    onToggle: async (key) => {
      toggled.push(key);
      current = { ...current, [key]: !current[key] };
    },
    onApplyRecommended: async () => {
      applied += 1;
      current = { ...current, ci_triage: true, select: true, edit_guard: true };
    },
    onKeypress: keypressSource(h.renderer),
    visibleRows: 80,
  });
  try {
    expect(modal).toBeDefined();
    const initial = modal!.visibleLines().join("\n");
    for (const entry of RECOMMENDED_JEV_PROFILE) {
      expect(initial).toContain(`review.jev.${entry.key}`);
    }
    expect(initial).toContain("current: off");

    await h.mockInput.pressEnter();
    await settle(h);
    expect(toggled).toEqual(["ci_triage"]);
    expect(modal!.visibleLines().join("\n")).toContain("current: on");

    await h.mockInput.pressKey("a");
    await settle(h);
    expect(applied).toBe(1);

    expect(h.captureCharFrame()).toContain(formatModalFooter(JEV_PROFILE_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});
