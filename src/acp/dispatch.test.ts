import { expect, test } from "bun:test";
import { AcpDispatcher } from "./dispatch";
import { encodeAcpMessage } from "./framing";
import {
  AcpError,
  JSON_RPC_ERROR_CODES,
  notificationMessage,
  requestMessage,
  successResponse,
} from "./jsonrpc";
import { ACP_AGENT_METHODS, ACP_PROTOCOL_VERSION } from "./protocol";

function replyOf(outcome: Awaited<ReturnType<AcpDispatcher["handleLine"]>>) {
  if (outcome.kind !== "reply") {
    throw new Error(`expected a reply, got ${outcome.kind}`);
  }
  return outcome.message;
}

function errorOf(message: ReturnType<typeof replyOf>) {
  if (!("error" in message)) {
    throw new Error("expected an error response");
  }
  return message.error;
}

test("a registered request method is routed with its params and id", async () => {
  const seen: { params: unknown; method: string; id: unknown }[] = [];
  const dispatcher = new AcpDispatcher({
    requests: {
      [ACP_AGENT_METHODS.sessionNew]: (params, context) => {
        seen.push({ params, method: context.method, id: context.id });
        return { sessionId: "sess-1" };
      },
    },
  });

  const outcome = await dispatcher.handleLine(
    encodeAcpMessage(requestMessage(7, "session/new", { cwd: "/repo", mcpServers: [] })),
  );

  expect(replyOf(outcome)).toEqual(successResponse(7, { sessionId: "sess-1" }));
  expect(seen).toEqual([
    { params: { cwd: "/repo", mcpServers: [] }, method: "session/new", id: 7 },
  ]);
});

test("a handler that returns nothing answers with an empty result, not with null", async () => {
  const dispatcher = new AcpDispatcher().onRequest("session/load", () => undefined);

  const outcome = await dispatcher.handleMessage(requestMessage(1, "session/load", {}));

  expect(replyOf(outcome)).toEqual(successResponse(1, {}));
});

