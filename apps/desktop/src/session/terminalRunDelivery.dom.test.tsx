import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The fixture drives the real useAcpSession hook over Tauri's IPC mocks in its own process, so its mocks
// cannot leak into other test files.
const fixture = fileURLToPath(new URL("../test/terminal-run-delivery.fixture.tsx", import.meta.url));
const run = (...args: string[]): string => execFileSync(process.execPath, [fixture, ...args], { timeout: 15000, stdio: "pipe" }).toString();

test("AC3/AC4: a Run from a session not shown is delivered to it as one session/prompt with the six fields; results that wait for a turn go in one prompt; no user bubble", () => {
  expect(typeof run()).toBe("string");
});

test("AC8: a keryx whose initialize lacks terminalResults gets no prompt, and the card says the result was not sent", () => {
  expect(typeof run("no-results")).toBe("string");
});

test("keryx's answers to a results prompt: busy waits and is asked again, a final refusal is not sent, a failed turn is a notice; a closed tab, a command in flight, a queued prompt, a released session, a keryx shutting down and a reconnect each hold the result as the waiting rule says", () => {
  expect(typeof run("refusals")).toBe("string");
});
