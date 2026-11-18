import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { ProviderInfo } from "../acp/providers";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let WikiEnrichDialog: typeof import("./WikiEnrichDialog").WikiEnrichDialog;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  WikiEnrichDialog = (await import("./WikiEnrichDialog")).WikiEnrichDialog;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const provider = (id: string, connected: boolean): ProviderInfo => ({ id, label: id, connected, authMethods: ["api-key"], needsBaseUrl: false });

async function open(onRun: (args: string[], title: string) => void, onClose = () => {}) {
  const listProviders = async () => [provider("anthropic", true), provider("openai", false)];
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(WikiEnrichDialog, { listProviders, onRun, onClose })));
  await act(async () => {});
}

const button = (text: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text)!;
const radio = (label: string) =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.closest("label")?.textContent?.startsWith(label))!;

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

test("Run sends the waves command with the chosen settings and closes", async () => {
  const runs: Array<[string[], string]> = [];
  let closed = false;
  await open((a, t) => runs.push([a, t]), () => (closed = true));
  expect(document.querySelector('[aria-label="Command"]')?.textContent).toBe(
    "keryx wiki enrich --all --group related --group-size 10-20 --concurrency 4",
  );
  // Only connected providers are offered, after the default.
  const select = document.querySelector("select")!;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "anthropic"]);
  await act(async () => setValue(select, "anthropic"));
  await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Largest group"]')!, "12"));
  await act(async () => radio("All pages").click());
  await act(async () => button("Run").click());
  expect(runs).toEqual([
    [["wiki", "enrich", "--all", "--force", "--group", "related", "--group-size", "10-12", "--concurrency", "4", "--provider", "anthropic"], "wiki enrich"],
  ]);
  expect(closed).toBe(true);
});

test("one job hides the group fields; external workers are disabled; bad numbers block Run", async () => {
  await open(() => {});
  expect(radio("External agents").disabled).toBe(true);
  await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Smallest group"]')!, "30"));
  expect(button("Run").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/smallest group/);
  await act(async () => radio("One job").click());
  expect(document.querySelector('input[aria-label="Smallest group"]')).toBeNull();
  expect(button("Run").disabled).toBe(false);
  expect(document.querySelector('[aria-label="Command"]')?.textContent).toBe("keryx wiki enrich --all");
});
