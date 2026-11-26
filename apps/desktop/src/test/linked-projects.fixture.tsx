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
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
mockIPC((command, args) => {
  const payload = (args ?? {}) as Record<string, unknown>;
  calls.push({ command, args: payload });
  if (command === "plugin:dialog|open") return picked;
  if (command !== "linked_projects") throw new Error("Unexpected command");
  if (nextError) { const message = nextError; nextError = null; throw new Error(message); }
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
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5)); });
try {
  await act(async () => { root.render(<LinkedProjectsSettings cwd="/work/synergy" />); });
  await settle();
  assert.deepEqual(calls[0], { command: "linked_projects", args: { cwd: "/work/synergy", action: "list" } });
  assert.match(host.textContent ?? "", /vantage-backend/);
  assert.match(host.textContent ?? "", /The Spring Boot platform backend\./);
  assert.match(host.textContent ?? "", /Java \(Maven, Spring Boot\) · CLAUDE\.md/);

  // Add: a folder from the picker, handed to `keryx ref add` as is.
  await act(async () => { button("Add folder…")?.click(); });
  await settle();
  assert.ok(calls.some(({ command }) => command === "plugin:dialog|open"));
  assert.deepEqual(calls.at(-1), { command: "linked_projects", args: { cwd: "/work/synergy", action: "add", target: "/work/vantage-frontend" } });
  assert.match(host.textContent ?? "", /vantage-frontend/);
  assert.match(host.textContent ?? "", /Node\.js, React · keryx context/);

  // A cancelled picker changes nothing.
  picked = null;
  const before = calls.length;
  await act(async () => { button("Add folder…")?.click(); });
  await settle();
  assert.equal(calls.filter(({ command }) => command === "linked_projects").length, calls.slice(0, before).filter(({ command }) => command === "linked_projects").length);

  // Remove by name; the CLI's refusal is shown, and the list stays.
  nextError = "No linked project matches \"vantage-backend\".";
  await act(async () => { button("Remove vantage-backend")?.click(); });
  await settle();
  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /No linked project matches/);
  await act(async () => { button("Remove vantage-backend")?.click(); });
  await settle();
  assert.deepEqual(calls.at(-1), { command: "linked_projects", args: { cwd: "/work/synergy", action: "remove", target: "vantage-backend" } });
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(host.textContent ?? "", /Spring Boot platform/);

  assert.equal(linkedProjectFacts({ name: "x", path: "../x", root: "/x", exists: false, gitRepo: false, stack: [], instructions: [] }), "Folder not found on this machine");
  assert.equal(isLinkedProjectsResult({ projects: [{ name: "x" }], warnings: [] }), false);
  assert.equal(isLinkedProjectsResult({ projects: [], warnings: [] }), true);
} finally {
  await act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
