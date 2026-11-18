// The update banner (decision D-15). The Rust core asks the resolved keryx
// (`keryx app status --json`) at startup and every 6 hours; a newer
// `desktop-v*` release, or a keryx that needs a newer app, shows this card.
// "Update and relaunch" hands over to `keryx app update --wait-pid --relaunch`
// and the app quits, so the CLI can swap the bundle.

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import { errMessage } from "../lib/format";
import { appUpdateCheck, appUpdateRun, type UpdateCheck } from "../platform/commands";

const FIRST_CHECK_MS = 4000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const DISMISSED_KEY = "keryx.update.dismissed";

export interface BannerModel {
  title: string;
  body: string;
  /** A newer release exists, so `keryx app update` has something to install. */
  canUpdate: boolean;
  /** An optional update can be put off until the next release; a required one only for this run. */
  required: boolean;
}

/** What the banner shows for a check, or `null` for nothing. `dismissed` is the release version the user put off. */
export function bannerModel(check: UpdateCheck | null, dismissed: string | null): BannerModel | null {
  if (!check) return null;
  if (check.required) {
    return {
      title: "This keryx needs a newer Keryx app",
      body: check.available
        ? `keryx ${check.keryxVersion} works with Keryx ${check.minDesktopVersion} or newer; this app is ${check.current}. Keryx ${check.latest} is available.`
        : `keryx ${check.keryxVersion} works with Keryx ${check.minDesktopVersion} or newer; this app is ${check.current}, and no newer release was found.`,
      canUpdate: check.available,
      required: true,
    };
  }
  if (!check.available || !check.latest || check.latest === dismissed) return null;
  return {
    title: `Keryx ${check.latest} is available`,
    body: `You have ${check.current}. The update downloads the release and relaunches the app.`,
    canUpdate: true,
    required: false,
  };
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // A private window: the banner comes back next start, which is fine.
  }
}

export function UpdateBanner() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const run = () =>
      void appUpdateCheck()
        .then((c) => alive && setCheck(c))
        // No banner on a failed check: the app must work offline and with an older keryx.
        .catch(() => {});
    const first = window.setTimeout(run, FIRST_CHECK_MS);
    const every = window.setInterval(run, RECHECK_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  const update = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await appUpdateRun();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }, []);

  const model = hidden ? null : bannerModel(check, dismissed);
  if (!model) return null;

  const dismiss = () => {
    if (!model.required && check?.latest) {
      writeDismissed(check.latest);
      setDismissed(check.latest);
    }
    setHidden(true);
  };

  return (
    <div className={`update-banner toast ${model.required ? "toast-error" : "toast-info"}`} role="status" aria-live="polite">
      <span className="toast-icon">
        <Icon name={model.required ? "alert" : "info"} size={16} />
      </span>
      <div className="toast-main">
        <div className="toast-title">{model.title}</div>
        <div className="toast-body">{model.body}</div>
        {error ? <div className="toast-body update-banner-error">{error}</div> : null}
        {model.canUpdate ? (
          <div className="update-banner-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void update()}>
              {busy ? <Spinner size={12} /> : <Icon name="refresh" size={14} />} Update and relaunch
            </button>
            <button className="btn" disabled={busy} onClick={dismiss}>
              {model.required ? "Later" : "Skip this version"}
            </button>
          </div>
        ) : null}
      </div>
      <div className="toast-actions">
        <button className="icon-btn" disabled={busy} onClick={() => setHidden(true)} aria-label="Hide" title="Hide">
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
