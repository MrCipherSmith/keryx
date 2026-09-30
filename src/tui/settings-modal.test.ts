// Flow 374: the `/settings` modal. A real shell chrome on a headless renderer,
// driven by keypresses the way the operator drives it, with the read and write
// sides faked: `run` records the slash line a button hands over and changes the
// fake state, `load` rebuilds the rows from that state — the same contract the
// shell satisfies with its own handlers.

import { expect, test } from "bun:test";
import { buildSettingsRows, type SettingRow, type SettingsSnapshot } from "./settings-model";
import { CONFIRM_MIN_GAP_MS, isSettingsCommand, openSettings, SETTINGS_COMMAND, SETTINGS_FOOTER, settingsSidebarHint, settingsWindow } from "./settings-modal";
import { formatModalFooter } from "./modal-host";
import { clickNode, findById, keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const STATE: SettingsSnapshot = {
  permissionMode: "ask",
  plan: false,
  guard: false,
  editGuard: false,
  routing: false,
  externalPrivacy: { value: "on", source: "user" },
  reasoning: { effort: "off", source: "global" },
  thinkDisplay: "auto",
  theme: "auto",
  jevProfile: { on: 0, total: 9 },
  externalAgents: { on: false, reason: "not enabled" },
};

/** Applies the few commands these tests press to a snapshot — standing in for the shell's own handlers. */
function apply(state: SettingsSnapshot, command: string): SettingsSnapshot {
  const [name, arg] = command.split(" ") as [string, string];
  if (name === "/mode") return { ...state, permissionMode: arg as SettingsSnapshot["permissionMode"] };
  if (name === "/plan") return { ...state, plan: arg === "on" };
  if (name === "/guard") return { ...state, guard: arg === "on" };
  throw new Error(`unexpected command ${command}`);
}

function harness(initial: SettingsSnapshot = STATE) {
  let state = initial;
  const ran: string[] = [];
  return {
    ran,
    rows: (): SettingRow[] => buildSettingsRows(state),
    run: async (command: string): Promise<void> => {
      ran.push(command);
      state = apply(state, command);
    },
  };
}

test("isSettingsCommand: matches only the bare /settings token", () => {
  expect(isSettingsCommand("/settings")).toBe(true);
  expect(isSettingsCommand("  /settings  ")).toBe(true);
  expect(isSettingsCommand("/settingsx")).toBe(false);
  expect(isSettingsCommand("/mode")).toBe(false);
  expect(SETTINGS_COMMAND).toBe("/settings");
});

test("settingsSidebarHint: points at /settings, except where the read-only marker needs the room", () => {
  expect(settingsSidebarHint(false)).toBe("/settings");
  expect(settingsSidebarHint(true)).toBeUndefined();
});

test("settingsWindow: keeps the selected row inside the budget and counts group headings", () => {
  const rows = buildSettingsRows(STATE);
  // Safety opens with a heading: heading + 2 lines for the first row.
  expect(settingsWindow(rows, 0, 0, 3)).toEqual({ top: 0, end: 0 });
  expect(settingsWindow(rows, 0, 0, 5)).toEqual({ top: 0, end: 1 });
  // A window too small for the selected row still starts at it.
  expect(settingsWindow(rows, 4, 0, 3).top).toBe(4);
  // Scrolling down moves the top just far enough; the selection stays visible.
  const scrolled = settingsWindow(rows, 7, 0, 10);
  expect(scrolled.top).toBeLessThanOrEqual(7);
  expect(scrolled.end).toBeGreaterThanOrEqual(7);
  // Everything fits in a generous budget.
  expect(settingsWindow(rows, 3, 0, 1000)).toEqual({ top: 0, end: rows.length - 1 });
  // Moving back up brings the top with it.
  expect(settingsWindow(rows, 1, 6, 10).top).toBe(1);
});

otuiTest("/settings: groups, values, scopes and buttons are drawn in the /connect style", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    expect(modal).toBeDefined();
    await settle(h);
    const frame = h.captureCharFrame();
    for (const group of ["Safety", "Routing", "Display", "External"]) expect(frame).toContain(group);
    for (const label of ["Permission mode", "Plan (read-only)", "Turn guard", "Reasoning effort", "Theme", "External providers", "External agents"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("[session]");
    expect(frame).toContain("[saved]");
    expect(frame).toContain("[✓ ask]");
    expect(frame).toContain("[trust]");
    expect(frame).toContain("[auto]");
    expect(frame).toContain("[✓ Off]");
    expect(frame).toContain("[On]");
    expect(frame).toContain("run /jevprofile");
    expect(frame).toContain(formatModalFooter(SETTINGS_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: arrows move between rows and buttons, Enter runs the command and the value on screen changes", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    // Row 0 is the permission mode, its active button (ask) is selected: → trust, Enter.
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual(["/mode trust"]);
    let frame = h.captureCharFrame();
    expect(frame).toContain("[✓ trust]");
    expect(frame).not.toContain("[✓ ask]");

    // Down to Plan: the selected button starts on its active one (Off); ← is On.
    await h.mockInput.pressKey("ARROW_DOWN");
    await h.mockInput.pressKey("ARROW_LEFT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual(["/mode trust", "/plan on"]);
    frame = h.captureCharFrame();
    expect(frame).toContain("[✓ On]");

    // Up wraps from the first row to the last (read-only Jev row): Enter there runs nothing.
    await h.mockInput.pressKey("ARROW_UP");
    await h.mockInput.pressKey("ARROW_UP");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual(["/mode trust", "/plan on"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: a single Enter never reaches auto — it arms, and the second Enter commits", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  let clock = 1000;
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
    now: () => clock,
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual([]);
    expect(h.captureCharFrame()).toContain("Enter again to confirm auto");
    expect(h.captureCharFrame()).toContain("[✓ ask]");

    clock += CONFIRM_MIN_GAP_MS;
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual(["/mode auto"]);
    const frame = h.captureCharFrame();
    expect(frame).toContain("[✓ auto]");
    expect(frame).not.toContain("Enter again to confirm");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: moving off an armed auto disarms it, so the next Enter arms again instead of committing", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(h.captureCharFrame()).toContain("Enter again to confirm auto");

    await h.mockInput.pressKey("ARROW_LEFT");
    await settle(h);
    expect(h.captureCharFrame()).not.toContain("Enter again to confirm");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual([]);
    expect(h.captureCharFrame()).toContain("Enter again to confirm auto");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: Esc disarms a pending auto first, and the next Esc closes the modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50, kittyKeyboard: true });
  const fake = harness();
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(h.captureCharFrame()).toContain("Enter again to confirm auto");

    h.mockInput.pressEscape();
    await settle(h);
    let frame = h.captureCharFrame();
    expect(frame).toContain("Permission mode");
    expect(frame).not.toContain("Enter again to confirm");
    expect(fake.ran).toEqual([]);

    h.mockInput.pressEscape();
    await settle(h);
    frame = h.captureCharFrame();
    expect(frame).not.toContain("Permission mode");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: clicking a button selects and presses it; auto still needs the second click", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    const press = async (id: string): Promise<void> => {
      await clickNode(h, findById(h.renderer.root, id));
      await settle(h);
    };
    await press("st-guard-0");
    expect(fake.ran).toEqual(["/guard on"]);
    expect(h.captureCharFrame()).toContain("[✓ On]");

    await press("st-mode-2");
    expect(fake.ran).toEqual(["/guard on"]);
    await press("st-mode-2");
    expect(fake.ran).toEqual(["/guard on", "/mode auto"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: a short terminal shows a window of rows and scrolls to keep the selection visible", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 16 });
  const fake = harness();
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    const first = h.captureCharFrame();
    expect(first).toContain("Permission mode");
    expect(first).not.toContain("Jev review profile");
    for (let i = 0; i < 10; i += 1) await h.mockInput.pressKey("ARROW_DOWN");
    await settle(h);
    const last = h.captureCharFrame();
    expect(last).toContain("Jev review profile");
    expect(last).not.toContain("Permission mode");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: a held Enter cannot arm and commit auto in one press — a second Enter inside the gap is ignored", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  let clock = 1000;
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
    now: () => clock,
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter(); // arms
    await settle(h);
    // Auto-repeat: a burst of Enters a few milliseconds apart.
    for (const step of [5, 30, 120, CONFIRM_MIN_GAP_MS - 1 - 155]) {
      clock += step;
      await h.mockInput.pressEnter();
      await settle(h);
    }
    expect(fake.ran).toEqual([]);
    expect(h.captureCharFrame()).toContain("Enter again to confirm auto");

    // A deliberate second Enter after the gap commits.
    clock += CONFIRM_MIN_GAP_MS;
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual(["/mode auto"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: while inputBlocked, keys and clicks change nothing and auto is never reached", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  let blocked = true;
  let clock = 1000;
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => fake.rows(),
    run: fake.run,
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
    inputBlocked: () => blocked,
    now: () => clock,
  });
  try {
    await settle(h);
    const click = async (id: string): Promise<void> => {
      await clickNode(h, findById(h.renderer.root, id));
      await settle(h);
    };
    // Two clicks on [auto] (arm + commit), a click on another button, and Enters.
    await click("st-mode-2");
    clock += 10_000;
    await click("st-mode-2");
    await click("st-guard-0");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    clock += 10_000;
    await h.mockInput.pressEnter();
    await settle(h);
    expect(fake.ran).toEqual([]);
    const blockedFrame = h.captureCharFrame();
    expect(blockedFrame).not.toContain("Enter again to confirm");
    expect(blockedFrame).toContain("[✓ ask]");

    // Unblocked again, the very same click arms (one click never commits auto).
    blocked = false;
    await click("st-mode-2");
    expect(fake.ran).toEqual([]);
    expect(h.captureCharFrame()).toContain("Enter again to confirm auto");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("/settings: a failing run is reported through onError and the rows are still rebuilt", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const fake = harness();
  const errors: string[] = [];
  let loads = 0;
  const modal = openSettings(otui.core, h.chrome, {
    rows: fake.rows(),
    load: async () => {
      loads += 1;
      return fake.rows();
    },
    run: async () => {
      throw new Error("disk full");
    },
    onError: (message) => errors.push(message),
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("/mode trust");
    expect(errors[0]).toContain("disk full");
    expect(loads).toBe(1);
    expect(h.captureCharFrame()).toContain("Permission mode");
  } finally {
    modal?.close();
    h.destroy();
  }
});
