import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  localStorage.removeItem("keryx.hub.rail");
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
    // The sidebar project button carries the same title (its collapsed-rail name); the header crumb is the truncating one.
    const name = (await screen.findAllByTitle(project.name)).find((el) => el.classList.contains("truncate"))!;
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
  // The desktop rail toggle is outside mobile navigation.
  expect(document.activeElement!.classList).not.toContain(
    "desktop-rail-toggle",
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});

const css = parseCssRules(readFileSync("src/styles.css", "utf8"));

test("the 60 px rail is available whenever desktop navigation is visible", () => {
  const toggle = css.find((rule) =>
    rule.selector === ".desktop-rail-toggle" && rule.decls.get("display") === "grid",
  );
  const rail = css.find((rule) => rule.selector === ".rail-collapsed .sidebar");
  expect(toggle?.media).toEqual(["@media (min-width:768px)"]);
  expect(rail?.media).toEqual(toggle?.media);
  expect(rail?.decls.get("width")).toBe("60px");
});

test("the sidebar toggle preserves the chosen width across routes and reloads", async () => {
  await act(() => i18n.changeLanguage("en"));
  navigate({ projectId: null, tab: "overview" }, true);
  const view = render(<App />);
  const collapse = await screen.findByRole("button", { name: "Collapse menu" });
  expect(collapse.closest(".sidebar-brand")).not.toBeNull();
  fireEvent.click(collapse);
  const expand = screen.getByRole("button", { name: "Expand menu" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(expand.closest(".app-shell")).toHaveClass("rail-collapsed");

  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Flows" }));
  await screen.findByRole("heading", { name: "All Flows" });
  expect(screen.getByRole("button", { name: "Expand menu" })).toBe(expand);
  view.unmount();
  render(<App />);
  const saved = await screen.findByRole("button", { name: "Expand menu" });
  expect(saved.closest(".app-shell")).toHaveClass("rail-collapsed");
  fireEvent.click(saved);
  expect(screen.getByRole("button", { name: "Collapse menu" }).closest(".app-shell"))
    .not.toHaveClass("rail-collapsed");
});

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
    (rule) => /\.hub-select\b/.test(rule.selector),
  );
  expect(selectRules.length).toBeGreaterThan(0);
  for (const rule of selectRules) {
    expect(rule.decls.has("background")).toBe(false);
    expect(rule.decls.has("background-color")).toBe(false);
  }
  expect(selectRules.some((rule) => rule.decls.has("background-image"))).toBe(true);
});

test("collapsed rail keeps the project switcher as initials and layers its rules", async () => {
  // The collapsed rail hides only the project name text and heading, never the buttons.
  const hiddenRules = css.filter((rule) => rule.selector.includes(".rail-collapsed") && /^none/i.test(rule.decls.get("display") ?? ""));
  const alternatives = hiddenRules.flatMap((rule) => selectorAlternatives(rule.selector));
  expect(alternatives.some((a) => /\.sidebar-projects\s+\.truncate$/.test(a))).toBe(true);
  for (const a of alternatives) expect(a).not.toMatch(/\.sidebar-projects$/);
  // Unlayered author rules beat Tailwind utilities; rail and Select rules stay in @layer components.
  for (const rule of css.filter((r) => r.selector.includes(".rail-collapsed") || /\.hub-select\b/.test(r.selector)))
    expect(rule.layered, rule.selector).toBe(true);

  await act(() => i18n.changeLanguage("en"));
  navigate({ projectId: project.id, tab: "machines" }, true);
  render(<App />);
  const initial = (await screen.findAllByText(project.name.slice(0, 1))).find((el) => el.classList.contains("project-initial"))!;
  const button = initial.closest("button")!;
  expect(button).toHaveAttribute("aria-label", project.name);
  expect(button).toHaveAttribute("title", project.name);
});

test("select chevron reads the muted token and makes no image request", () => {
  // The Hub serves every web asset with `default-src 'self'` and no `img-src`
  // (src/hub/server.ts), so an image request for the chevron is refused and the
  // control shows its reserved space with no arrow. A gradient is not an image
  // request and reads the token directly, so it needs no per-theme copy.
  const select = css.find((r) => /^\.hub-select:not/.test(r.selector) && r.decls.has("background-image"))!;
  const chevron = select.decls.get("background-image")!;
  expect(chevron).toContain("var(--hub-muted)");
  expect(chevron).not.toMatch(/url\(/);
  for (const rule of css)
    for (const property of ["background", "background-image"])
      expect(rule.decls.get(property) ?? "", `${rule.selector} { ${property} }`).not.toMatch(/url\(\s*["']?data:/);
});
