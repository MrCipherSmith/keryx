import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, Spinner } from "../components/ui";
import { telegramServeRestart, telegramServeStart, telegramServeStatus, telegramServeStop, type TelegramServeStatus } from "../platform/commands";

const STATUS_POLL_MS = 3000;
const IDLE_STATUS_POLL_MS = 30_000;
type ServiceAction = "start" | "stop" | "restart";

function serviceLabel(status: TelegramServeStatus): string {
  switch (status.state) {
    case "not_configured": return "Not configured";
    case "needs_setup": return "Setup incomplete";
    case "stopped": return "Stopped";
    case "starting": return "Starting";
    case "stopping": return "Stopping";
    case "running": return status.ownership === "desktop" ? "Running · Desktop managed" : "Running · external";
    case "blocked": return "Unavailable";
    case "failed": return "Failed";
  }
}

/** Machine-level service controls. Children extend the section with channel controls. */
export function TelegramServeSettings({ children }: { children?: (channelRefreshKey: number) => ReactNode }) {
  const [status, setStatus] = useState<TelegramServeStatus | null>(null);
  const [channelRefreshKey, setChannelRefreshKey] = useState(0);
  const [busy, setBusy] = useState<ServiceAction | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"stop" | "restart" | null>(null);
  const alive = useRef(false);
  const busyRef = useRef(false);
  const refreshing = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (busyRef.current || refreshing.current) return;
    refreshing.current = true;
    const request = ++revision.current;
    try {
      const next = await telegramServeStatus();
      if (alive.current && revision.current === request) {
        setStatus((current) => current?.state === "needs_setup" && next.state === "stopped" ? current : next);
        setChannelRefreshKey((key) => key + 1);
        setError("");
      }
    } catch {
      if (alive.current && revision.current === request) setError("Could not check the local service. Retry in Keryx Desktop.");
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; revision.current += 1; };
  }, [refresh]);

  useEffect(() => {
    const interval = status?.state === "starting" || status?.state === "stopping" ? STATUS_POLL_MS : IDLE_STATUS_POLL_MS;
    const timer = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(timer);
  }, [status?.state, refresh]);

  const run = async (action: ServiceAction, completeSetup = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const request = ++revision.current;
    setBusy(action);
    setError("");
    setConfirm(null);
    try {
      const next = action === "start" ? await telegramServeStart(completeSetup) : action === "stop" ? await telegramServeStop() : await telegramServeRestart();
      if (alive.current && revision.current === request) {
        setStatus(next);
        setChannelRefreshKey((key) => key + 1);
      }
    } catch {
      if (alive.current && revision.current === request) setError("The service action could not be completed. Check its status and retry.");
    } finally {
      busyRef.current = false;
      if (alive.current && revision.current === request) setBusy(null);
    }
  };

  const transitioning = busy !== null || status?.state === "starting" || status?.state === "stopping";
  const owned = status?.ownership === "desktop";
  const canStop = owned && (status?.state === "running" || status?.state === "failed" || status?.state === "blocked");
  const canStart = status && (status.state === "not_configured" || status.state === "stopped" || status.state === "needs_setup" || (status.state === "failed" && !status.ownership));
  const startLabel = status?.state === "not_configured" ? "Set up and start" : status?.state === "needs_setup" ? "Complete setup and start" : "Start";

  return (
    <section className="settings-group" aria-labelledby="telegram-service-title">
      <h2 id="telegram-service-title">Telegram</h2>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">Local service</div>
          <p className="settings-row-help">Runs on this Mac and is shared across projects. Closing Settings keeps it running.</p>
        </div>
        <span role="status">{busy ? `${busy === "start" ? "Starting" : busy === "stop" ? "Stopping" : "Restarting"}…` : status ? serviceLabel(status) : "Checking…"}</span>
      </div>
      {status?.state === "needs_setup" ? <p className="settings-row-help">Completing setup creates a local API credential and preserves your existing service settings.</p> : null}
      {status?.ownership === "external" && status.state === "running" ? <p className="settings-row-help">Stop or restart this service from the process that owns it.</p> : null}
      {canStop && status?.activeSessions === undefined ? <p className="settings-row-help">The number of connected remote sessions is unavailable. Stopping the service may interrupt them.</p> : null}
      {status?.reason ? <p className="field-error" role="alert">{status.reason}</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="settings-actions">
        {canStart ? <button className="btn btn-primary" disabled={transitioning} onClick={() => void run("start", status.state === "needs_setup")}>{busy === "start" ? <Spinner /> : null}{startLabel}</button> : null}
        {canStop ? <button className="btn" disabled={transitioning} onClick={() => setConfirm("stop")}>Stop</button> : null}
        {owned && status?.state === "running" ? <button className="btn" disabled={transitioning} onClick={() => setConfirm("restart")}>Restart</button> : null}
        <button className="btn btn-ghost" disabled={transitioning} onClick={() => void refresh()}>{error || status?.state === "blocked" || status?.state === "failed" ? "Retry" : "Refresh"}</button>
      </div>
      {status || error ? children?.(channelRefreshKey) : null}
      {confirm ? (
        <Dialog title={confirm === "stop" ? "Stop local service?" : "Restart local service?"} onClose={() => setConfirm(null)} footer={<>
          <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={transitioning || !owned} onClick={() => void run(confirm)}>{confirm === "stop" ? "Stop service" : "Restart service"}</button>
        </>}>
          <p>This may interrupt connected remote sessions. Your service settings and bot connection will be kept.</p>
        </Dialog>
      ) : null}
    </section>
  );
}
