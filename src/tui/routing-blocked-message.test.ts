import { expect, test } from "bun:test";
import { renderRoutingBlockedMessage } from "./tui-shell";

test("routing denials explain recovery without exposing internal reason tokens", () => {
  const unavailable = renderRoutingBlockedMessage("model-unavailable");
  expect(unavailable).toContain("check /connect");
  expect(unavailable).not.toContain("model-unavailable");

  const exhausted = renderRoutingBlockedMessage("attempts-exhausted");
  expect(exhausted).toContain("check provider connections");
  expect(exhausted).not.toContain("attempts-exhausted");

  const unknown = renderRoutingBlockedMessage("internal-new-reason");
  expect(unknown).toContain("check /routing and /connect");
  expect(unknown).not.toContain("internal-new-reason");
});
