import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
import { Dialog } from "../components/ui";
import { openExternal } from "../platform/commands";
import { telegramChannelAction, telegramChannelStatus, type TelegramChannelOperation, type TelegramChannelStatus, type TelegramChannelRequest } from "../platform/telegramChannel";

const POLL_MS = 3000;

function pairingLink(username: string | undefined, code: string | undefined): string | null {
  if (!username || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) || !code || !/^[A-Z2-9]{8}$/.test(code)) return null;
  return `https://t.me/${username}?start=${code}`;
}

function failureMessage(code: string): string {
  switch (code) {
    case "rejected": case "invalid": case "invalid-staging": return "Telegram could not accept the bot token. Check it in BotFather and try again.";
    case "conflict": return "The channel changed or another operation is active. Refresh the status and try again.";
    case "no-answer": return "The result is uncertain. Refresh the channel status before retrying.";
    case "unreachable": case "serve-down": return "The local service or Telegram could not be reached. Check the service and try again.";
    default: return "The channel action could not be completed. Refresh the status and try again.";
  }
}

function withoutSpentCode(operation: TelegramChannelOperation): TelegramChannelOperation {
  const pairing = operation.pairing;
  if (!pairing || (pairing.state === "waiting-for-user" && pairing.expiresAt > Date.now())) return operation;
  const { code: _code, ...rest } = pairing;
  return { ...operation, pairing: rest };
}

function PairingQr({ link }: { link: string }) {
  const qr = useMemo(() => QRCode.create(link, { errorCorrectionLevel: "M" }).modules, [link]);
  const margin = 4;
  const cells: ReactNode[] = [];
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (qr.get(row, col)) cells.push(<rect key={`${row}-${col}`} x={col + margin} y={row + margin} width="1" height="1" />);
    }
  }
  return <svg role="img" aria-label="Pairing QR code" viewBox={`0 0 ${qr.size + margin * 2} ${qr.size + margin * 2}`} width="176" height="176" shapeRendering="crispEdges"><rect width="100%" height="100%" fill="white" /><g fill="black">{cells}</g></svg>;
}

