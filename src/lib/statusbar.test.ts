import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { collapseHome, formatStatusBar, scrollRegion } from "./statusbar";

const savedNoColor = process.env.NO_COLOR;
const savedForceColor = process.env.FORCE_COLOR;

afterEach(() => {
  restore("NO_COLOR", savedNoColor);
  restore("FORCE_COLOR", savedForceColor);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const ESC = "["; // the CSI/ESC 0x1b marker — asserted absent in plain mode

test("collapseHome collapses a leading $HOME to ~", () => {
  expect(collapseHome(`${homedir()}/goodea/keryx`)).toBe("~/goodea/keryx");
  expect(collapseHome("/etc/hosts")).toBe("/etc/hosts");
});

test("formatStatusBar (NO_COLOR) is plain, collapses home, and joins the segments", () => {
  process.env.NO_COLOR = "1";
  const bar = formatStatusBar({
    cwd: `${homedir()}/goodea/keryx`,
    provider: "ollama",
    model: "gemma4:e4b",
    columns: 80,
  });
  expect(bar).toContain("~/goodea/keryx");
  expect(bar).toContain("ollama/gemma4:e4b");
  expect(bar).toContain("/help");
  expect(bar).not.toContain(ESC); // no ANSI escape codes
});

test("formatStatusBar middle-truncates the cwd to fit columns (visible width <= columns)", () => {
  process.env.NO_COLOR = "1";
  const columns = 40;
  const bar = formatStatusBar({
    cwd: "/very/long/path/to/some/deep/project/directory/here",
    provider: "ollama",
    model: "x",
    columns,
  });
  expect(bar.length).toBeLessThanOrEqual(columns);
  expect(bar).toContain("…");
  expect(bar).toContain("ollama/x");
});

test("formatStatusBar (FORCE_COLOR) emits ANSI while keeping the text", () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  const bar = formatStatusBar({
    cwd: "/tmp/proj",
    provider: "fake",
    model: "test",
    columns: 80,
  });
  expect(bar).toContain("[36m"); // cyan cwd
  expect(bar).toContain("fake/test");
});

test("scrollRegion builds DECSTBM enter / drawAt / exit control sequences", () => {
  const region = scrollRegion(24);
  // Enter: reserve the bottom row → region 1..23.
  expect(region.enter).toContain("[1;23r");
  // Draw: clear the target line before writing.
  const drawn = region.drawAt(24, "BAR");
  expect(drawn).toContain("[24;1H");
  expect(drawn).toContain("[2K");
  expect(drawn).toContain("BAR");
  // Exit: reset the scroll region and show the cursor.
  expect(region.exit).toContain("[r");
  expect(region.exit).toContain("[?25h");
});
