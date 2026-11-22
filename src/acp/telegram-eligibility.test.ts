import { expect, test } from "bun:test";
import { createAcpAgentIo, type AcpPermissionRequest } from "./agent-io";

test("only a host-classified non-escalated root listing is projectable", async () => {
  const asks: AcpPermissionRequest[] = [];
  const io = createAcpAgentIo("s1", () => {}, async (ask) => { asks.push(ask); return { outcome: { outcome: "cancelled" } }; });
  const meta = { fingerprint: "f", destructive: false, risk: "read" as const, cause: "mode-ask" as const };
  await io.requestApproval?.("list_dir", '{"path":"."}', meta);
  await io.requestApproval?.("list_dir", '{"path":".."}', meta);
  await io.requestApproval?.("list_dir", '{"path":".","recursive":true}', meta);
  await io.requestApproval?.("list_dir", '{"path":"."}', { ...meta, hookAsk: true });
  await io.requestApproval?.("list_dir", '{"path":"."}', { ...meta, credentials: true });
  await io.requestApproval?.("shell_exec", '{"path":"."}', meta);
  await io.requestApproval?.("list_dir", '{"path":"."}');
  expect(asks.map((ask) => ask.telegramPrompt !== undefined)).toEqual([true, false, false, false, false, false, false]);
});