/** Revisioned channel operations are kept in memory; secrets are never stored. */
export function TelegramBotSettings() {
  const [channel, setChannel] = useState<TelegramChannelStatus | null>(null);
  const [operation, setOperation] = useState<TelegramChannelOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [expired, setExpired] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const mutating = useRef(false);
  const refreshing = useRef(false);
  const version = useRef(0);

  const refresh = useCallback(async () => {
    if (mutating.current || refreshing.current) return;
    refreshing.current = true;
    const requestVersion = ++version.current;
    try {
      const result = await telegramChannelStatus();
      if (!alive.current || requestVersion !== version.current) return;
      if (!result.ok) { setChannel(null); setOperation(null); setError(failureMessage(result.code)); return; }
      setChannel(result.value);
      if (result.value.capabilities?.desktopTelegram !== 1) { setOperation(null); setNeedsRefresh(false); return; }
      const pending = result.value.pendingOperation;
      if (!pending) { setOperation(null); setNeedsRefresh(false); return; }
      const detail = await telegramChannelAction({ action: "operation-status", operationId: pending.operationId, expectedRevision: pending.revision });
      if (!alive.current || requestVersion !== version.current) return;
      if (!detail.ok) { setOperation(null); setNeedsRefresh(true); setError(failureMessage(detail.code)); }
      else if ("operationId" in detail.value) { setOperation(withoutSpentCode(detail.value)); setNeedsRefresh(false); }
      else { setOperation(null); setNeedsRefresh(true); setError("The channel status could not be understood. Retry."); }
    } catch {
      if (alive.current && requestVersion === version.current) { setChannel(null); setOperation(null); setError("Could not check the Telegram channel. Retry when the local service is available."); }
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => { alive.current = false; version.current += 1; window.clearInterval(timer); };
  }, [refresh]);

  const pairing = operation?.pairing;
  useEffect(() => {
    setExpired(false);
    if (!pairing || (pairing.state !== "waiting-for-user" && pairing.state !== "waiting-for-confirmation" && pairing.state !== "waiting-for-group")) return;
    const delay = Math.max(0, pairing.expiresAt - Date.now());
    const timer = window.setTimeout(() => { setExpired(true); setOperation((old) => {
      if (!old?.pairing) return old;
      const { code: _code, ...rest } = old.pairing;
      return { ...old, pairing: { ...rest, state: "expired" } };
    }); }, delay);
    return () => window.clearTimeout(timer);
  }, [pairing?.expiresAt, pairing?.state, pairing?.code]);

  const perform = async (request: TelegramChannelRequest) => {
    if (mutating.current) return;
    mutating.current = true;
    const requestVersion = ++version.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await telegramChannelAction(request);
      if (!alive.current || requestVersion !== version.current) return;
      if (!result.ok) { setOperation(null); setNeedsRefresh(true); setError(failureMessage(result.code)); }
      else if (request.action === "test" && "delivered" in result.value && result.value.delivered) setNotice("Test message sent to the General topic.");
      else if (request.action === "disconnect" && "deleted" in result.value) { setOperation(null); setNotice(result.value.remaining > 0 ? "Bot disconnected. Some topics could not be removed." : "Bot disconnected."); }
      else if ("operationId" in result.value && (result.value.state === "cancelled" || result.value.state === "connected")) { setOperation(null); }
      else if ("operationId" in result.value) setOperation(withoutSpentCode(result.value));
      else { setNeedsRefresh(true); setError("The result is uncertain. Refresh the channel status before retrying."); }
    } catch {
      if (alive.current && requestVersion === version.current) { setOperation(null); setNeedsRefresh(true); setError("The result is uncertain. Refresh the channel status before retrying."); }
    } finally {
      mutating.current = false;
      if (alive.current && requestVersion === version.current) { setBusy(false); if (request.action !== "operation-status") void refresh(); }
    }
  };
  const begin = (event: FormEvent) => {
    event.preventDefault();
    if (!tokenInput.current || !channel || mutating.current || needsRefresh || !(channel.revision === null || (Number.isSafeInteger(channel.revision) && (channel.revision ?? 0) > 0))) return;
    const token = tokenInput.current.value.trim();
    tokenInput.current.value = "";
    if (!token) { setError("Enter a bot token from BotFather."); return; }
    void perform({ action: "begin", token, expectedRevision: channel.revision ?? null });
  };
  const runOperation = (action: "operation-status" | "cancel" | "confirm-account" | "confirm") => {
    if (operation) void perform({ action, operationId: operation.operationId, expectedRevision: operation.revision });
  };
  const copyCode = async (code: string) => {
    try { await navigator.clipboard.writeText(code); } catch { setError("Could not copy the code. Enter it manually."); }
  };
  const link = pairing?.state === "waiting-for-user" && !expired && pairing.expiresAt > Date.now() ? pairingLink(pairing.botUsername, pairing.code) : null;
  const available = channel?.capabilities?.desktopTelegram === 1;
  const configured = channel?.telegram.state === "connected" || channel?.telegram.state === "off";
  const revisionKnown = channel?.revision === null || (Number.isSafeInteger(channel?.revision) && (channel?.revision ?? 0) > 0);

  return <div>
    <h3>Bot connection</h3>
    {!available ? <p className="settings-row-help">Telegram pairing is unavailable until a compatible local service is running.</p> : null}
    {available && !revisionKnown ? <p className="field-error" role="alert">The channel revision is unavailable. Refresh before making changes.</p> : null}
    {available && !operation && channel.pendingOperation ? <p className="settings-row-help">Loading the pending pairing…</p> : null}
    {available && !operation && !channel.pendingOperation ? <>
      <p className="settings-row-help">{channel.telegram.state === "connected" ? "To change the bot token, validate a new token from BotFather." : "Connect a bot from BotFather to a Telegram forum."}</p>
      <form onSubmit={begin}>
        <label className="field"><span className="field-label">Bot token</span><input ref={tokenInput} type="password" autoComplete="off" spellCheck={false} required disabled={busy || needsRefresh || !revisionKnown} /></label>
        <div className="settings-actions"><button className="btn btn-primary" type="submit" disabled={busy || needsRefresh || !revisionKnown}>{configured ? "Change bot token" : "Connect bot"}</button></div>
      </form>
      {configured && revisionKnown ? <div className="settings-actions">
        <button className="btn" disabled={busy || needsRefresh || channel.telegram.state !== "connected"} onClick={() => void perform({ action: "test", expectedRevision: channel.revision ?? null })}>Test connection</button>
        <button className="btn" disabled={busy || needsRefresh} onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
      </div> : null}
    </> : null}
    {available && operation ? <>
      {operation.state === "same-bot-ready" ? <p>Telegram verified the same bot. Confirm to replace its token and keep the current connection.</p> : null}
      {pairing?.state === "waiting-for-user" && !expired ? <>
        <p className="settings-row-help">Send this one-time code to the bot in a private chat. It expires in ten minutes.</p>
        {link ? <><PairingQr link={link} /><div className="settings-actions"><button className="btn" onClick={() => void openExternal(link).catch(() => setError("Could not open Telegram. Send the code manually."))}>Open in Telegram</button></div></> : <p className="settings-row-help">Open the bot in Telegram and send the code manually.</p>}
        {pairing.code ? <><p><strong>{pairing.code}</strong></p><button className="btn" onClick={() => void copyCode(pairing.code ?? "")}>Copy code</button></> : null}
      </> : null}
      {pairing?.state === "waiting-for-confirmation" && pairing.userId !== undefined && !expired ? <><p>Telegram account ID: {pairing.userId}. Confirm that this is your account before connecting the group.</p><button className="btn" disabled={busy} onClick={() => runOperation("confirm-account")}>This is my account</button></> : null}
      {pairing?.state === "waiting-for-group" || pairing?.state === "ready" ? <><p className="settings-row-help">Add the bot as an administrator in your forum and grant Manage Topics.</p>{pairing.chatTitle ? <p>Forum: {pairing.chatTitle}</p> : null}{pairing.problems.map((problem) => <p className="field-error" key={problem}>{problem}</p>)}</> : null}
      {pairing?.state === "expired" || expired ? <p className="field-error">The pairing expired. Cancel it and start again.</p> : null}
      {pairing?.state === "failed" ? <p className="field-error">Pairing failed. Cancel it and try again.</p> : null}
      {pairing?.state === "ready" && channel.telegram.state === "connected" ? <p className="settings-row-help">Connecting a different bot will interrupt existing remote sessions. Each chat must be attached to a new topic.</p> : null}
      <div className="settings-actions">
        {operation.state === "same-bot-ready" || pairing?.state === "ready" ? <button className="btn btn-primary" disabled={busy || needsRefresh} onClick={() => runOperation("confirm")}>Confirm connection</button> : null}
        <button className="btn" disabled={busy} onClick={() => runOperation("operation-status")}>Check pairing</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => runOperation("cancel")}>Cancel pairing</button>
      </div>
    </> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!available || error ? <button className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>Retry channel status</button> : null}
    {confirmDisconnect && channel && revisionKnown ? <Dialog title="Disconnect Telegram bot?" onClose={() => setConfirmDisconnect(false)} footer={<><button className="btn" onClick={() => setConfirmDisconnect(false)}>Cancel</button><button className="btn btn-primary" onClick={() => { setConfirmDisconnect(false); void perform({ action: "disconnect", expectedRevision: channel.revision ?? null }); }}>Disconnect bot</button></>}><p>This disconnects Telegram for all chats and affects all connected topics on this machine.</p></Dialog> : null}
  </div>;
}
