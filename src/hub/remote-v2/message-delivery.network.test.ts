import { afterEach, expect, test } from "bun:test";
import type { MessageDeliveries } from "../../remote-control/message-delivery";
import type { Control, FrameOf } from "../../remote-control/protocol";
import { openHubStore } from "../store";
import { expirePendingCommands } from "./delivery";
import { admittedSession, appliedController, fixture, reviewerToken, success, type Fixture } from "./fixture.test-support";

let hub: Fixture | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

async function submitMessage(f: Fixture, text: string) {
  const session = await admittedSession(f);
  const controller = await appliedController(f, session);
  const body: Control["MessageSubmit"] = {
    expectedSessionVersion: controller.sessionVersion,
    expectedConfigVersion: session.session.config.configVersion,
    controller: {
      controllerLeaseId: controller.lease.controllerLeaseId,
      expectedControllerVersion: controller.lease.version,
    },
    text,
    interpretation: "literal-message",
    busyPolicy: "reject",
    association: { mode: "ad-hoc", profileConsentVersion: 1 },
  };
  const key = crypto.randomUUID();
  const post = () => f.call(`${session.path}/messages`, { method: "POST", cookie: f.cookie, body, key });
  const receipt = await success<Control["TurnReceipt"]>(await post());
  const command = (await session.peer.next("command")).payload as FrameOf<"command">["payload"];
  if (command.kind !== "start-turn") throw new Error("Expected native start-turn command");
  const read = async (cookie = f.cookie) => (await success<MessageDeliveries>(
    await f.call(`${session.path}/message-deliveries`, { cookie }),
  )).deliveries;
  return { session, receipt, command, read, body, post };
}

async function emitTurnAdmission(f: Fixture, { session, command }: Pick<Awaited<ReturnType<typeof submitMessage>>, "session" | "command">,
  seq = session.session.sessionEventCursor + 1) {
  session.peer.send("session-event", {
    sessionId: session.session.sessionId,
    projectId: f.project.id,
    checkoutId: session.session.checkoutId,
    sessionEventSeq: seq,
    observedAt: new Date().toISOString(),
    kind: "turn-admitted",
    runId: command.runId,
    turnId: command.turnId,
    turnOrdinal: command.body.turnOrdinal,
    snapshot: command.body.snapshot,
    association: command.body.request.association,
  });
  await session.peer.next("session-event-ack");
}

function expireDeliveredCommand(f: Fixture, expiresAt: string) {
  const store = openHubStore(f.dataDir);
  try {
    // Cross the actual command's deadline without sleeping for the configured timeout.
    store.writeTransaction((_state, repo) => expirePendingCommands(repo, Date.parse(expiresAt) + 1));
  } finally {
    store.close();
  }
}

test("only the sending actor sees the accepted message before native admission", async () => {
  const f = hub = await fixture();
  const text = "Message awaiting admission";
  const submitted = await submitMessage(f, text);
  const { session, receipt, command, read } = submitted;
  expect(await read()).toMatchObject([{
    operationId: receipt.operationId, text, status: "hub-accepted", queued: false, reason: null,
    runId: receipt.runId, turnId: receipt.turnId, afterCursor: session.session.historyCursor,
  }]);

  const reviewer = await f.login(reviewerToken);
  expect((await success<Control["SessionRecord"]>(await f.call(session.path, { cookie: reviewer }))).sessionId)
    .toBe(session.session.sessionId);
  expect(await read(reviewer)).toEqual([]);

  await emitTurnAdmission(f, submitted);

  expect(await read()).toMatchObject([{
    operationId: receipt.operationId, status: "machine-started", queued: false, reason: null,
    runId: command.runId, turnId: command.turnId,
  }]);
  expect(await read(reviewer)).toEqual([]);
});

test("machine refusal keeps the exact original text available to its sender", async () => {
  const f = hub = await fixture();
  const text = "  First line\nSecond line — без потерь\n";
  const { session, receipt, command, read } = await submitMessage(f, text);
  session.peer.send("command-receipt", {
    commandId: command.commandId,
    hubSequence: command.hubSequence,
    runId: command.runId,
    sessionId: session.session.sessionId,
    observedRunVersion: 1,
    status: "rejected",
    errorCode: "checkout-dirty",
  });
  session.peer.send("heartbeat", { daemonId: "daemon-1" });
  await session.peer.next("heartbeat-ack");

  expect(await read()).toMatchObject([{
    operationId: receipt.operationId, status: "machine-rejected", text, queued: false,
    reason: "checkout-dirty", runId: command.runId, turnId: command.turnId,
  }]);
  expect((await success<Control["HistoryPage"]>(await f.call(`${session.path}/history`, { cookie: f.cookie }))).messages)
    .toEqual([]);
  expect(await read(await f.login(reviewerToken))).toEqual([]);
});

