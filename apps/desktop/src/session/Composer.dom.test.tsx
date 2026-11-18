import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Composer: typeof import("./Composer").Composer;
let createElement: typeof import("react").createElement;
let createRef: typeof import("react").createRef;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  createRef = React.createRef;
  Composer = (await import("./Composer")).Composer;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

function props(sessionId: string | null, ref: import("react").Ref<import("./Composer").ComposerHandle>) {
  return {
    ref,
    sessionId,
    busy: false,
    disabledReason: null,
    commands: [],
    modes: null,
    model: undefined,
    sendKey: "enter" as const,
    onSend: () => true,
    onStop: () => {},
    onMode: () => {},
    onModel: () => {},
  };
}

test("a prefill made with no session is still in the textarea once the session appears", async () => {
  const ref = createRef<import("./Composer").ComposerHandle>();
  await act(() => root.render(createElement(Composer, props(null, ref))));
  await act(async () => ref.current!.setText("from flows"));
  expect(host.querySelector("textarea")!.value).toBe("from flows");

  await act(() => root.render(createElement(Composer, props("A", ref))));
  expect(host.querySelector("textarea")!.value).toBe("from flows");
});
