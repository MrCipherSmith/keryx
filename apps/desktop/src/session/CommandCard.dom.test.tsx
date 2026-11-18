import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { CommandView } from "../acp/types";
import type { CommandItem } from "./reducer";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let CommandCard: typeof import("./CommandCard").CommandCard;
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  CommandCard = (await import("./CommandCard")).CommandCard;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const item = (over: Partial<CommandItem> = {}): CommandItem => ({ kind: "command", id: 7, line: "/schedules", text: "", refused: false, view: null, ...over });

type Run = Array<{ line: string; opts: { display?: string; replaceId: number } }>;
let renders = 0;
async function render(it: CommandItem) {
  const runs: Run = [];
  const onRun = (line: string, opts: { display?: string; replaceId: number }) => {
    runs.push({ line, opts });
  };
  await act(() => root.render(createElement(CommandCard, { key: ++renders, item: it, onRun })));
  return runs;
}

const click = (el: Element) => act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label)!;
const setValue = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const VIEW: CommandView = {
  title: "Schedules",
  body: "2 schedules",
  rows: [
    {
      id: "s1",
      label: "nightly review",
      detail: "every night",
      status: "paused",
      actions: [
        { label: "Resume", command: "/schedules resume s1" },
        { label: "Delete", command: "/schedules delete s1", confirm: "Delete nightly review?" },
      ],
    },
  ],
};

test("a text card shows the line and output and collapses", async () => {
  await render(item({ line: "/tasks", text: "t1 running" }));
  expect(host.querySelector(".command-line")!.textContent).toBe("/tasks");
  expect(host.querySelector("pre")!.textContent).toBe("t1 running");
  await click(host.querySelector(".command-head")!);
  expect(host.querySelector("pre")).toBeNull();
});

test("a card with a view shows the view, not keryx's plain-text rendering of it", async () => {
  await render(item({ text: "Schedules\n\nnightly review (paused)", view: VIEW }));
  expect(host.textContent).not.toContain("nightly review (paused)");
  expect(host.textContent).toContain("nightly review");
});

test("a refused card is a notice", async () => {
  await render(item({ line: "/rewind", text: "Not while a turn runs", refused: true }));
  expect(host.querySelector(".notice.notice-warn")!.textContent).toContain("Not while a turn runs");
  expect(host.querySelector("pre")).toBeNull();
});

test("a view renders title, rows, status, body; an action sends its command replacing this card", async () => {
  const runs = await render(item({ view: VIEW }));
  expect(host.querySelector(".command-view-title")!.textContent).toBe("Schedules");
  expect(host.querySelector(".command-row-label")!.textContent).toBe("nightly review");
  expect(host.textContent).toContain("paused");
  expect(host.textContent).toContain("2 schedules");
  await click(button("Resume"));
  expect(runs).toEqual([{ line: "/schedules resume s1", opts: { display: undefined, replaceId: 7 } }]);
});

