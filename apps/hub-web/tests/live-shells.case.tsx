import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { LiveShellDelivery, LiveShellDetail, LiveShellSummary } from "../../../src/remote-control/live-shell";
import { resetClient } from "../src/api/client";
import type { HubContextValue } from "../src/app/hub-context";
import { LiveShells } from "../src/features/remote/live-shells";
import i18n from "../src/i18n";
import { useDraftStore } from "../src/state/drafts";
import { renderHub } from "./hub-render";

const projectId = "p";
const listPath = "/hub/v2/projects/p/live-shells";
const shell: LiveShellSummary = {
  id: "shell", title: "Terminal conversation", machineName: "geekom",
  checkoutId: "fixture", busy: false, stopTurnId: null,
};
const context: HubContextValue = {
  projectId, scopeKey: 1,
  principal: { id: "human:test", kind: "human", role: "operator" },
  location: { tab: "sessions", projectId },
  navigate: () => undefined, refresh: async () => undefined,
};

let detail: LiveShellDetail;
let sends: string[];
let reads: (string | null)[];
let releases: number;
let loseReceipt: boolean;
let messageStatus: LiveShellDelivery["status"];
let operations: Map<string, LiveShellDelivery>;
let claims: string[];
let owner: string | null;
let stops: { key: string; turnId: string }[];

beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  await i18n.changeLanguage("en");
  detail = {
    shell, controllerHeld: false, delivery: null,
    messages: [{ role: "user", text: "Already said in the terminal" }, { role: "assistant", text: "Previously answered here" }],
  };
  sends = [];
  reads = [];
  releases = 0;
  loseReceipt = false;
  messageStatus = "applied";
  operations = new Map();
  claims = [];
  owner = null;
  stops = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "https://hub.invalid");
    const path = url.pathname;
    if (path === listPath) return Response.json({ shells: [detail.shell] });
    if (path === listPath + "/shell") {
      const id = url.searchParams.get("operationId");
      reads.push(id);
      return Response.json({ ...detail, controllerHeld: !!owner, delivery: id ? operations.get(id) ?? null : detail.delivery });
    }
    const body = JSON.parse(String(init?.body)) as { clientId: string; text?: string; turnId?: string };
    if (path === listPath + "/shell/claim") {
      claims.push(body.clientId);
      if (owner && owner !== body.clientId) return Response.json({ error: { code: "controller-conflict" } }, { status: 409 });
      owner = body.clientId;
      return Response.json({ ok: true });
    }
    if (path === listPath + "/shell/release") {
      releases++;
      if (owner === body.clientId) owner = null;
      return Response.json({ ok: true });
    }
    if (path === listPath + "/shell/message") {
      if (owner !== body.clientId) return Response.json({ error: { code: "controller-conflict" } }, { status: 409 });
      const key = new Headers(init?.headers).get("Idempotency-Key")!;
      const operationId = "operation-" + key;
      if (!operations.has(operationId)) {
        detail.delivery = { id: operationId, kind: "message", status: messageStatus };
        operations.set(operationId, detail.delivery);
        if (messageStatus === "applied") detail.messages = [...detail.messages, { role: "user", text: body.text! }];
      }
      sends.push(key);
      if (loseReceipt && sends.length === 1) throw new TypeError("connection lost after acceptance");
      return Response.json({ operationId });
    }
    if (path === listPath + "/shell/stop") {
      const key = new Headers(init?.headers).get("Idempotency-Key")!;
      stops.push({ key, turnId: body.turnId! });
      const operationId = "operation-" + key;
      if (!operations.has(operationId)) {
        expect(body.turnId).toBe(detail.shell.stopTurnId);
        detail.delivery = { id: operationId, kind: "stop", status: "applied" };
        operations.set(operationId, detail.delivery);
      }
      if (loseReceipt && stops.length === 1) {
        detail.shell = { ...shell, busy: true, stopTurnId: "turn-B" };
        throw new TypeError("connection lost after acceptance");
      }
      return Response.json({ operationId });
    }
    return Response.json({}, { status: 404 });
  });
});

