import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { ConfigOption } from "../acp/types";
import { registerDom, unregisterDom } from "../test/dom";
let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Composer: typeof import("./Composer").Composer;
let createElement: typeof import("react").createElement;
beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Composer = (await import("./Composer")).Composer;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});
const opt = (provider: string, model: string) => ({ value: `${provider}/${model}`, name: model, description: provider });
const modelOption = (current: string, options = [opt("anthropic", "sonnet"), opt("anthropic", "opus"), opt("grok", "grok-4")]): ConfigOption =>
  ({ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options }) as unknown as ConfigOption;

function mount(calls: string[]) {
  return (m: ConfigOption) =>
    root.render(
      createElement(Composer, {
        sessionId: "s1",
        busy: false,
        disabledReason: null,
        commands: [],
        modes: null,
        model: m,
        sendKey: "enter",
        onSend: () => true,
        onStop: () => {},
        onMode: () => {},
        onModel: (id: string, v: string) => calls.push(`${id}=${v}`),
        onProviders: () => calls.push("providers"),
      }),
    );
}
const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
const names = () => items().map((e) => (e.textContent ?? "").replace(/\s+/g, ""));
const click = (el: Element) => act(() => (el as HTMLElement).click());
const providerChip = () => host.querySelector<HTMLElement>('button[aria-label="Provider"]')!;
const modelChip = () => host.querySelector<HTMLElement>('button[title="Model for this session"]')!;

test("providers come from the model options; the last item opens the providers dialog", async () => {
  const calls: string[] = [];
  await act(() => mount(calls)(modelOption("anthropic/sonnet")));
  expect(providerChip().textContent).toContain("anthropic");
  await click(providerChip());
  expect(names()).toEqual(["anthropic", "grok", "Addormanageproviders…"]);
  await click(items()[2]!);
  expect(calls).toEqual(["providers"]);
});

test("choosing a provider switches model (first, then the remembered one) and the model menu is narrowed", async () => {
  const calls: string[] = [];
  const render = mount(calls);
  await act(() => render(modelOption("anthropic/opus")));
  await click(modelChip());
  expect(names().length).toBe(2);
  expect(names().some((n) => n.startsWith("grok-4"))).toBe(false);
  await click(modelChip()); // toggle closed
  await click(providerChip());
  await click(items().find((e) => e.textContent?.includes("grok"))!);
  expect(calls).toEqual(["model=grok/grok-4"]);
  await act(() => render(modelOption("grok/grok-4")));
  await click(providerChip());
  await click(items().find((e) => e.textContent?.includes("anthropic"))!);
  expect(calls.at(-1)).toBe("model=anthropic/opus"); // last used, not the first
});

test("a config_option_update refreshes the selector; a lone provider is still listed", async () => {
  const calls: string[] = [];
  const render = mount(calls);
  await act(() => render(modelOption("anthropic/sonnet", [opt("anthropic", "sonnet")])));
  await click(providerChip());
  expect(names()).toEqual(["anthropic", "Addormanageproviders…"]);
});
