import { expect, test } from "bun:test";
import type { PickedElement } from "../platform/panels";
import { addPick, clearPicks, formatPick, MAX_PICKS, onPicksChange, pickLabel, picksOf, removePick, withPicks } from "./elementPicks";

const el = (over: Partial<PickedElement> = {}): PickedElement => ({
  url: "http://localhost:3000/settings",
  title: "Settings",
  tag: "button",
  selector: '[data-testid="save"]',
  role: "button",
  name: "Save",
  text: "Save",
  attributes: { "data-testid": "save", class: "btn" },
  html: '<button class="btn" data-testid="save">Save</button>',
  styles: { color: "rgb(0, 0, 0)", margin: "0px", "font-size": "14px" },
  components: [{ framework: "react", name: "SaveButton", file: "src/SaveButton.tsx", line: 7 }],
  rect: { x: 10.4, y: 20, width: 80, height: 32 },
  viewport: { width: 800, height: 600, scale: 2 },
  screenshot: "/tmp/keryx-panel-screenshots/pick-1-1.png",
  ...over,
});

test("picks are kept per project, capped, removable, and cleared only for what was sent", () => {
  let changes = 0;
  const off = onPicksChange(() => changes++);
  const a = addPick("/p", el());
  const b = addPick("/p", el({ name: "Cancel" }));
  addPick("/q", el());
  expect(picksOf("/p").map((p) => p.key)).toEqual([a.key, b.key]);
  expect(picksOf("/q")).toHaveLength(1);

  removePick("/p", a.key);
  expect(picksOf("/p").map((p) => p.key)).toEqual([b.key]);
  const later = addPick("/p", el({ name: "Later" }));
  clearPicks("/p", [b]);
  expect(picksOf("/p").map((p) => p.key)).toEqual([later.key]);
  clearPicks("/p");
  expect(picksOf("/p")).toEqual([]);

  for (let i = 0; i < MAX_PICKS + 3; i++) addPick("/r", el({ name: `n${i}` }));
  expect(picksOf("/r")).toHaveLength(MAX_PICKS);
  expect(picksOf("/r")[0]!.name).toBe("n3");
  clearPicks("/r");
  clearPicks("/q");
  off();
  expect(changes).toBeGreaterThan(5);
});

test("chip labels name the element briefly", () => {
  expect(pickLabel(el())).toBe('button "Save"');
  expect(pickLabel(el({ name: "", text: "", role: "", tag: "div", attributes: { id: "hero" } }))).toBe("div#hero");
  expect(pickLabel(el({ name: "", text: "", role: "", tag: "div", attributes: { class: " card big" } }))).toBe("div.card");
  expect(pickLabel(el({ name: "x".repeat(50) }))).toBe(`button "${"x".repeat(31)}…"`);
});

test("a pick is formatted with its locator, component, box, screenshot and HTML", () => {
  const md = formatPick(el(), 1);
  expect(md).toContain('### Element 1: `<button>` "Save"');
  expect(md).toContain("- selector: `[data-testid=\"save\"]`");
  expect(md).toContain('- locator: test id "save"');
  expect(md).toContain("- react component: SaveButton — src/SaveButton.tsx:7");
  expect(md).toContain("- box: 80×32 at (10, 20) in a 800×600 viewport");
  expect(md).toContain("- screenshot of the element: /tmp/keryx-panel-screenshots/pick-1-1.png");
  expect(md).toContain("computed styles: color: rgb(0, 0, 0); font-size: 14px");
  expect(md).not.toContain("margin");
  expect(md).toContain("```html\n<button");
  // A page's own fence cannot close ours.
  expect(formatPick(el({ html: "<pre>```</pre>" }), 2)).toContain("````html");
});

test("the message carries the picks after the user's text and marks them untrusted; commands go unchanged", () => {
  const out = withPicks("Make it red", [el()]);
  expect(out.startsWith("Make it red\n\n---\n\n")).toBe(true);
  expect(out).toContain("untrusted content");
  expect(withPicks("", [el(), el()])).toContain("these 2 elements");
  expect(withPicks("/model x", [el()])).toBe("/model x");
  expect(withPicks("plain", [])).toBe("plain");
});
