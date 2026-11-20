import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

// Production caches the first host connection. Keep the native mock in its own process.
registerDom();
const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
mockIPC((cmd) => {
  if (cmd === "settings_get") return { keryxSource: "auto", customPath: null, recentProjects: [] };
  throw new Error(`Unexpected host command: ${cmd}`);
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { SettingsView } = await import("../shell/SettingsView");
const { Dialog } = await import("../components/ui");
const { settingsGet } = await import("../platform/commands");
const prefs = await import("../lib/prefs");
const matchMedia = window.matchMedia;
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
const { act } = React;

async function check(scenario: string, run: () => Promise<void>) {
  try {
    await act(() => root.render(null));
    window.matchMedia = matchMedia;
    prefs.setPrefs({ theme: "light", lightPalette: "default", darkPalette: "default" });
    await run();
  } catch (cause) {
    throw new Error(scenario, { cause });
  }
}

async function openSettings(onBack = () => {}) {
  await act(() => root.render(<SettingsView onBack={onBack} integrations={<p>GitHub connector</p>} />));
  // The Settings effect waits for the same lazy native backend connection.
  await act(async () => { await settingsGet(); });
}

function activePanel(): Element {
  const panel = host.querySelector('[role="tabpanel"]:not([hidden])');
  assert.ok(panel);
  return panel;
}

function tab(name: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((el) => el.textContent === name);
  assert.ok(button);
  return button;
}

function radio(name: string) {
  return Array.from(activePanel().querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    .find((el) => el.textContent === name);
}

function key(target: Element, name: string) {
  return act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
}

try {
  await check("Tabs switch by keyboard and keep the Desktop draft", async () => {
    await openSettings();
    assert.deepEqual(Array.from(host.querySelectorAll('[role="tab"]')).map((el) => el.textContent),
      ["Appearance", "Sessions", "Integrations", "Desktop"]);
    await key(tab("Appearance"), "ArrowDown");
    assert.equal(tab("Sessions").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, tab("Sessions"));
    await act(() => tab("Desktop").click());
    const custom = Array.from(activePanel().querySelectorAll<HTMLLabelElement>("label"))
      .find((el) => el.textContent?.includes("Custom executable"));
    assert.ok(custom);
    await act(() => custom.querySelector("input")!.click());
    const executable = 'input[placeholder="/path/to/keryx or a wrapper script"]';
    assert.ok(activePanel().querySelector(executable));
    await act(() => tab("Integrations").click());
    assert.match(activePanel().textContent ?? "", /GitHub connector/);
    await act(() => tab("Desktop").click());
    assert.ok(activePanel().querySelector(executable));
  });

  await check("Close and Escape leave Settings, with initial focus on Close", async () => {
    let closed = 0;
    await openSettings(() => closed++);
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close Settings"]');
    assert.ok(close);
    assert.equal(document.activeElement, close);
    await key(close, "Escape");
    await act(() => close.click());
    assert.equal(closed, 2);
  });

  await check("Escape leaves Settings open while editing a field or dismissing a nested dialog", async () => {
    let closed = 0;
    function Integrations() {
      const [dialog, setDialog] = React.useState(false);
      return <>
        <input aria-label="Account name" />
        <button onClick={() => setDialog(true)}>Open dialog</button>
        {dialog ? <Dialog title="Account sign-in" onClose={() => setDialog(false)}><button>Continue</button></Dialog> : null}
      </>;
    }
    await act(() => root.render(<SettingsView initialTab="integrations" onBack={() => closed++} integrations={<Integrations />} />));
    const input = activePanel().querySelector("input")!;
    await key(input, "Escape");
    await act(() => activePanel().querySelector("button")!.click());
    const dialog = activePanel().querySelector('[role="dialog"]');
    assert.ok(dialog);
    await key(dialog.querySelector("button")!, "Escape");
    assert.equal(activePanel().querySelector('[role="dialog"]'), null);
    assert.equal(closed, 0);
  });

  const light = prefs.PALETTES.find((p) => p.group === "light")!;
  const dark = prefs.PALETTES.find((p) => p.group === "dark")!;
  await check("Palette choices follow display mode without overwriting the other mode", async () => {
    await openSettings();
    assert.equal(radio(dark.label), undefined);
    await act(() => radio(light.label)!.click());
    assert.equal(document.documentElement.dataset.palette, light.id);
    assert.equal(document.documentElement.dataset.theme, "light");
    await act(() => radio("Dark")!.click());
    assert.equal(radio(light.label), undefined);
    await act(() => radio(dark.label)!.click());
    assert.equal(document.documentElement.dataset.palette, dark.id);
    await act(() => radio("Light")!.click());
    assert.equal(radio(light.label)?.getAttribute("aria-checked"), "true");
    assert.equal(document.documentElement.dataset.palette, light.id);
  });

  await check("System updates visible and applied palettes when the OS appearance changes", async () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    window.matchMedia = () => media as unknown as MediaQueryList;
    prefs.setPrefs({ theme: "system", lightPalette: light.id, darkPalette: dark.id });
    const stop = prefs.watchSystemAppearance();
    try {
      await openSettings();
      assert.equal(radio(light.label)?.getAttribute("aria-checked"), "true");
      await act(() => {
        media.matches = true;
        media.dispatchEvent(new Event("change"));
      });
      assert.equal(document.documentElement.dataset.theme, "dark");
      assert.equal(document.documentElement.dataset.palette, dark.id);
      assert.equal(radio(dark.label)?.getAttribute("aria-checked"), "true");
    } finally {
      stop();
    }
  });
} finally {
  await act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
