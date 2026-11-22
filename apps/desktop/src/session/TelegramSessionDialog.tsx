import { useRef, useState, type FormEvent } from "react";
import { Dialog } from "../components/ui";
import { openExternal } from "../platform/commands";
import type { TelegramAttachment } from "./telegramSession";

interface Props {
  supported: boolean;
  attachment?: TelegramAttachment | null;
  onControl: (operation: "status" | "attach" | "detach", topicName?: string) => Promise<boolean>;
  onSettings: () => void;
  onClose: () => void;
}

const unavailableMessages: Record<string, string> = {
  "serve-unavailable": "Start the local service in Integrations and try again.",
  "connection-lost": "The local service connection was lost. Check the service and try again.",
  "pairing-required": "Connect a Telegram bot in Integrations first.",
  "capability-unavailable": "Update Keryx and restart the local service to share this session.",
  "lease-lost": "Reopen this session before sharing it.",
  "topic-archived": "The topic was archived. Share the session again to create a new one.",
  "operation-failed": "Keryx could not open the topic. Check the bot's access and try again.",
};

export function TelegramSessionDialog({ supported, attachment, onControl, onSettings, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const name = useRef<HTMLInputElement>(null);
  const state = attachment?.state;
  const run = async (operation: "status" | "attach" | "detach", topicName?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!await onControl(operation, topicName)) setError("This session is unavailable. Reopen it and try again.");
    } catch {
      setError("Could not check the Telegram session. Check the local service and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const attach = (event: FormEvent) => {
    event.preventDefault();
    void run("attach", name.current?.value.trim());
  };

  return <Dialog title="Telegram session" icon="telegram" onClose={onClose}
    footer={<button className="btn" onClick={onClose}>Close</button>}>
    {!supported ? <>
      <p>This version of Keryx does not support sharing Desktop sessions. In the terminal, use <code>/channels</code> to connect the bot and <code>/remote-control</code> to share a shell session.</p>
      <button className="btn" onClick={onSettings}>Open Integrations</button>
    </> : state === "active" || state === "reconnecting" || state === "attaching" ? <>
      <p role="status">{state === "active" ? "This session is shared in Telegram." : state === "reconnecting" ? "Reconnecting to the Telegram topic…" : "Creating a Telegram topic…"}</p>
      <div className="settings-actions">
        {attachment?.topicUrl ? <button className="btn" onClick={() => void openExternal(attachment.topicUrl!).catch(() => setError("Could not open the Telegram topic."))}>Open topic</button> : null}
        <button className="btn" disabled={busy} onClick={() => void run("detach")}>Detach</button>
      </div>
    </> : <>
      {state === "unavailable" || attachment?.reason ? <p role="status">{unavailableMessages[attachment?.reason ?? ""] ?? "Telegram is unavailable for this session."}</p> : null}
      <form onSubmit={attach}>
        <label className="field"><span className="field-label">Topic name (optional)</span><input ref={name} type="text" maxLength={100} disabled={busy} /></label>
        <div className="settings-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>Share in Telegram</button>
          <button className="btn" type="button" onClick={onSettings}>Open Integrations</button>
        </div>
      </form>
    </>}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
  </Dialog>;
}
