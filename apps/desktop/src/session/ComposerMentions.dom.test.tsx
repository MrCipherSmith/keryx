import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { AvailableCommand } from "../acp/types";
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

const COMMANDS: AvailableCommand[] = [
  { name: "tasks", description: "Tasks", input: null, _meta: { keryx: { group: "Work", surface: "text", busy: "run" } } },
];

const calls: string[] = [];
let respond: (q: string) => Promise<string[]> = async () => [];
const searchFiles = (q: string) => {
  calls.push(q);
  return respond(q);
};

const sent: string[] = [];
function mount(over: Partial<import("react").ComponentProps<typeof Composer>> = {}) {
  return act(() =>
    root.render(
      createElement(Composer, {
        sessionId: "m1",
        busy: false,
        disabledReason: null,
        commands: COMMANDS,
        modes: null,
        model: undefined,
        sendKey: "enter",
        onSend: (t: string) => {
          sent.push(t);
          return true;
        },
        onStop: () => {},
        onMode: () => {},
        onModel: () => {},
        searchFiles,
        ...over,
      }),
    ),
  );
}

const area = () => host.querySelector("textarea")!;

async function type(value: string, caret = value.length) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(area(), value);
    area().setSelectionRange(caret, caret);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 160));
  });
}

async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

const options = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
const labels = () => options().map((o) => o.textContent);

const FILES = ["src/spec.ts", "docs/spec.md", "README.md"];

test("@spec opens file options and typing narrows with the query passed on", async () => {
  calls.length = 0;
  respond = async (q) => FILES.filter((f) => f.includes(q));
  await mount();
  await type("@spec");
  await settle();
  expect(calls).toEqual(["spec"]);
  expect(host.querySelector('[aria-label="File mentions"]')).not.toBeNull();
  expect(labels()).toEqual(["@src/spec.ts", "@docs/spec.md"]);
  await type("@spec.m");
  await settle();
  expect(calls).toEqual(["spec", "spec.m"]);
  expect(labels()).toEqual(["@docs/spec.md"]);
});

test("ArrowDown then Enter inserts the path with a trailing space and puts the caret after it", async () => {
  respond = async (q) => FILES.filter((f) => f.includes(q));
  await mount();
  await type("@spec");
  await settle();
  await key("ArrowDown");
  await key("Enter");
  expect(area().value).toBe("@docs/spec.md ");
  expect(area().selectionStart).toBe("@docs/spec.md ".length);
  expect(options()).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

test("Tab inserts the first option", async () => {
  await mount();
  await type("@spec");
  await settle();
  await key("Tab");
  expect(area().value).toBe("@src/spec.ts ");
});

test("Escape closes the popup", async () => {
  await mount();
  await type("@spec");
  await settle();
  expect(options().length).toBeGreaterThan(0);
  await key("Escape");
  expect(options()).toHaveLength(0);
});

test("a mention in the middle of the text is replaced in place", async () => {
  respond = async () => ["src/main.ts"];
  await mount();
  const text = "look at @sr and more";
  await type(text, "look at @sr".length);
  await settle();
  expect(labels()).toEqual(["@src/main.ts"]);
  await key("Enter");
  expect(area().value).toBe("look at @src/main.ts  and more");
  expect(area().selectionStart).toBe("look at @src/main.ts ".length);
});

test("an email-like a@b does not trigger a search", async () => {
  calls.length = 0;
  respond = async () => ["x.ts"];
  await mount();
  await type("write to a@b");
  await settle();
  expect(calls).toEqual([]);
  expect(options()).toHaveLength(0);
});

test("a stale response is dropped", async () => {
  const pending = new Map<string, (r: string[]) => void>();
  respond = (q) => new Promise((res) => pending.set(q, res));
  await mount();
  await type("@a");
  await settle();
  await type("@ab");
  await settle();
  await act(async () => {
    pending.get("ab")!(["ab.ts"]);
  });
  await act(async () => {
    pending.get("a")!(["a-old.ts"]);
  });
  expect(labels()).toEqual(["@ab.ts"]);
});

test("no results or a failing search shows no popup", async () => {
  respond = async () => [];
  await mount();
  await type("@zzz");
  await settle();
  expect(options()).toHaveLength(0);
  respond = async () => {
    throw new Error("boom");
  };
  await type("@zzzz");
  await settle();
  expect(options()).toHaveLength(0);
});

test("slash mode is unaffected and Enter sends when there are no matches", async () => {
  calls.length = 0;
  sent.length = 0;
  respond = async () => ["x.ts"];
  await mount();
  await type("/ta");
  await settle();
  expect(calls).toEqual([]);
  expect(host.querySelector('[aria-label="Slash commands"]')).not.toBeNull();
  expect(options().map((o) => o.querySelector(".slash-name")!.textContent)).toEqual(["/tasks"]);
  await type("hello");
  await key("Enter");
  expect(sent).toEqual(["hello"]);
});
