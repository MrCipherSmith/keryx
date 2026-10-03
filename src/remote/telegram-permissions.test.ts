// Flow 396, the wire half: what the remote config says reaches the shell at registration (AC4, AC6, AC8),
// the "Always" button and what becomes of a press (AC9, AC10), and the old configs (AC14). Fake Bot API only.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApprovalEvent, type RemoteClient } from "./client";
import {
  DEFAULT_APPROVAL_WAIT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  loadRemoteConfig,
  parseRemoteConfig,
  saveRemoteConfig,
  updateRemotePolicy,
} from "./config";
import type { FakeSentMessage } from "./fake-bot-api";
import { alwaysButtonText } from "./http-surface";
import { approvalCallbackData, MAX_BUTTON_TEXT_CHARS, parseApprovalCallback } from "./protocol";
import { call, makeRig, type Rig } from "./remote.http.test-helpers";
import { makeRemoteDir, OWNER_ID, settle, STRANGER_ID, until } from "./remote.test-helpers";

let rig: Rig;
const dirs: string[] = [];
afterEach(async () => {
  await rig?.cleanup();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = { schemaVersion: 1, chatId: -1001, allowedUserIds: [1] };

describe("the remote config keys (AC4, AC6, AC8, AC14)", () => {
  test("an absent permissionMode means trust, and auto or anything else is refused with a reason", () => {
    const parsed = parseRemoteConfig(BASE);
    expect(parsed.ok && parsed.value.permissionMode).toBe("trust");
    expect(parseRemoteConfig({ ...BASE, permissionMode: "ask" }).ok).toBe(true);
    const auto = parseRemoteConfig({ ...BASE, permissionMode: "auto" });
    expect(auto.ok).toBe(false);
    expect(!auto.ok && auto.reason).toContain("permissionMode");
    expect(!auto.ok && auto.reason).toContain("auto");
    expect(parseRemoteConfig({ ...BASE, permissionMode: "yolo" }).ok).toBe(false);
    expect(parseRemoteConfig({ ...BASE, permissionMode: 1 }).ok).toBe(false);
    // The schema stays closed.
    expect(parseRemoteConfig({ ...BASE, permissionMod: "ask" }).ok).toBe(false);
  });

  test("no run limit by default; 0 is none; a positive value is kept", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(0);
    const absent = parseRemoteConfig(BASE);
    expect(absent.ok && absent.value.runTimeoutMs).toBe(0);
    const zero = parseRemoteConfig({ ...BASE, runTimeoutMs: 0 });
    expect(zero.ok && zero.value.runTimeoutMs).toBe(0);
    const legacy = parseRemoteConfig({ ...BASE, runTimeoutMs: 1_800_000 });
    expect(legacy.ok && legacy.value.runTimeoutMs).toBe(1_800_000);
    expect(parseRemoteConfig({ ...BASE, runTimeoutMs: -1 }).ok).toBe(false);
  });

  test("the approval wait is 15 minutes by default and bounded to 30 s .. 1 h", () => {
    expect(DEFAULT_APPROVAL_WAIT_MS).toBe(900_000);
    const absent = parseRemoteConfig(BASE);
    expect(absent.ok && absent.value.approvalTimeoutMs).toBe(900_000);
    expect(parseRemoteConfig({ ...BASE, approvalTimeoutMs: 30_000 }).ok).toBe(true);
    expect(parseRemoteConfig({ ...BASE, approvalTimeoutMs: 3_600_000 }).ok).toBe(true);
    expect(parseRemoteConfig({ ...BASE, approvalTimeoutMs: 29_999 }).ok).toBe(false);
    expect(parseRemoteConfig({ ...BASE, approvalTimeoutMs: 3_600_001 }).ok).toBe(false);
    expect(parseRemoteConfig({ ...BASE, approvalTimeoutMs: 1.5 }).ok).toBe(false);
  });

  test("a file written without the new keys keeps its explicit values and gets the defaults", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    mkdirSync(path.join(dir, "remote"), { recursive: true });
    writeFileSync(path.join(dir, "remote", "config.json"), JSON.stringify({ ...BASE, orphanMs: 5_000, runTimeoutMs: 1_800_000 }), { mode: 0o600 });
    const loaded = loadRemoteConfig(dir);
    expect(loaded.ok && loaded.value).toMatchObject({ orphanMs: 5_000, runTimeoutMs: 1_800_000, permissionMode: "trust", approvalTimeoutMs: 900_000 });
  });

  test("saving does not write a key the caller did not set", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const file = path.join(dir, "remote", "config.json");
    const saved = saveRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1], orphanMs: 5_000, runTimeoutMs: 0 }, dir);
    expect(saved.ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object).sort()).toEqual(["allowedUserIds", "chatId", "orphanMs", "runTimeoutMs", "schemaVersion"]);
    saveRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1], orphanMs: 5_000, runTimeoutMs: 0, permissionMode: "ask" }, dir);
    const again = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(again.permissionMode).toBe("ask");
    expect("approvalTimeoutMs" in again).toBe(false);
  });
});

