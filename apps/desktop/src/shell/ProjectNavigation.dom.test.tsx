import { afterAll, beforeAll, expect, test } from "bun:test";
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
        title={view} status={{ tone: "ok", label: "Ready" }} flowsActive={2} activity="idle"
        recents={[]} live={[]} onRemoveProject={noop} onOpenFolder={noop} onSwitchProject={switchProject}
        onNewWindow={noop} onCloseProject={noop} onPalette={noop}>
        <input hidden={view !== "session"} defaultValue="session draft" />
      </AppShell>
    );
  }
  await React.act(() => root.render(<ProjectWindow />));
  const global = host.querySelector('nav[aria-label="Projects and settings"]')!;
  const project = () => host.querySelector("main nav")!;
  const button = (nav: Element, name: string) => Array.from(nav.querySelectorAll("button")).find((b) => b.textContent?.trim() === name)!;
  const click = (b: HTMLButtonElement) => React.act(() => b.click());
  const session = host.querySelector<HTMLInputElement>("main input")!;

  expect(project().getAttribute("aria-label")).toBe("Project views for alpha");
  expect(project().querySelectorAll("button")).toHaveLength(3);
  expect(button(global, "Review")).toBeUndefined();
  expect(button(global, "Flows")).toBeUndefined();
  for (const section of ["Review", "Flows", "Sessions"]) {
    const target = Array.from(project().querySelectorAll("button")).find((b) => b.textContent?.startsWith(section))!;
    await click(target);
    expect(target.getAttribute("aria-current")).toBe("page");
    expect(global.querySelector('[aria-label="alpha"]')!.classList.contains("is-active")).toBe(true);
    expect(host.querySelector("main input")).toBe(session);
    expect(session.hidden).toBe(section !== "Sessions");
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
