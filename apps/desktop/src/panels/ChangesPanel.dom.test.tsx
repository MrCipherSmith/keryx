import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { ChangedFile, FileDiff } from "../platform/commands";
import type { LineComment } from "../session/lineComments";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let React: typeof import("react");
let ChangesPanel: typeof import("./ChangesPanel").ChangesPanel;
let extendSelection: typeof import("./ChangesPanel").extendSelection;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  ({ ChangesPanel, extendSelection } = await import("./ChangesPanel"));
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});
beforeEach(async () => {
  await act(() => root.render(null));
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const MODIFIED = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", " keep", "-old line", "+new line", "+extra", " tail"].join("\n");
const DELETED = ["--- a/src/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-first", "-second"].join("\n");

interface Fake {
  files: ChangedFile[];
  truncated: boolean;
  diffs: Record<string, FileDiff | Error>;
  reads: number;
  changed: number;
}
function fake(over: Partial<Fake> = {}): Fake {
  return {
    files: [
      { path: "src/a.ts", status: "M", staged: true },
      { path: "src/gone.ts", status: "D", staged: false },
      { path: "src/new name.ts", status: "R", origPath: "src/old name.ts", staged: false },
    ],
    truncated: false,
    diffs: {
      "src/a.ts": { path: "src/a.ts", status: "M", binary: false, tooLarge: false, text: MODIFIED },
      "src/gone.ts": { path: "src/gone.ts", status: "D", binary: false, tooLarge: false, text: DELETED },
    },
    reads: 0,
    changed: 3,
    ...over,
  };
}
const apiOf = (f: Fake) => ({
  changes: async () => (f.reads++, { files: f.files, truncated: f.truncated }),
  fileDiff: async (_cwd: string, path: string) => {
    const d = f.diffs[path];
    if (d instanceof Error) throw d;
    if (!d) throw new Error("no diff");
    return d;
  },
  info: async () => ({ branch: "b", commit: null, upstream: null, ahead: 0, behind: 0, changed: f.changed, worktree: null }),
});

async function mount(f: Fake, extra: { busy?: boolean; canComment?: boolean; onComment?: (c: LineComment) => boolean } = {}) {
  const added: LineComment[] = [];
  await act(async () => {
    root.render(React.createElement(ChangesPanel, {
      cwd: "/p", busy: extra.busy ?? false, canComment: extra.canComment ?? true, api: apiOf(f),
      onComment: extra.onComment ?? ((c) => (added.push(c), true)),
    }));
  });
  await act(async () => { await Promise.resolve(); });
  return added;
}
const click = (el: Element, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));
const fileButton = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".changes-file")).find((b) => b.textContent!.includes(name))!;
const gutter = (side: "old" | "new", n: number) => host.querySelector<HTMLButtonElement>(`[aria-label="Comment on ${side} line ${n}"]`)!;
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test("the list shows status, path, a rename's old path and the staged marker", async () => {
  await mount(fake());
  const rows = Array.from(host.querySelectorAll(".changes-file")).map((r) => r.textContent);
  expect(rows[0]).toBe("Msrc/a.tsstaged");
  expect(rows[1]).toBe("Dsrc/gone.ts");
  expect(rows[2]).toBe("Rsrc/new name.ts ← src/old name.ts");
  expect(host.querySelector(".changes-head")!.textContent).toContain("3 changed files");
});

test("a truncated list says so", async () => {
  await mount(fake({ truncated: true }));
  expect(host.textContent).toContain("Only the first 3 changed files are listed.");
});

test("an empty change list says there are no changes", async () => {
  await mount(fake({ files: [] }));
  expect(host.querySelector(".changes-head")!.textContent).toContain("No changes");
});

test("selecting a modified file numbers both sides from the hunk header", async () => {
  await mount(fake());
  await click(fileButton("src/a.ts"));
  await settle();
  expect(gutter("old", 10)).not.toBeNull();
  expect(gutter("new", 10)).not.toBeNull();
  expect(gutter("old", 11).closest(".changes-line")!.classList.contains("changes-del")).toBe(true);
  expect(gutter("new", 11).closest(".changes-line")!.classList.contains("changes-add")).toBe(true);
  expect(gutter("new", 12)).not.toBeNull();
  expect(gutter("new", 13)).not.toBeNull(); // the context line after the added ones
  expect(host.querySelector('[aria-label="Comment on new line 14"]')).toBeNull();
});