test.each([
  { label: "proven native nonadmission", states: ["received", "starting", "failed"], status: "machine-rejected", reason: "stale-reference" },
  { label: "unconfirmed native cessation", states: ["received", "starting"], status: "unconfirmed", reason: "recovery-required" },
])("a not-applied receipt with $label keeps the exact message and correct status", async ({ states, status, reason }) => {
  const f = hub = await fixture();
  const text = "The native host did not admit this message";
  const { session, receipt, command, read } = await submitMessage(f, text);
  for (const [index, state] of states.entries()) {
    session.peer.send("run-event", {
      runId: command.runId, turnId: command.turnId, sessionId: session.session.sessionId,
      projectId: f.project.id, checkoutId: session.session.checkoutId, localSeq: index + 1,
      observedAt: new Date().toISOString(), kind: "state", state,
      reasonCode: state === "failed" ? "native-failure" : "none",
    });
    await session.peer.next("run-event-ack");
  }
  expect(await read()).toMatchObject([{ operationId: receipt.operationId, status: "hub-accepted" }]);

  if (status === "unconfirmed") {
    const seq = session.session.sessionEventCursor + 1;
    session.peer.send("session-event", {
      sessionId: session.session.sessionId, projectId: f.project.id, checkoutId: session.session.checkoutId,
      sessionEventSeq: seq, observedAt: new Date().toISOString(), kind: "session-state",
      session: { ...session.session, version: session.session.version + 1, state: "recovery-required", sessionEventCursor: seq },
    });
    await session.peer.next("session-event-ack");
  }

  session.peer.send("command-receipt", {
    commandId: command.commandId, hubSequence: command.hubSequence, runId: command.runId,
    sessionId: session.session.sessionId, observedRunVersion: command.expectedRunVersion,
    status: "not-applied", errorCode: "stale-reference",
  });
  session.peer.send("heartbeat", { daemonId: "daemon-1" });
  await session.peer.next("heartbeat-ack");

  expect(await read()).toMatchObject([{ operationId: receipt.operationId, status, text, reason }]);
});

async function submitQueuedMessage(f: Fixture, text: string) {
  const { session, receipt, read, body } = await submitMessage(f, "Active turn");
  const emit = async (seq: number, event: object) => {
    session.peer.send("session-event", {
      sessionId: session.session.sessionId, projectId: f.project.id, checkoutId: session.session.checkoutId,
      sessionEventSeq: seq, observedAt: new Date().toISOString(), ...event,
    });
    await session.peer.next("session-event-ack");
  };
  const busyVersion = session.session.version + 1;
  const seq = session.session.sessionEventCursor + 1;
  const busy = {
    ...session.session, version: busyVersion, state: "busy", sessionEventCursor: seq,
    activeRunId: receipt.runId, activeTurnId: receipt.turnId, nextTurnOrdinal: 2,
  } satisfies Control["SessionRecord"];
  await emit(seq, { kind: "session-state", session: busy });

  const key = crypto.randomUUID();
  const postQueued = () => f.call(`${session.path}/messages`, {
    method: "POST", cookie: f.cookie, key,
    body: { ...body, expectedSessionVersion: busyVersion, text, busyPolicy: "enqueue" },
  });
  const queued = await success<Control["TurnReceipt"]>(await postQueued());
  const queueCommand = (await session.peer.next("session-command")).payload as FrameOf<"session-command">["payload"];
  const pending = async () => (await read()).find(item => item.operationId === queued.operationId);
  const item: Control["QueueItem"] = {
    queueItemId: "actual-native-queue-item", version: 1, kind: "message", operationId: queued.operationId,
    state: "queued", position: 0, text, commandName: null,
    expectedConfigVersion: body.expectedConfigVersion, replacesOperationId: null,
  };
  return { body, busy, busyVersion, emit, item, pending, postQueued, queueCommand, queued, seq, session };
}