describe("updateRemotePolicy (AC19)", () => {
  function seed(extra: Record<string, unknown> = {}): { dir: string; file: string } {
    const dir = makeRemoteDir();
    dirs.push(dir);
    mkdirSync(path.join(dir, "remote"), { recursive: true });
    const file = path.join(dir, "remote", "config.json");
    writeFileSync(file, JSON.stringify({ ...BASE, orphanMs: 5_000, ...extra }), { mode: 0o600 });
    return { dir, file };
  }
  const onDisk = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

  test("writes only the named key; absent keys stay absent so a later default change reaches them", () => {
    const { dir, file } = seed();
    const saved = updateRemotePolicy({ permissionMode: "ask" }, dir);
    expect(saved.ok && saved.value.permissionMode).toBe("ask");
    expect(Object.keys(onDisk(file)).sort()).toEqual(["allowedUserIds", "chatId", "orphanMs", "permissionMode", "schemaVersion"]);
  });

  test("changes several keys at once and keeps the others exactly as they were", () => {
    const { dir, file } = seed({ runTimeoutMs: 1_800_000, permissionMode: "ask" });
    updateRemotePolicy({ runTimeoutMs: 0, approvalTimeoutMs: 120_000 }, dir);
    expect(onDisk(file)).toMatchObject({ chatId: -1001, allowedUserIds: [1], orphanMs: 5_000, permissionMode: "ask", runTimeoutMs: 0, approvalTimeoutMs: 120_000 });
    const loaded = loadRemoteConfig(dir);
    expect(loaded.ok && loaded.value.approvalTimeoutMs).toBe(120_000);
  });

  test("a value outside the schema is refused with a reason and the file is untouched", () => {
    const { dir, file } = seed();
    const before = readFileSync(file, "utf8");
    const bad = updateRemotePolicy({ approvalTimeoutMs: 10 }, dir);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain("approvalTimeoutMs");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("auto is refused here too, whatever the type says", () => {
    const { dir, file } = seed();
    const before = readFileSync(file, "utf8");
    const bad = updateRemotePolicy({ permissionMode: "auto" as unknown as "ask" }, dir);
    expect(bad.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("no config file: refused, says to connect, creates nothing", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const result = updateRemotePolicy({ permissionMode: "ask" }, dir);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("connect Telegram first");
    expect(loadRemoteConfig(dir).ok).toBe(false);
  });

  test("a file that is not valid JSON is refused without being rewritten", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    mkdirSync(path.join(dir, "remote"), { recursive: true });
    const file = path.join(dir, "remote", "config.json");
    writeFileSync(file, "{ nope", { mode: 0o600 });
    const result = updateRemotePolicy({ permissionMode: "ask" }, dir);
    expect(!result.ok && result.reason).toContain("not valid JSON");
    expect(readFileSync(file, "utf8")).toBe("{ nope");
  });
});

async function session(sessionId: string, name: string): Promise<{ client: RemoteClient; threadId: number }> {
  const client = rig.makeClient({ sessionId, project: `/work/${name}`, name, onLine: () => undefined });
  const started = await client.start();
  if (!started.ok) {
    throw new Error(`session ${sessionId} did not start: ${started.message}`);
  }
  return { client, threadId: started.threadId };
}

function promptIn(threadId: number): FakeSentMessage | undefined {
  return rig.api.sentTo(threadId).find((message) => message.inlineKeyboard !== undefined);
}

async function untilPrompt(threadId: number): Promise<{ message: FakeSentMessage; allow: string; deny: string; always: string | undefined }> {
  await until(() => promptIn(threadId) !== undefined, "the approval buttons");
  const message = promptIn(threadId) as FakeSentMessage;
  const buttons = (message.inlineKeyboard ?? []).flat();
  const allow = buttons.find((button) => button.text === "Allow")?.callback_data as string;
  const deny = buttons.find((button) => button.text === "Deny")?.callback_data as string;
  const always = buttons.find((button) => button.text.startsWith("Always"))?.callback_data;
  return { message, allow, deny, always };
}

function current(messageId: number): FakeSentMessage {
  const message = rig.api.message(messageId);
  if (message === undefined) {
    throw new Error(`message ${messageId} is not in the topic`);
  }
  return message;
}

describe("registration delivers the policy (AC4, AC6, AC8)", () => {
  test("the shell learns permissionMode, runTimeoutMs and approvalTimeoutMs from serve's config", async () => {
    rig = makeRig({ config: { permissionMode: "ask", runTimeoutMs: 1_800_000, approvalTimeoutMs: 120_000 } });
    await rig.startServe();
    const { client } = await session("sess-pol-0001", "policy");
    expect(client.permissionMode).toBe("ask");
    expect(client.runTimeoutMs).toBe(1_800_000);
    expect(client.approvalTimeoutMs).toBe(120_000);
  });

  test("with a default config: trust, no run limit, 15 minutes", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client } = await session("sess-pol-0002", "policy");
    expect(client.permissionMode).toBe("trust");
    expect(client.runTimeoutMs).toBe(0);
    expect(client.approvalTimeoutMs).toBe(900_000);
  });
});

describe("the Always button (AC9, AC10)", () => {
  test("the callback data carries the new decision as ap:<id>:always", () => {
    expect(parseApprovalCallback(approvalCallbackData("ap0123456789ab", "always"))).toEqual({ approvalId: "ap0123456789ab", decision: "always" });
  });

  test("with a pattern the prompt shows Allow | Deny | Always: <pattern> and the body names the pattern", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0001", "always");
    void client.askApproval("Run `docker ps`?", 10_000, { remember: "docker ps" });
    const prompt = await untilPrompt(threadId);
    expect(prompt.always).toBeDefined();
    const labels = (prompt.message.inlineKeyboard ?? []).flat().map((button) => button.text);
    expect(labels).toEqual(["Allow", "Deny", "Always: docker ps"]);
    expect(prompt.message.text).toContain("Always would remember");
    expect(prompt.message.text).toContain("docker ps");
  });

  test("a long pattern is cut to the button limit; the full pattern stays in the message", async () => {
    const long = `git ${"commit-".repeat(40)}*`;
    expect(alwaysButtonText(long).length).toBeLessThanOrEqual(MAX_BUTTON_TEXT_CHARS);
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0002", "always");
    void client.askApproval("Run it?", 10_000, { remember: long });
    const prompt = await untilPrompt(threadId);
    expect(prompt.message.text).toContain(long);
  });

  test("an Always press by an allowed user answers always with the user id; Remembered replaces the saving note", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0003", "always");
    const answer = client.askApproval("Run `docker ps`?", 10_000, { remember: "docker ps" });
    const prompt = await untilPrompt(threadId);
    rig.api.pushCallback({ fromId: OWNER_ID, data: prompt.always as string, threadId, messageId: prompt.message.messageId });
    const got = await answer;
    expect(got.decision).toBe("always");
    expect(got.fromId).toBe(OWNER_ID);
    expect(got.approvalId).toBeDefined();
    await until(() => current(prompt.message.messageId).text.includes("Saving the rule"), "the saving note");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeUndefined();

    await client.reportApprovalResult(got.approvalId as string, true);
    await until(() => current(prompt.message.messageId).text.includes("Remembered: docker ps"), "the remembered note");
    const text = current(prompt.message.messageId).text;
    expect(text).toContain(`Allowed by user ${OWNER_ID}`);
    expect(text).not.toContain("Saving the rule");
    expect(text).toContain("Run `docker ps`?");

    // The report counts once: a second one changes nothing.
    const edits = rig.api.edits.length;
    await client.reportApprovalResult(got.approvalId as string, false);
    await settle();
    expect(rig.api.edits.length).toBe(edits);
    expect(current(prompt.message.messageId).text).toContain("Remembered: docker ps");
  });

  test("a pattern the shell could not save says so and keeps the one-time approval", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0004", "always");
    const answer = client.askApproval("Run `docker ps`?", 10_000, { remember: "docker ps" });
    const prompt = await untilPrompt(threadId);
    rig.api.pushCallback({ fromId: OWNER_ID, data: prompt.always as string, threadId, messageId: prompt.message.messageId });
    const got = await answer;
    await client.reportApprovalResult(got.approvalId as string, false);
    await until(() => current(prompt.message.messageId).text.includes("Not remembered"), "the not-remembered note");
    expect(current(prompt.message.messageId).text).toContain("approved this once");
  });

  test("an Always press from a user outside allowedUserIds changes nothing and the approval stays pending", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0005", "always");
    const answer = client.askApproval("Run `docker ps`?", 600, { remember: "docker ps" });
    const prompt = await untilPrompt(threadId);
    rig.api.pushCallback({ fromId: STRANGER_ID, data: prompt.always as string, threadId, messageId: prompt.message.messageId });
    await settle();
    await settle();
    expect(current(prompt.message.messageId).text).not.toContain("Allowed by");
    expect(current(prompt.message.messageId).inlineKeyboard).toBeDefined();
    // Nobody allowed it: it expires and is denied.
    expect((await answer).decision).toBe("deny");
  });

  test("an Always press on an approval that never offered it approves nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0006", "always");
    const answer = client.askApproval("Delete it?", 600);
    const prompt = await untilPrompt(threadId);
    expect(prompt.always).toBeUndefined();
    const parsed = parseApprovalCallback(prompt.allow) as { approvalId: string };
    rig.api.pushCallback({ fromId: OWNER_ID, data: approvalCallbackData(parsed.approvalId, "always"), threadId, messageId: prompt.message.messageId });
    await settle();
    await settle();
    expect(current(prompt.message.messageId).text).not.toContain("Allowed by");
    expect((await answer).decision).toBe("deny");
  });

  test("an expired offer: a late Always press changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0007", "always");
    const answer = client.askApproval("Run `docker ps`?", 300, { remember: "docker ps" });
    const prompt = await untilPrompt(threadId);
    expect((await answer).decision).toBe("deny");
    await until(() => current(prompt.message.messageId).text.includes("Expired at"), "the expiry edit");
    rig.api.pushCallback({ fromId: OWNER_ID, data: prompt.always as string, threadId, messageId: prompt.message.messageId });
    await settle();
    await settle();
    expect(current(prompt.message.messageId).text).toContain("Expired at");
    expect(current(prompt.message.messageId).text).not.toContain("Saving the rule");
  });

  test("a result report for an approval that was not answered with Always is refused", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const { client, threadId } = await session("sess-aw-0008", "always");
    const answer = client.askApproval("Run `docker ps`?", 10_000, { remember: "docker ps" });
    const prompt = await untilPrompt(threadId);
    rig.api.pushCallback({ fromId: OWNER_ID, data: prompt.allow, threadId, messageId: prompt.message.messageId });
    const got = await answer;
    expect(got.decision).toBe("allow");
    const response = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/approval-result", {
      sessionId: "sess-aw-0008",
      approvalId: got.approvalId,
      remembered: true,
    });
    expect(response.status).toBe(404);
    expect(current(prompt.message.messageId).text).not.toContain("Remembered");
  });

  test("a remember value with control characters or over the limit is rejected", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    await session("sess-aw-0009", "always");
    for (const remember of ["a\nb", "x".repeat(301), "", 5]) {
      const response = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/approval", {
        sessionId: "sess-aw-0009",
        prompt: "Run it?",
        remember,
      });
      expect(response.status).toBe(400);
    }
  });

  test("a secret in the pattern is redacted before it reaches the topic", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-aw-0010", "always");
    const token = "7123456789:AAHsecretsecretsecretsecretsecret123";
    void client.askApproval("Run it?", 10_000, { remember: `curl -H ${token}` });
    const prompt = await untilPrompt(threadId);
    const everything = `${prompt.message.text} ${(prompt.message.inlineKeyboard ?? []).flat().map((b) => b.text).join(" ")}`;
    expect(everything).not.toContain(token);
  });
});

