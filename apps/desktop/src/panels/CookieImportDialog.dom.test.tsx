import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let React: typeof import("react");
let mod: typeof import("./CookieImportDialog");

const imports: Array<[string, string[]]> = [];
const fake = {
  cookieProfiles: async () => [
    { dir: "Default", name: "Personal" },
    { dir: "Profile 1", name: "Work" },
  ],
  cookieScan: async (profile: string) =>
    profile === "Default"
      ? [
          { domain: "github.com", count: 12 },
          { domain: "localhost", count: 3 },
          { domain: "bank.example", count: 40 },
        ]
      : [{ domain: "jira.work", count: 5 }],
  cookieImport: async (profile: string, domains: string[]) => {
    imports.push([profile, domains]);
    return { imported: 14, skipped: 1, domains };
  },
};

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  mod = await import("./CookieImportDialog");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const button = (re: RegExp) => Array.from(document.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""))!;
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(".cookie-list input[type=checkbox]"));

test("on WebKit it only says the import needs Chromium", async () => {
  await act(() => root.render(React.createElement(mod.CookieImportDialog, { cwd: "/p", engine: "webkit", onClose: () => {}, host: fake })));
  expect(document.body.textContent).toContain("Chromium browser engine only");
  expect(document.querySelector(".cookie-list")).toBeNull();
});

test("nothing is picked by default; only the picked domains are imported, and the pick is kept for re-import", async () => {
  localStorage.clear();
  await act(() => root.render(React.createElement(mod.CookieImportDialog, { cwd: "/p", engine: "chromium", onClose: () => {}, host: fake })));
  await act(flush);
  await act(flush);
  expect(boxes().map((b) => b.checked)).toEqual([false, false, false]);
  expect(document.body.textContent).toContain("not a sync");
  expect(button(/Import/).disabled).toBe(true);

  await act(async () => boxes()[0]!.click());
  await act(async () => boxes()[1]!.click());
  expect(document.body.textContent).toContain("2 picked, 15 cookies");
  await act(async () => button(/Import 2 domains/).click());
  await act(flush);
  expect(imports).toEqual([["Default", ["github.com", "localhost"]]]);
  expect(document.body.textContent).toContain("Imported 14 cookies, left out 1");
  expect(mod.loadLastImport("/p")?.domains).toEqual(["github.com", "localhost"]);

  // Opening again offers the same sites for a re-import.
  await act(() => root.render(React.createElement("div")));
  await act(() => root.render(React.createElement(mod.CookieImportDialog, { cwd: "/p", engine: "chromium", onClose: () => {}, host: fake })));
  await act(flush);
  await act(flush);
  expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
  expect(button(/Re-import/) !== undefined).toBe(true);
});

test("the filter narrows the list", () => {
  const list = [
    { domain: "github.com", count: 2 },
    { domain: "gitlab.com", count: 1 },
    { domain: "example.org", count: 5 },
  ];
  expect(mod.filterDomains(list, " GIT").map((d) => d.domain)).toEqual(["github.com", "gitlab.com"]);
  expect(mod.filterDomains(list, "")).toHaveLength(3);
});
