import { expect, test } from "bun:test";
import { classifyBusyDispatch } from "./busy-dispatch";

const base = {
  isSessionInfo: false,
  isFlows: false,
  isWorkspace: false,
  isReview: false,
};

test("classifyBusyDispatch: /exit routes to exit", () => {
  expect(
    classifyBusyDispatch({ line: "/exit", commandName: "/exit", ...base }),
  ).toBe("exit");
});

test("classifyBusyDispatch: /help routes to help", () => {
  expect(
    classifyBusyDispatch({ line: "/help", commandName: "/help", ...base }),
  ).toBe("help");
});

test("classifyBusyDispatch: /interrupt routes to interrupt", () => {
  expect(
    classifyBusyDispatch({ line: "/interrupt", commandName: "/interrupt", ...base }),
  ).toBe("interrupt");
});

test("classifyBusyDispatch: /queue remove 1 routes to queue", () => {
  expect(
    classifyBusyDispatch({ line: "/queue remove 1", commandName: "/queue", ...base }),
  ).toBe("queue");
});

test("classifyBusyDispatch: /think routes to think", () => {
  expect(
    classifyBusyDispatch({ line: "/think", commandName: "/think", ...base }),
  ).toBe("think");
});

test("classifyBusyDispatch: /expand routes to expand", () => {
  expect(
    classifyBusyDispatch({ line: "/expand", commandName: "/expand", ...base }),
  ).toBe("expand");
});

test("classifyBusyDispatch: /copy routes to copy", () => {
  expect(
    classifyBusyDispatch({ line: "/copy", commandName: "/copy", ...base }),
  ).toBe("copy");
});

test("classifyBusyDispatch: /mode routes to mode", () => {
  expect(
    classifyBusyDispatch({ line: "/mode auto", commandName: "/mode", ...base }),
  ).toBe("mode");
});

test("classifyBusyDispatch: /model (similar name, out of scope) still routes to deferred", () => {
  expect(
    classifyBusyDispatch({ line: "/model", commandName: "/model", ...base }),
  ).toBe("deferred");
});

test("classifyBusyDispatch: isSessionInfo line routes to session-info", () => {
  expect(
    classifyBusyDispatch({
      line: "/status",
      commandName: undefined,
      ...base,
      isSessionInfo: true,
    }),
  ).toBe("session-info");
});

test("classifyBusyDispatch: isFlows line routes to flows", () => {
  expect(
    classifyBusyDispatch({
      line: "/flows",
      commandName: undefined,
      ...base,
      isFlows: true,
    }),
  ).toBe("flows");
});

test("classifyBusyDispatch: isWorkspace line routes to workspace", () => {
  expect(
    classifyBusyDispatch({
      line: "/workspace",
      commandName: undefined,
      ...base,
      isWorkspace: true,
    }),
  ).toBe("workspace");
});

test("classifyBusyDispatch: isReview line routes to review", () => {
  expect(
    classifyBusyDispatch({
      line: "/review",
      commandName: undefined,
      ...base,
      isReview: true,
    }),
  ).toBe("review");
});

test("classifyBusyDispatch: unrecognized slash command routes to deferred", () => {
  expect(
    classifyBusyDispatch({ line: "/model", commandName: "/model", ...base }),
  ).toBe("deferred");
});

test("classifyBusyDispatch: plain non-slash question routes to not-a-command", () => {
  expect(
    classifyBusyDispatch({
      line: "what does this function do?",
      commandName: undefined,
      ...base,
    }),
  ).toBe("not-a-command");
});
