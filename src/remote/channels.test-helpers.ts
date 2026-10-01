// Scaffolding for the channels tests (flow 377): a real serve on loopback with NO remote
// config (a machine where Telegram was never connected), the in-process fake Bot API in
// front of Telegram, and the real shell-side `ChannelsClient` on the other end. Nothing
// here names an outside host.

import { ChannelsClient, type ChannelsClientOptions } from "./channels-client";
import type { OpenRemoteServiceOptions } from "./service";
import { makeRig, type Rig, type RigOptions, type ServeInstance } from "./remote.http.test-helpers";
import { OWNER_ID, until } from "./remote.test-helpers";
import type { PairingResponse } from "./protocol";

/** Shaped like a real bot token (`<digits>:<secret>`) and unmistakable in a leak scan. */
export const BOT_TOKEN = "987654321:AAHunit_test_secret_value_0123456789";
export const PAIR_CODE = "ABCD2345";

export interface ChannelsRig {
  rig: Rig;
  serve: ServeInstance;
  client: ChannelsClient;
}

export async function makeChannelsRig(
  options: { rig?: RigOptions; service?: OpenRemoteServiceOptions; client?: ChannelsClientOptions } = {},
): Promise<ChannelsRig> {
  const rig = makeRig({ configured: false, ...options.rig });
  const serve = await rig.startServe({ service: { pairing: { code: PAIR_CODE }, ...options.service } });
  const client = new ChannelsClient({ dir: rig.dir, ...options.client });
  return { rig, serve, client };
}

export async function pairingState(client: ChannelsClient): Promise<PairingResponse> {
  const status = await client.pairingStatus();
  if (!status.ok) {
    throw new Error(`pairing status failed: ${status.reason}`);
  }
  return status.value;
}

/** Drive a whole pairing the way the operator does: token, code in a private chat, bot added to the group. */
export async function pairFully(r: ChannelsRig, userId = OWNER_ID): Promise<PairingResponse> {
  const started = await r.client.startPairing(BOT_TOKEN);
  if (!started.ok) {
    throw new Error(`startPairing failed: ${started.reason}`);
  }
  r.rig.api.pushPrivateMessage({ fromId: userId, text: `/start ${PAIR_CODE}` });
  await until(async () => (await pairingState(r.client)).state === "waiting-for-group", "waiting for the group");
  r.rig.api.pushMyChatMember({ fromId: userId, title: "Keryx HQ" });
  await until(async () => (await pairingState(r.client)).state === "ready", "pairing ready");
  return pairingState(r.client);
}

/** Pair and finish: the channel is connected and the hub polls. */
export async function connectFully(r: ChannelsRig, userId = OWNER_ID): Promise<void> {
  const ready = await pairFully(r, userId);
  const done = await r.client.connectFinish({ userId: ready.userId as number, chatId: ready.chatId as number });
  if (!done.ok) {
    throw new Error(`connectFinish failed: ${done.reason}`);
  }
}
