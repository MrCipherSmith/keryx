import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";
registerDom();
const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");

type Row = { name: string; path: string; root: string; exists: boolean; gitRepo: boolean; description?: string; stack: string[]; keryxIndex?: string; instructions: string[] };
let projects: Row[] = [
  { name: "vantage-backend", path: "../vantage-backend", root: "/work/vantage-backend", exists: true, gitRepo: true, description: "The Spring Boot platform backend.", stack: ["Java (Maven, Spring Boot)"], instructions: ["CLAUDE.md"] },
];
let picked: string | null = "/work/vantage-frontend";
let nextError: string | null = null;
/** When set, the next `list` waits for it: the first load can then answer after an Add. */
let holdList: Promise<void> | null = null;
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
mockIPC(async (command, args) => {
  const payload = (args ?? {}) as Record<string, unknown>;
  calls.push({ command, args: payload });
  if (command === "plugin:dialog|open") return picked;
  if (command !== "linked_projects") throw new Error("Unexpected command");
  if (nextError) { const message = nextError; nextError = null; throw new Error(message); }
  if (payload.action === "list" && holdList) {
    const snapshot = projects;
    const gate = holdList;
    holdList = null;
    await gate;
    return { ok: true, projectRoot: "/work/synergy", projects: snapshot, warnings: [] };
  }
  if (payload.action === "add") {
    projects = [...projects, { name: "vantage-frontend", path: "../vantage-frontend", root: String(payload.target), exists: true, gitRepo: true, stack: ["Node.js", "React"], keryxIndex: "/work/vantage-frontend/.metaproject/index.md", instructions: [] }];
  }
  if (payload.action === "remove") projects = projects.filter((project) => project.name !== payload.target);
  return { ok: true, projectRoot: "/work/synergy", projects, warnings: [] };
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { LinkedProjectsSettings, linkedProjectFacts } = await import("../project/LinkedProjects");
const { isLinkedProjectsResult } = await import("../platform/linkedProjects");
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
const { act } = React;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
/** Wait, under `act`, until `ready` holds; fail with `what` after two seconds instead of guessing a delay. */
const until = async (what: string, ready: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
};
const text = () => host.textContent ?? "";
const linkedCalls = () => calls.filter(({ command }) => command === "linked_projects").length;
try {
  await act(async () => { root.render(<LinkedProjectsSettings cwd="/work/synergy" />); });
  await until("the first list", () => /vantage-backend/.test(text()));
  assert.deepEqual(calls[0], { command: "linked_projects", args: { cwd: "/work/synergy", action: "list" } });
  assert.match(host.textContent ?? "", /vantage-backend/);
  assert.match(host.textContent ?? "", /The Spring Boot platform backend\./);
  assert.match(host.textContent ?? "", /Java \(Maven, Spring Boot\) · CLAUDE\.md/);

  // Add: a folder from the picker, handed to `keryx ref add` as is.
  await act(async () => { button("Add folder…")?.click(); });
  await until("the added project", () => /vantage-frontend/.test(text()) && button("Add folder…")?.disabled === false);
  assert.ok(calls.some(({ command }) => command === "plugin:dialog|open"));
  assert.deepEqual(calls.at(-1), { command: "linked_projects", args: { cwd: "/work/synergy", action: "add", target: "/work/vantage-frontend" } });
  assert.match(host.textContent ?? "", /vantage-frontend/);
  assert.match(host.textContent ?? "", /Node\.js, React · keryx context/);

  // A cancelled picker changes nothing.
  picked = null;
  const before = calls.length;
  await act(async () => { button("Add folder…")?.click(); });
  await until("the picker to close", () => calls.at(-1)?.command === "plugin:dialog|open" && button("Add folder…")?.disabled === false);
  assert.equal(calls.filter(({ command }) => command === "linked_projects").length, calls.slice(0, before).filter(({ command }) => command === "linked_projects").length);

  // Remove by name; the CLI's refusal is shown, and the list stays.
  nextError = "No linked project matches \"vantage-backend\".";
  await act(async () => { button("Remove vantage-backend")?.click(); });
  await until("the refusal", () => host.querySelector('[role="alert"]') !== null);
  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /No linked project matches/);
  await act(async () => { button("Remove vantage-backend")?.click(); });
  await until("the removal", () => !/Spring Boot platform/.test(text()));
  assert.deepEqual(calls.at(-1), { command: "linked_projects", args: { cwd: "/work/synergy", action: "remove", target: "vantage-backend" } });
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(host.textContent ?? "", /Spring Boot platform/);

  // A slow first load that answers after an Add does not put back the list from before the Add.
  await act(async () => { root.render(<></>); });
  let release!: () => void;
  holdList = new Promise<void>((resolve) => { release = resolve; });
  picked = "/work/vantage-frontend";
  projects = projects.filter((project) => project.name !== "vantage-frontend");
  const listsBefore = linkedCalls();
  await act(async () => { root.render(<LinkedProjectsSettings cwd="/work/synergy" />); });
  await until("the held list call", () => linkedCalls() === listsBefore + 1);
  await act(async () => { button("Add folder…")?.click(); });
  await until("the add during the load", () => /vantage-frontend/.test(text()));
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.match(text(), /vantage-frontend/, "the stale first load overwrote the Add");

  assert.equal(linkedProjectFacts({ name: "x", path: "../x", root: "/x", exists: false, gitRepo: false, stack: [], instructions: [] }), "Folder not found on this machine");
  assert.equal(isLinkedProjectsResult({ projects: [{ name: "x" }], warnings: [] }), false);
  assert.equal(isLinkedProjectsResult({ projects: [], warnings: [] }), true);
} finally {
  await act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
