import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import type { LiveShellCommand, LiveShellDetail, LiveShellMessage, LiveShellReply, LiveShellUpdate } from "../../remote-control/live-shell";
import { D, HEAD, fixture, publishCapabilities, reviewerToken, success as readSuccess, type Fixture } from "./fixture.test-support";

let hub: Fixture;
afterEach(async () => { if (hub) await hub.close(); });
async function success<T = Record<string, unknown>>(response: Promise<Response>): Promise<T> {
  return readSuccess<T>(await response);
}

async function sharedShell() {
  hub = await fixture();
  const machine = await hub.enroll();
  const peer = await hub.connect(machine);
  const shellId = randomUUID();
  const machinePath = `/hub/v2/machines/${machine.machineId}/live-shells/${shellId}`;
  const projectPath = `/hub/v2/projects/${hub.project.id}/live-shells`;
  const detailPath = projectPath + "/" + shellId;
  const state: LiveShellUpdate = { projectId: hub.project.id, checkoutId: "checkout", title: "Open shell", busy: false };
  const refresh = (patch: Partial<LiveShellUpdate> = {}) => hub.call(machinePath, {
    method: "POST", origin: null, token: machine.secret, body: { ...state, ...patch },
  });
  const detail = (operationId?: string) => success<LiveShellDetail>(hub.call(detailPath +
    (operationId ? "?operationId=" + operationId : ""), { cookie: hub.cookie }));
  const write = (action: string, body: unknown, key = randomUUID(), cookie = hub.cookie) =>
    hub.call(detailPath + "/" + action, { method: "POST", key, cookie, body });
  const publish = () => publishCapabilities(hub, peer);
  return { machine, machinePath, projectPath, detailPath, state, refresh, detail, write, publish };
}

test("live shell history stays project scoped and only the controller can send idempotent messages", async () => {
  const shell = await sharedShell();
  expect((await shell.refresh()).status).toBe(409);
  await shell.publish();
  expect(await success<{shells: unknown[]}>(hub.call(shell.projectPath, { cookie: hub.cookie }))).toEqual({ shells: [] });
  expect((await shell.refresh({ checkoutId: "unmapped" })).status).toBe(403);
  const history: LiveShellMessage[] = [{ role: "user", text: "Local message before attach" }, { role: "assistant", text: "Prior reply" }];
  await success(shell.refresh({ messages: history }));
  expect((await shell.detail()).messages).toEqual(history);
  expect((await success<{shells: unknown[]}>(hub.call(shell.projectPath, { cookie: hub.cookie }))).shells).toHaveLength(1);

  const clientId = randomUUID();
  const secondTab = randomUUID();
  const reviewer = await hub.login(reviewerToken);
  expect((await shell.write("claim", { clientId }, randomUUID(), reviewer)).status).toBe(403);
  expect((await shell.write("message", { clientId, text: "Before claim" })).status).toBe(409);
  await success(shell.write("claim", { clientId }));
  expect((await shell.write("claim", { clientId: secondTab })).status).toBe(409);
  await success(shell.write("renew", { clientId }));

  const key = randomUUID();
  const prompt = { clientId, text: "Message from Hub" };
  const receipt = await success<{operationId: string}>(shell.write("message", prompt, key));
  expect(await success<{operationId: string}>(shell.write("message", prompt, key))).toEqual(receipt);
  expect((await shell.write("message", { ...prompt, text: "Changed body" }, key)).status).toBe(409);
  const offered: LiveShellCommand = { id: receipt.operationId, kind: "message", text: prompt.text };
  expect((await success<LiveShellReply>(shell.refresh())).command).toEqual(offered);
  expect((await success<LiveShellReply>(shell.refresh())).command).toEqual(offered);
  expect((await shell.detail(receipt.operationId)).delivery?.status).toBe("pending");
  await success(shell.refresh({
    messages: [...history, { role: "user", text: prompt.text }, { role: "assistant", text: "Same shell replied" }],
    ack: { id: receipt.operationId, status: "applied" },
  }));
  expect((await shell.detail(receipt.operationId)).delivery?.status).toBe("applied");
  expect((await shell.detail()).messages.at(-1)?.text).toBe("Same shell replied");
  expect((await success<LiveShellReply>(shell.refresh())).command).toBeNull();
  const other = await success<{id: string}>(hub.call("/hub/v1/projects", {
    method: "POST", cookie: hub.cookie, body: { name: "Other project" },
  }));
  expect((await hub.call(shell.detailPath.replace(hub.project.id, other.id), { cookie: hub.cookie })).status).toBe(404);

  await success(shell.write("release", { clientId }));
  expect((await shell.write("renew", { clientId })).status).toBe(409);
  expect((await shell.detail()).controllerHeld).toBe(false);
  await success(hub.call(shell.machinePath, { method: "DELETE", origin: null, token: shell.machine.secret }));
  expect((await hub.call(shell.detailPath, { cookie: hub.cookie })).status).toBe(404);
});

test("Stop never moves from its observed turn to the next and a released controller cannot dispatch pending work", async () => {
  const shell = await sharedShell();
  await shell.publish();
  const currentTurn = randomUUID();
  await success(shell.refresh({ busy: true, turnId: currentTurn }));
  const clientId = randomUUID();
  await success(shell.write("claim", { clientId }));
  expect((await shell.write("stop", { clientId, turnId: randomUUID() })).status).toBe(409);
  const stop = await success<{operationId: string}>(shell.write("stop", { clientId, turnId: currentTurn }));
  const nextTurn = randomUUID();
  expect((await success<LiveShellReply>(shell.refresh({ busy: true, turnId: nextTurn }))).command).toBeNull();
  expect((await shell.detail(stop.operationId)).delivery?.status).toBe("rejected");

  const command = await success<{operationId: string}>(shell.write("message", { clientId, text: "Withdraw before delivery" }));
  await success(shell.write("release", { clientId }));
  expect((await success<LiveShellReply>(shell.refresh())).command).toBeNull();
  expect((await shell.detail(command.operationId)).delivery?.status).toBe("rejected");
});

test("an advertised shell and a new headless session cannot claim the same mapped checkout", async () => {
  const shell = await sharedShell();
  await shell.publish();
  await success(shell.refresh());
  const launch = () => hub.call(`/hub/v2/projects/${hub.project.id}/sessions`, {
    method: "POST", cookie: hub.cookie, body: {
      machineId: shell.machine.machineId, checkoutId: "checkout", agentProfileId: "native",
      expectedInventoryVersion: 1, expectedHeadSha: HEAD, capabilityDigest: D, policyDigest: D, title: "Headless",
    },
  });
  expect((await launch()).status).toBe(409);
  await success(hub.call(shell.machinePath, { method: "DELETE", origin: null, token: shell.machine.secret }));
  expect((await success<{status: string}>(launch())).status).toBe("pending");
  expect((await shell.refresh()).status).toBe(409);
});
