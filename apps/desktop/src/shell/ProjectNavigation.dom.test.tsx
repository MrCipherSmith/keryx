import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { View } from "./AppShell";

let root: Root;
let host: HTMLElement;
let React: typeof import("react");
let AppShell: typeof import("./AppShell").AppShell;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  AppShell = (await import("./AppShell")).AppShell;
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterAll(async () => {
  await React.act(() => root.unmount());
  await unregisterDom();
});

test("the current project owns Sessions, Flows and Review while Settings stays global", async () => {
  function ProjectWindow() {
    const [cwd, switchProject] = React.useState("/dev/alpha");
    const [view, onView] = React.useState<View>("session");
    const noop = () => {};
    return (
      <AppShell cwd={cwd} projects={["/dev/alpha", "/dev/beta"]} view={view} onView={onView}
        onOpenSourceIssue={() => onView("issues")} title={view} status={{ tone: "ok", label: "Ready" }} flowsActive={2} activity="idle"
        recents={[]} live={[]} onRemoveProject={noop} onOpenFolder={noop} onSwitchProject={switchProject}
        onNewWindow={noop} onCloseProject={noop} onPalette={noop}>
        <span>{view}</span>
      </AppShell>
    );
  }
  await React.act(() => root.render(<ProjectWindow />));
  const left = host.querySelector(".titlebar-left")!;
  expect(left.querySelector(".project-switcher")?.nextElementSibling?.textContent).toBe("session");
  expect(left.querySelector(".titlebar-title")?.hasAttribute("data-tauri-drag-region")).toBe(true);
  const origin = host.querySelector<HTMLButtonElement>('.titlebar-right > button[aria-label="Open source issue"]')!;
  expect(left.contains(origin)).toBe(false);
  expect(origin.hasAttribute("data-tauri-drag-region")).toBe(false);
  await React.act(() => origin.click());
  expect(host.querySelector('main nav [aria-current="page"]')?.textContent).toContain("Issues");
  expect(host.querySelector('button[aria-label="Open source issue"]')).toBeNull();
  const status = host.querySelector('.titlebar-right > [role="status"]')!;
  expect(status.textContent).toBe("Ready");
  expect(status.previousElementSibling?.getAttribute("aria-label")).toBe("Commands and sessions");
  expect(status.nextElementSibling).toBeNull();
  const global = host.querySelector('nav[aria-label="Projects and settings"]')!;
  const project = () => host.querySelector("main nav")!;
  const button = (nav: Element, name: string) => Array.from(nav.querySelectorAll("button")).find((b) => b.textContent?.trim() === name)!;
  const click = (b: HTMLButtonElement) => React.act(() => b.click());

  expect(project().getAttribute("aria-label")).toBe("Project views for alpha");
  expect(project().querySelectorAll("button")).toHaveLength(5);
  const globalButtons = [...global.querySelectorAll("button")];
  for (const section of ["Metaproject", "Issues", "Pull requests", "Flows"]) {
    expect(globalButtons.some(b => b.getAttribute("aria-label") === section || b.textContent?.trim().startsWith(section))).toBe(false);
  }
  for (const section of ["Metaproject", "Issues", "Pull requests", "Flows", "Sessions"]) {
    const target = Array.from(project().querySelectorAll("button")).find((b) => b.textContent?.startsWith(section))!;
    await click(target);
    expect(target.getAttribute("aria-current")).toBe("page");
    expect(global.querySelector('[aria-label="alpha"]')!.classList.contains("is-active")).toBe(true);
  }
  await click(button(global, "Settings"));
  expect(project()).toBeNull();
  expect(button(global, "Settings").getAttribute("aria-current")).toBe("page");
  await click(global.querySelector<HTMLButtonElement>('[aria-label="alpha"]')!);
  expect(button(project(), "Sessions").getAttribute("aria-current")).toBe("page");
  await click(global.querySelector<HTMLButtonElement>('[aria-label="beta"]')!);
  expect(project().getAttribute("aria-label")).toBe("Project views for beta");
  expect(global.querySelector('[aria-label="beta"]')!.getAttribute("aria-current")).toBe("true");
});


test("App preserves tab state and starts a background review from the originating session; AC16 a PR without Flow and review opens one bound session whose /review run shows on the card", () => {
  const fixture = fileURLToPath(new URL("../test/app-navigation.fixture.tsx", import.meta.url));
  execFileSync(process.execPath, [fixture], { timeout: 8000, stdio: "pipe" });
});

test("AC9 Create Flow in the App: the bound session gets the flow prompt, the one new package is linked and shown on the card, two link none; AC12 an Issue card counts its bound session", () => {
  const fixture = fileURLToPath(new URL("../test/app-work-row.fixture.tsx", import.meta.url));
  execFileSync(process.execPath, [fixture], { timeout: 8000, stdio: "pipe" });
});

test("AC10 a cold-loaded issue session admits every restored question on one coordinator turn", () => {
  const fixture = fileURLToPath(new URL("../test/issue-question-resume.fixture.tsx", import.meta.url));
  execFileSync(process.execPath, [fixture], { timeout: 8000, stdio: "pipe" });
});