async function openWithControl() {
  renderHub(<LiveShells projectId={projectId} />, context);
  fireEvent.click(await screen.findByRole("button", { name: "Connect to Terminal conversation" }));
  expect(await screen.findByText("Already said in the terminal")).toBeInTheDocument();
  expect(screen.getByText("Previously answered here")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Claim control" }));
  await screen.findByRole("button", { name: "Release control" });
  return screen.getByRole("textbox", { name: "Message" });
}

test("connects to the existing terminal history and releases only the browser on disconnect", async () => {
  const composer = await openWithControl();
  fireEvent.change(composer, { target: { value: "From Hub" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("From Hub", { selector: "pre" })).toBeInTheDocument();
  await waitFor(() => expect(composer).toHaveValue(""));
  expect(reads).toContain("operation-" + sends[0]);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect from shell" }));
  expect(await screen.findByRole("button", { name: "Connect to Terminal conversation" })).toBeInTheDocument();
  expect(releases).toBe(1);
});

test("retries an uncertain send with the same operation key and clears the draft only after acknowledgement", async () => {
  loseReceipt = true;
  const composer = await openWithControl();
  fireEvent.change(composer, { target: { value: "One message only" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("button", { name: "Retry the same request" })).toBeEnabled();
  expect(composer).toHaveValue("One message only");
  fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }));
  await waitFor(() => expect(composer).toHaveValue(""));
  expect(sends).toHaveLength(2);
  expect(sends[0]).toBe(sends[1]);
  expect(detail.messages.filter(message => message.text === "One message only")).toHaveLength(1);
});

test("keeps rejected text editable once the shell reports it was rejected", async () => {
  messageStatus = "rejected";
  const composer = await openWithControl();
  fireEvent.change(composer, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("The shell rejected the request.")).toBeInTheDocument();
  await waitFor(() => expect(composer).not.toHaveAttribute("readonly"));
  expect(composer).toHaveValue("Keep this draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("only the matching operation acknowledgement can clear the draft", async () => {
  messageStatus = "pending";
  const composer = await openWithControl();
  fireEvent.change(composer, { target: { value: "My own pending message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("Waiting for the shell to accept the request.")).toBeInTheDocument();
  const id = "operation-" + sends[0];
  detail.delivery = { id: "another-tabs-operation", kind: "message", status: "applied" };
  await waitFor(() => expect(reads.filter(value => value === id).length).toBeGreaterThan(1), { timeout: 2_500 });
  expect(composer).toHaveValue("My own pending message");
  expect(screen.queryByText("The shell accepted the request.")).not.toBeInTheDocument();
  operations.set(id, { id, kind: "message", status: "applied" });
  await waitFor(() => expect(composer).toHaveValue(""), { timeout: 2_500 });
  expect(screen.getByText("The shell accepted the request.")).toBeInTheDocument();
});

test("another browser using the same operator can read history and claim after release", async () => {
  await openWithControl();
  const other = renderHub(<LiveShells projectId={projectId} />, { ...context, scopeKey: 2 });
  const browser = within(other.container);
  fireEvent.click(await browser.findByRole("button", { name: "Connect to Terminal conversation" }));
  expect(await browser.findByText("Previously answered here")).toBeInTheDocument();
  expect(browser.getByRole("button", { name: "Claim control" })).toBeDisabled();
  fireEvent.change(browser.getByRole("textbox", { name: "Message" }), { target: { value: "Keep in other browser" } });
  expect(browser.getByRole("button", { name: "Send message" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Release control" }));
  await waitFor(() => expect(browser.getByRole("button", { name: "Claim control" })).toBeEnabled(), { timeout: 2_500 });
  fireEvent.click(browser.getByRole("button", { name: "Claim control" }));
  expect(await browser.findByRole("button", { name: "Release control" })).toBeInTheDocument();
  expect(browser.getByRole("button", { name: "Send message" })).toBeEnabled();
  expect(claims).toHaveLength(2);
  expect(claims[0]).not.toBe(claims[1]);
});

test("retries a lost Stop receipt for the original turn even when the shell has started another", async () => {
  detail.shell = { ...shell, busy: true, stopTurnId: "turn-A" };
  loseReceipt = true;
  await openWithControl();
  fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry the same request" }));
  expect(await screen.findByText("The shell accepted the request.")).toBeInTheDocument();
  expect(stops).toEqual([
    { key: expect.any(String), turnId: "turn-A" },
    { key: stops[0]?.key, turnId: "turn-A" },
  ]);
});