test("queued message delivery follows native admission, edit and removal", async () => {
  const f = hub = await fixture();
  const text = "Pending native queue admission";
  const { body, busy, busyVersion, emit, item, pending, postQueued, queueCommand, queued, seq, session } =
    await submitQueuedMessage(f, text);
  expect(queued).toMatchObject({ status: "queued", queueItemId: null, runId: null, turnId: null });
  expect(await pending()).toMatchObject({ status: "hub-accepted", queued: false, text });
  expireDeliveredCommand(f, queueCommand.expiresAt);
  expect(await pending()).toMatchObject({ status: "unconfirmed", queued: false, reason: "recovery-required" });
  expect((await postQueued()).status).toBe(409);

  await emit(seq + 1, { kind: "queue-changed", queueVersion: 1, item });
  expect(await pending()).toMatchObject({ status: "hub-accepted", queued: true, reason: null, text, runId: null, turnId: null });
  expect(await success<Control["TurnReceipt"]>(await postQueued())).toMatchObject({
    operationId: queued.operationId, status: "queued", queueItemId: item.queueItemId, runId: null, turnId: null,
  });

  await emit(seq + 2, { kind: "session-state", session: {
    ...busy, version: busyVersion + 1, queueVersion: 1, sessionEventCursor: seq + 2,
  } });
  const queuePath = `${session.path}/queue/${item.queueItemId}`;
  const queueReference = { controller: body.controller, queueItemId: item.queueItemId };
  const editedText = "Text edited in the native queue";
  const edit = await success<Control["SessionOperationReceipt"]>(await f.call(queuePath, {
    method: "PATCH", cookie: f.cookie, body: { ...queueReference, expectedSessionVersion: busyVersion + 1,
      expectedQueueVersion: 1, expectedItemVersion: 1, text: editedText },
  }));
  const editCommand = (await session.peer.next("session-command")).payload as FrameOf<"session-command">["payload"];
  expect(await pending()).toMatchObject({ queued: true, text });
  const edited = { ...item, version: 2, text: editedText };
  await emit(seq + 3, { kind: "queue-changed", queueVersion: 2, item: edited });
  await emit(seq + 4, { kind: "session-state", session: {
    ...busy, version: busyVersion + 2, queueVersion: 2, sessionEventCursor: seq + 4,
  } });
  session.peer.send("session-command-receipt", {
    commandId: editCommand.commandId, hubSequence: editCommand.hubSequence, sessionId: session.session.sessionId,
    observedSessionVersion: busyVersion + 2, status: "applied", receiptId: edit.receiptId, errorCode: null,
  });
  session.peer.send("heartbeat", { daemonId: "daemon-1" });
  await session.peer.next("heartbeat-ack");
  expect(await pending()).toMatchObject({ status: "hub-accepted", queued: true, text: editedText });

  await success(await f.call(queuePath, {
    method: "DELETE", cookie: f.cookie, body: { ...queueReference, expectedSessionVersion: busyVersion + 2,
      expectedQueueVersion: 2, expectedItemVersion: 2 },
  }));
  await session.peer.next("session-command");
  expect(await pending()).toMatchObject({ queued: true, text: editedText });
  await emit(seq + 5, { kind: "queue-changed", queueVersion: 3, item: { ...edited, version: 3, state: "removed" } });
  expect(await pending()).toMatchObject({ status: "queue-removed", queued: false, text: editedText });
});

test("late admission of a queued turn clears the stale error for the original message key", async () => {
  const f = hub = await fixture();
  const { busy, busyVersion, emit, item, pending, postQueued, queued, seq, session } =
    await submitQueuedMessage(f, "Queued message admitted after timeout");
  await emit(seq + 1, { kind: "queue-changed", queueVersion: 1, item });
  await emit(seq + 2, { kind: "session-state", session: {
    ...busy, version: busyVersion + 1, queueVersion: 1, sessionEventCursor: seq + 2,
  } });
  await emit(seq + 3, { kind: "session-state", session: {
    ...busy, version: busyVersion + 2, queueVersion: 1, sessionEventCursor: seq + 3,
    state: "idle", activeRunId: null, activeTurnId: null,
  } });

  const command = (await session.peer.next("command")).payload as FrameOf<"command">["payload"];
  if (command.kind !== "start-turn") throw new Error("Expected native start-turn command");
  expireDeliveredCommand(f, command.expiresAt);
  expect(await pending()).toMatchObject({ status: "hub-accepted", queued: true });
  expect((await postQueued()).status).toBe(409);

  await emitTurnAdmission(f, { session, command }, seq + 4);
  expect(await pending()).toMatchObject({ status: "machine-started", queued: false, reason: null });
  expect(await success<Control["TurnReceipt"]>(await postQueued())).toMatchObject({
    operationId: queued.operationId, status: "admitted", runId: command.runId, turnId: command.turnId,
  });
});

test("a delivered command with no native proof remains unconfirmed after expiry", async () => {
  const f = hub = await fixture();
  const text = "Delivered without an application receipt";
  const { receipt, command, read } = await submitMessage(f, text);
  expireDeliveredCommand(f, command.expiresAt);

  expect(await read()).toMatchObject([{
    operationId: receipt.operationId, status: "unconfirmed", text, queued: false,
    reason: "recovery-required", runId: command.runId, turnId: command.turnId,
  }]);
});

test("late native turn admission clears the stale failure for exact HTTP replay", async () => {
  const f = hub = await fixture();
  const submitted = await submitMessage(f, "Message admitted after timeout");
  const { session, command, receipt, post, read } = submitted;
  for (const [index, state] of ["received", "starting"].entries()) {
    session.peer.send("run-event", {
      runId: command.runId, turnId: command.turnId, sessionId: session.session.sessionId,
      projectId: f.project.id, checkoutId: session.session.checkoutId, localSeq: index + 1,
      observedAt: new Date().toISOString(), kind: "state", state, reasonCode: "none",
    });
    await session.peer.next("run-event-ack");
  }
  expireDeliveredCommand(f, command.expiresAt);
  expect(await read()).toMatchObject([{ operationId: receipt.operationId, status: "unconfirmed" }]);
  expect((await post()).status).toBe(409);

  await emitTurnAdmission(f, submitted);
  expect(await read()).toMatchObject([{ operationId: receipt.operationId, status: "machine-started", reason: null }]);
  expect(await success<Control["TurnReceipt"]>(await post())).toMatchObject({
    operationId: receipt.operationId, status: "admitted", runId: receipt.runId, turnId: receipt.turnId,
  });
});