test("an action with confirm asks first and sends only after the user confirms", async () => {
  const runs = await render(item({ view: VIEW }));
  await click(button("Delete"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Delete nightly review?");
  expect(runs).toHaveLength(0);
  // Cancel sends nothing.
  await click(button("Cancel"));
  expect(runs).toHaveLength(0);
  await click(button("Delete"));
  const confirmBtn = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === "Delete")!;
  await click(confirmBtn);
  expect(runs.map((r) => r.line)).toEqual(["/schedules delete s1"]);
});

test("a form submit fills the template; a secret is a password input and is masked in the shown line", async () => {
  const form: CommandView = {
    title: "Connect",
    form: {
      submit: "/connect {provider} {key}",
      submitLabel: "Connect",
      fields: [
        { id: "provider", label: "Provider", kind: "text" },
        { id: "key", label: "API key", kind: "secret" },
      ],
    },
  };
  const runs = await render(item({ line: "/connect", view: form }));
  const inputs = Array.from(host.querySelectorAll("input"));
  expect(inputs[1]!.getAttribute("type")).toBe("password");
  await setValue(inputs[0]!, "openai");
  await setValue(inputs[1]!, "sk-live-123");
  await click(button("Connect"));
  expect(runs).toHaveLength(1);
  expect(runs[0]!.line).toBe("/connect openai sk-live-123");
  expect(runs[0]!.opts.display).toBe("/connect openai ••••••");
  expect(runs[0]!.opts.display!.includes("sk-live-123")).toBe(false);
  // The secret does not linger in the form, and the page never shows it.
  expect((host.querySelectorAll("input")[1] as HTMLInputElement).value).toBe("");
  expect(host.textContent!.includes("sk-live-123")).toBe(false);
});

test("a masked line from a secret submit is what the card shows", async () => {
  await render(item({ line: "/connect openai ••••••", text: "connected" }));
  expect(host.querySelector(".command-line")!.textContent).toBe("/connect openai ••••••");
});

test("a form with required fields keeps Submit disabled until each is filled, and sends a prefilled value", async () => {
  const form: CommandView = {
    title: "Schedule",
    form: {
      submit: "/schedule --name {name} --ceiling {ceiling}",
      fields: [
        { id: "name", label: "Name", kind: "text", required: true, placeholder: "e.g. nightly" },
        { id: "ceiling", label: "Ceiling", kind: "text", required: true, value: "0.50" },
        { id: "note", label: "Note", kind: "text" },
      ],
    },
  };
  const runs = await render(item({ line: "/schedule", view: form }));
  const inputs = Array.from(host.querySelectorAll("input"));
  expect(inputs[0]!.getAttribute("placeholder")).toBe("e.g. nightly");
  expect(inputs[1]!.value).toBe("0.50");
  const submit = button("Submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(host.querySelector(".field-hint")!.textContent).toContain("Name");
  await setValue(inputs[0]!, "   ");
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(true);
  await setValue(inputs[0]!, "nightly");
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(false);
  expect(host.querySelector(".field-hint")).toBeNull();
  await click(button("Submit"));
  expect(runs.map((r) => r.line)).toEqual(["/schedule --name nightly --ceiling 0.50"]);
});

test("showWhen hides and shows fields; a hidden field is not required, not validated and not sent", async () => {
  const form: CommandView = {
    title: "Schedule",
    form: {
      submit: '/schedule --repeat {repeat} --minutes {minutes} --at {at} --cron "{cron}" --ceiling {ceiling}',
      fields: [
        { id: "repeat", label: "Repeat", kind: "choice", required: true, options: [{ value: "minutes", label: "every N minutes" }, { value: "daily", label: "daily" }, { value: "cron", label: "cron (advanced)" }], value: "minutes" },
        { id: "minutes", label: "Every (minutes)", kind: "choice", required: true, options: ["5", "10", "30"], value: "30", showWhen: { field: "repeat", equals: ["minutes"] } },
        { id: "at", label: "At", kind: "time", required: true, showWhen: { field: "repeat", equals: ["daily"] } },
        { id: "cron", label: "Cron", kind: "text", required: true, showWhen: { field: "repeat", equals: ["cron"] } },
        { id: "ceiling", label: "Ceiling", kind: "number", required: true, min: 0.01, value: "0.50", error: "Enter an amount above 0" },
      ],
    },
  };
  const runs = await render(item({ line: "/schedule", view: form }));
  const labels = () => Array.from(host.querySelectorAll(".field-label")).map((l) => l.textContent!.replace(" *", ""));
  expect(labels()).toEqual(["Repeat", "Every (minutes)", "Ceiling"]);
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(false);
  await click(button("Submit"));
  expect(runs.map((r) => r.line)).toEqual(["/schedule --repeat minutes --minutes 30 --ceiling 0.50"]);

  const repeat = host.querySelector("select#cf-repeat") as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(repeat, "daily");
    repeat.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(labels()).toEqual(["Repeat", "At", "Ceiling"]);
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(true);
  const at = host.querySelector("#cf-at") as HTMLInputElement;
  await setValue(at, "25:99");
  expect(host.querySelector("#cf-at-error")!.textContent).toBe("Use HH:MM, 00:00-23:59");
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(true);
  await setValue(at, "08:30");
  expect(host.querySelector("#cf-at-error")).toBeNull();
  await click(button("Submit"));
  expect(runs.at(-1)!.line).toBe("/schedule --repeat daily --at 08:30 --ceiling 0.50");
});

test("number fields say what is wrong inline and keep Submit disabled until valid", async () => {
  const form: CommandView = {
    title: "Schedule",
    form: {
      submit: "/schedule --rate-in {rateIn} --ceiling {ceiling}",
      fields: [
        { id: "rateIn", label: "Input $/1M", kind: "number", required: true, min: 0 },
        { id: "ceiling", label: "Ceiling", kind: "number", required: true, min: 0.01, value: "0.50", error: "Enter an amount above 0" },
      ],
    },
  };
  await render(item({ line: "/schedule", view: form }));
  const rate = host.querySelector("#cf-rateIn") as HTMLInputElement;
  const ceiling = host.querySelector("#cf-ceiling") as HTMLInputElement;
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(true);
  await setValue(rate, "ten");
  expect(host.querySelector("#cf-rateIn-error")!.textContent).toBe("Enter a number");
  await setValue(rate, "10");
  expect(host.querySelector("#cf-rateIn-error")).toBeNull();
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(false);
  await setValue(ceiling, "0");
  expect(host.querySelector("#cf-ceiling-error")!.textContent).toBe("Enter an amount above 0");
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(true);
});

test("a form that says it is disabled shows the reason and cannot be submitted", async () => {
  const form: CommandView = { title: "Schedule", form: { submit: "/schedule", fields: [], disabled: "Connect a provider first." } };
  const runs = await render(item({ line: "/schedule", view: form }));
  expect(host.textContent).toContain("Connect a provider first.");
  expect((button("Submit") as HTMLButtonElement).disabled).toBe(true);
  expect(runs).toHaveLength(0);
});