describe("a malformed approval event is never a yes (fail closed)", () => {
  /** Feed one raw `approval` frame to the client, as the stream would. */
  function feed(client: RemoteClient, payload: unknown): void {
    (client as unknown as { handleFrame: (event: string, data: string) => void }).handleFrame("approval", typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  function pendingId(client: RemoteClient): string {
    const waiters = (client as unknown as { waiters: Map<string, unknown> }).waiters;
    return [...waiters.keys()][0] as string;
  }

  test("a decision that is not allow, always or deny resolves the waiting call as a deny", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client } = await session("sess-mal-0001", "malformed");
    for (const decision of ["yes", "ALLOW", "", 1, null, true, { x: 1 }, undefined]) {
      const answer = client.askApproval("Run it?", 10_000, { remember: "ls" });
      await until(() => (client as unknown as { waiters: Map<string, unknown> }).waiters.size === 1, "the waiter");
      feed(client, { approvalId: pendingId(client), ...(decision === undefined ? {} : { decision }), fromId: 7 });
      const got = await answer;
      expect(got.decision).toBe("deny");
    }
  });

  test("a payload without a usable approval id is ignored; the call keeps waiting", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client } = await session("sess-mal-0002", "malformed");
    const answer = client.askApproval("Run it?", 10_000);
    await until(() => (client as unknown as { waiters: Map<string, unknown> }).waiters.size === 1, "the waiter");
    const id = pendingId(client);
    for (const payload of ["not json", "null", "5", "[]", { decision: "allow" }, { approvalId: 5, decision: "allow" }, { approvalId: "", decision: "allow" }]) {
      feed(client, payload);
    }
    expect((client as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(1);
    feed(client, { approvalId: id, decision: "allow", fromId: "not a number" });
    const got = await answer;
    expect(got.decision).toBe("allow");
    expect(got.fromId).toBeUndefined();
  });

  test("readApprovalEvent keeps a whole-number user id and nothing else", () => {
    expect(readApprovalEvent({ approvalId: "a1", decision: "always", fromId: 9 })).toEqual({ approvalId: "a1", pressed: { decision: "always", fromId: 9 } });
    expect(readApprovalEvent({ approvalId: "a1", decision: "allow", fromId: 1.5 })).toEqual({ approvalId: "a1", pressed: { decision: "allow" } });
    expect(readApprovalEvent({ approvalId: "a1", decision: "maybe" })).toEqual({ approvalId: "a1", pressed: { decision: "deny" } });
    expect(readApprovalEvent(null)).toBeUndefined();
    expect(readApprovalEvent("x")).toBeUndefined();
  });
});