test("a deleted file shows the old side's numbers", async () => {
  await mount(fake());
  await click(fileButton("src/gone.ts"));
  await settle();
  expect(gutter("old", 1)).not.toBeNull();
  expect(gutter("old", 2)).not.toBeNull();
  expect(host.querySelector('[aria-label^="Comment on new line"]')).toBeNull();
});

test("binary, too large, empty and failing diffs each get their own message", async () => {
  const f = fake({
    diffs: {
      "src/a.ts": { path: "src/a.ts", status: "M", binary: true, tooLarge: false },
      "src/gone.ts": { path: "src/gone.ts", status: "D", binary: false, tooLarge: true },
      "src/new name.ts": new Error("git failed"),
    },
  });
  await mount(f);
  await click(fileButton("src/a.ts")); await settle();
  expect(host.textContent).toContain("Binary file");
  await click(fileButton("src/gone.ts")); await settle();
  expect(host.textContent).toContain("too large");
  await click(fileButton("new name")); await settle();
  expect(host.querySelector(".changes-diff [role=alert]")!.textContent).toBe("git failed");
  f.diffs["src/a.ts"] = { path: "src/a.ts", status: "M", binary: false, tooLarge: false, text: "" };
  await click(fileButton("src/a.ts")); await settle();
  expect(host.textContent).toContain("No textual changes");
});

test("a list read failure is shown", async () => {
  const f = fake();
  const api = { ...apiOf(f), changes: async () => { throw new Error("not a git repository"); } };
  await act(async () => { root.render(React.createElement(ChangesPanel, { cwd: "/p", busy: false, canComment: true, onComment: () => true, api })); });
  await settle();
  expect(host.querySelector(".changes-error")!.textContent).toBe("not a git repository");
});

test("click selects a line, shift-click extends the range, and the form adds a comment", async () => {
  const added = await mount(fake());
  await click(fileButton("src/a.ts")); await settle();
  await click(gutter("new", 10));
  await click(gutter("new", 12), { shiftKey: true });
  expect(host.querySelectorAll(".changes-line.is-selected")).toHaveLength(3); // new 10, 11 and 12; the removed line between them has no new number
  const form = host.querySelector<HTMLFormElement>(".changes-comment")!;
  expect(form.textContent).toContain("lines 10-12");
  const area = form.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Please rename");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(added).toEqual([{ path: "src/a.ts", startLine: 10, endLine: 12, side: "new", text: "Please rename" }]);
  expect(host.querySelector(".changes-comment")).toBeNull();
});

test("a single old-side line is a one-line comment on the old side", async () => {
  const added = await mount(fake());
  await click(fileButton("src/a.ts")); await settle();
  await click(gutter("old", 11));
  const form = host.querySelector<HTMLFormElement>(".changes-comment")!;
  const area = form.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "why");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(added).toEqual([{ path: "src/a.ts", startLine: 11, endLine: 11, side: "old", text: "why" }]);
});

test("without a session to comment on, the line numbers are not buttons", async () => {
  await mount(fake(), { canComment: false });
  await click(fileButton("src/a.ts")); await settle();
  expect(host.querySelector('[aria-label^="Comment on"]')).toBeNull();
  expect(host.querySelector(".changes-lines")!.textContent).toContain("11");
});

test("the list is read again when a turn ends", async () => {
  const f = fake();
  await mount(f, { busy: true });
  expect(f.reads).toBe(0);
  await mount(f, { busy: false });
  expect(f.reads).toBe(1);
});

test("a shift-click on the other side starts a new range", () => {
  const first = extendSelection(null, "new", 5, false);
  expect(first).toEqual({ side: "new", anchor: 5, start: 5, end: 5 });
  expect(extendSelection(first, "new", 3, true)).toEqual({ side: "new", anchor: 5, start: 3, end: 5 });
  expect(extendSelection(first, "old", 9, true)).toEqual({ side: "old", anchor: 9, start: 9, end: 9 });
});