test("an unknown method answers -32601 and says what this agent does implement", async () => {
  const dispatcher = new AcpDispatcher();

  const outcome = await dispatcher.handleMessage(requestMessage("x", "session/teleport"));
  const error = errorOf(replyOf(outcome));

  expect(error.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
  expect(error.message).toBe("Method not found: session/teleport");
  expect(error.data).toEqual({
    protocolVersion: ACP_PROTOCOL_VERSION,
    implemented: [
      "initialize",
      "session/new",
      "session/load",
      "session/list",
      "session/prompt",
      "session/cancel",
      "session/set_config_option",
    ],
  });
});

// A method ACP defines and keryx declines is a different fact from a method
// nobody defines, and the client author has to be able to tell them apart.
test("a refused-but-known ACP method explains the refusal in the error data", async () => {
  const dispatcher = new AcpDispatcher();

  const outcome = await dispatcher.handleMessage(requestMessage(2, "session/resume", {}));
  const error = errorOf(replyOf(outcome));

  expect(error.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
  expect((error.data as { reason: string }).reason).toContain("sessionCapabilities.resume");
});

test("authenticate is refused, because keryx advertises no auth methods", async () => {
  const dispatcher = new AcpDispatcher();

  const error = errorOf(replyOf(await dispatcher.handleMessage(requestMessage(3, "authenticate"))));

  expect(error.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
  expect((error.data as { reason: string }).reason).toContain("authMethods");
});

test("malformed JSON answers -32700 with a null id", async () => {
  const dispatcher = new AcpDispatcher();

  const message = replyOf(await dispatcher.handleLine('{"jsonrpc":"2.0",'));

  expect(message.id).toBe(null);
  expect(errorOf(message).code).toBe(JSON_RPC_ERROR_CODES.parseError);
});

test("a message that is not JSON-RPC 2.0 answers -32600 and echoes the id it could recover", async () => {
  const dispatcher = new AcpDispatcher();

  const message = replyOf(
    await dispatcher.handleMessage({ jsonrpc: "1.0", id: 9, method: "initialize" }),
  );

  expect(message.id).toBe(9);
  expect(errorOf(message).code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
});

// JSON-RPC 2.0 §4.1: a notification is a message with NO id. Answering one is a
// protocol violation, and an editor that receives a reply it never asked for
// has no request to match it against.
test("an id-less notification is handled and produces no reply at all", async () => {
  const seen: unknown[] = [];
  const dispatcher = new AcpDispatcher({
    notifications: { "session/cancel": (params) => void seen.push(params) },
  });

  const outcome = await dispatcher.handleLine(
    encodeAcpMessage(notificationMessage("session/cancel", { sessionId: "s1" })),
  );

  expect(outcome).toEqual({ kind: "none" });
  expect(seen).toEqual([{ sessionId: "s1" }]);
});

test("an unknown notification is reported to the host and still produces no reply", async () => {
  const unhandled: string[] = [];
  const dispatcher = new AcpDispatcher(
    {},
    { onUnhandledNotification: (method) => void unhandled.push(method) },
  );

  expect(await dispatcher.handleMessage(notificationMessage("session/vanish"))).toEqual({
    kind: "none",
  });
  expect(unhandled).toEqual(["session/vanish"]);
});

// `{"id": null}` is a REQUEST whose reply carries a null id, not a
// notification. A truthiness check on the id gets this wrong and swallows it.
test("a request with a null id is answered, not treated as a notification", async () => {
  const dispatcher = new AcpDispatcher().onRequest("session/list", () => ({ sessions: [] }));

  const outcome = await dispatcher.handleMessage({
    jsonrpc: "2.0",
    id: null,
    method: "session/list",
  });

  expect(replyOf(outcome)).toEqual(successResponse(null, { sessions: [] }));
});

test("a response to one of our own requests is routed back, never answered", async () => {
  const dispatcher = new AcpDispatcher();

  const outcome = await dispatcher.handleMessage({ jsonrpc: "2.0", id: 4, result: { ok: true } });

  expect(outcome).toEqual({
    kind: "incoming-response",
    message: { jsonrpc: "2.0", id: 4, result: { ok: true } },
  });
});

test("a handler throwing AcpError answers with exactly that code and data", async () => {
  const dispatcher = new AcpDispatcher().onRequest("session/prompt", () => {
    throw new AcpError(JSON_RPC_ERROR_CODES.invalidParams, "sessionId is unknown", { id: "s9" });
  });

  const error = errorOf(replyOf(await dispatcher.handleMessage(requestMessage(5, "session/prompt"))));

  expect(error).toEqual({
    code: JSON_RPC_ERROR_CODES.invalidParams,
    message: "sessionId is unknown",
    data: { id: "s9" },
  });
});

test("a handler throwing anything else answers -32603 with the message and no stack", async () => {
  const errors: unknown[] = [];
  const dispatcher = new AcpDispatcher(
    {},
    { onHandlerError: (_method, error) => void errors.push(error) },
  ).onRequest("session/prompt", () => {
    throw new TypeError("cannot read properties of undefined");
  });

  const error = errorOf(replyOf(await dispatcher.handleMessage(requestMessage(6, "session/prompt"))));

  expect(error.code).toBe(JSON_RPC_ERROR_CODES.internalError);
  expect(error.message).toBe("cannot read properties of undefined");
  expect(JSON.stringify(error)).not.toContain("at ");
  expect(errors.length).toBe(1);
});

test("a notification handler that throws is reported, because no reply can carry it", async () => {
  const errors: string[] = [];
  const dispatcher = new AcpDispatcher(
    { notifications: { "session/cancel": () => { throw new Error("boom"); } } },
    { onHandlerError: (method) => void errors.push(method) },
  );

  expect(await dispatcher.handleMessage(notificationMessage("session/cancel"))).toEqual({
    kind: "none",
  });
  expect(errors).toEqual(["session/cancel"]);
});

test("an async handler is awaited before the reply is shaped", async () => {
  const dispatcher = new AcpDispatcher().onRequest("session/prompt", async () => {
    await Promise.resolve();
    return { stopReason: "end_turn" };
  });

  expect(replyOf(await dispatcher.handleMessage(requestMessage(8, "session/prompt")))).toEqual(
    successResponse(8, { stopReason: "end_turn" }),
  );
});

test("the registry reports what is registered, so later wiring can be asserted", () => {
  const dispatcher = new AcpDispatcher()
    .onRequest("session/new", () => ({}))
    .onRequest("initialize", () => ({}))
    .onNotification("session/cancel", () => {});

  expect(dispatcher.registeredRequestMethods()).toEqual(["initialize", "session/new"]);
  expect(dispatcher.registeredNotificationMethods()).toEqual(["session/cancel"]);
});
