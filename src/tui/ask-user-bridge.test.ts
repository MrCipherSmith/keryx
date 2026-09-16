// Fail-closed coverage for the ask_user host bridge.
//
// `ask_user` used to answer the plain Esc-cancel sentinel when NO host was
// registered, so every surface that registers none (`--no-tui`, a non-TTY, any
// TUI init fallback — `setAskUserHost` is called only from `tui-shell.ts`) fed
// the model "User cancelled the question" about a question no human ever saw.
// The model then picked an option itself while the transcript claimed the user
// had declined. "Nobody was asked" and "the user declined" are different facts
// with opposite correct next moves, so they must not share one sentinel.
import { expect, test } from "bun:test";
import { ASK_USER_CANCEL, ASK_USER_NO_HOST } from "../harness/tool/builtin/ask-user-tool";
import { invokeAskUserHost, setAskUserHost } from "./ask-user-bridge";

const request = {
  question: "Ship the MVP or the full build?",
  options: [
    { id: "mvp", label: "MVP", description: "Smallest ship" },
    { id: "full", label: "Full", description: "Everything" },
  ],
};

test("no host registered: the no-host sentinel, never the Esc-cancel sentinel", async () => {
  setAskUserHost(undefined);
  const answer = await invokeAskUserHost(request);
  expect(answer).toBe(ASK_USER_NO_HOST);
  expect(answer).not.toBe(ASK_USER_CANCEL);
});

test("a registered host answers; unregistering fails closed again", async () => {
  try {
    setAskUserHost(async (req) => req.options[0]!.id);
    expect(await invokeAskUserHost(request)).toBe("mvp");
  } finally {
    setAskUserHost(undefined);
  }
  expect(await invokeAskUserHost(request)).toBe(ASK_USER_NO_HOST);
});
