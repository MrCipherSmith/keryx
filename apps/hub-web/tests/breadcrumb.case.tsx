import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { App, queryClient } from "../src/app/App";
import { resetClient, setAuthLossHandler } from "../src/api/client";
import { navigate } from "../src/app/navigation";
import { useDraftStore } from "../src/state/drafts";
import { parseCssRules, selectorAlternatives } from "./css-rules";
const principal = {
  id: "operator",
  kind: "human",
  role: "operator",
  email: "owner@example.test",
};
const project = {
  id: "p1",
  name: "A project name long enough to need truncation on a 375 px phone header",
  description: "",
  version: 1,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};
function reply(value: unknown, status = 200) {
  return Response.json(value, { status });
}
beforeEach(() => {
  vi.restoreAllMocks();
  setAuthLossHandler(() => undefined);
  resetClient();
  queryClient.clear();
  useDraftStore.getState().clearAll();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/session")) return reply({ principal });
    if (path.endsWith("/projects")) return reply({ projects: [project] });
    return reply({ error: { code: "not-found", message: "Not stubbed" } }, 404);
  });
});
// jsdom has no layout, so this pins the contract the real 375 px browser journeys measure: the Projects control never shrinks or clips
// its label, the long project name is the part that truncates and keeps its full text, and the control stays a keyboard-reachable button.
for (const [language, label] of [
  ["en", "Projects"],
  ["ru", "Проекты"],
] as const)
  test(`the ${language} Projects breadcrumb keeps its whole label and stays keyboard reachable while a long project name truncates`, async () => {
    await act(() => i18n.changeLanguage(language));
    navigate({ projectId: project.id, tab: "machines" }, true);
    render(<App />);
    const name = await screen.findByTitle(project.name);
    const breadcrumb = screen.getByRole("button", { name: label });
    expect(breadcrumb.tagName).toBe("BUTTON");
    expect(breadcrumb).toHaveAttribute("type", "button");
    expect(breadcrumb.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["shrink-0", "whitespace-nowrap"]),
    );
    expect(breadcrumb.className.split(/\s+/)).not.toContain("truncate");
    expect(name.textContent).toBe(project.name);
    expect(name.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-w-0", "truncate"]),
    );
    breadcrumb.focus();
    expect(document.activeElement).toBe(breadcrumb);
    fireEvent.click(breadcrumb);
    await waitFor(() =>
      expect(window.location.search).not.toContain("project=p1"),
    );
  });

test("global navigation opens real flow overview without selecting a project", async () => {
  await act(() => i18n.changeLanguage("en"));
  navigate({ projectId: null, tab: "overview" }, true);
  render(<App />);
  await screen.findByText(principal.email);
  fireEvent.click(screen.getByRole("button", { name: "Flows" }));
  expect(
    await screen.findByRole("heading", { name: "All Flows" }),
  ).toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get("project")).toBeNull();
});
test("mobile navigation Escape returns focus to the opening button", async () => {
  await act(() => i18n.changeLanguage("en"));
  navigate({ projectId: null, tab: "overview" }, true);
  render(<App />);
  await screen.findByText(principal.email);
  const opener = screen.getByRole("button", { name: "Open navigation" });
  fireEvent.click(opener);
  const nav = screen.getByRole("navigation");
  await waitFor(() => expect(nav.contains(document.activeElement)).toBe(true));
  // The rail toggle is display:none below 1024px; focus must not land on it.
  expect(document.activeElement!.classList).not.toContain(
    "desktop-rail-toggle",
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});

const css = parseCssRules(readFileSync("src/styles.css", "utf8"));

test("collapsed rail keeps an icon-only Sign out reachable", async () => {
  await act(() => i18n.changeLanguage("en"));
  navigate({ projectId: null, tab: "overview" }, true);
  render(<App />);
  await screen.findByText(principal.email);
  const signOut = screen.getByRole("button", { name: "Sign out" });
  expect(signOut.querySelector(".nav-label")).not.toBeNull();
  expect(signOut).toHaveAttribute("title", "Sign out");
  // No collapsed-rail rule may hide the identity block or its button; only the
  // text children (.nav-label, .identity > p) are hidden.
  const hidden = css
    .filter((rule) => rule.selector.includes(".rail-collapsed"))
    .filter(
      (rule) =>
        /^none(\s*!important)?$/i.test(rule.decls.get("display") ?? "") ||
        /^hidden(\s*!important)?$/i.test(rule.decls.get("visibility") ?? ""),
    )
    .flatMap((rule) => selectorAlternatives(rule.selector));
  expect(hidden.length).toBeGreaterThan(0);
  for (const alternative of hidden) {
    expect(alternative).not.toMatch(/\.identity(\s*>\s*\*)?$/);
    expect(alternative).not.toMatch(/\.hub-button$/);
  }
});

test("hub-select chevron rule leaves background-color to the layered disabled fill", () => {
  const selectRules = css.filter(
    (rule) => !rule.layered && /\.hub-select\b/.test(rule.selector),
  );
  expect(selectRules.length).toBeGreaterThan(0);
  for (const rule of selectRules) {
    expect(rule.decls.has("background")).toBe(false);
    expect(rule.decls.has("background-color")).toBe(false);
  }
  expect(selectRules.some((rule) => rule.decls.has("background-image"))).toBe(true);
});
