import { useEffect, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { hostKind, pickFolder, settingsGet, type Settings } from "../platform/commands";
import { basename } from "../lib/format";
import { MOD } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { Kbd } from "../components/ui";

export function Welcome({ onOpen, onSettings }: { onOpen: (cwd: string) => void | Promise<void>; onSettings: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string>("");

  useEffect(() => {
    void settingsGet()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void hostKind().then(setHost);
  }, []);

  const open = async (folder: string) => {
    setError(null);
    try {
      await onOpen(folder);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pick = async () => {
    try {
      const picked = await pickFolder();
      if (picked) await open(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recents = settings?.recentProjects ?? [];

  return (
    <div className="welcome">
      <div className="welcome-drag" data-tauri-drag-region />
      <div className="welcome-col">
        <div className="welcome-brand">
          <BrandMark className="brand-mark" />
          <div>
            <h1>Keryx</h1>
            <p>Open a project folder to work on it with keryx.</p>
          </div>
        </div>

        <button className="welcome-open" onClick={() => void pick()} autoFocus>
          <span className="welcome-open-icon">
            <Icon name="folderOpen" size={18} />
          </span>
          <span className="welcome-open-text">
            <strong>Open Folder…</strong>
            <span>keryx starts in that folder, with its sessions and flows</span>
          </span>
          <Kbd>{MOD}O</Kbd>
        </button>

        <section className="recents" aria-labelledby="recents-h">
          <h2 id="recents-h">Recent projects</h2>
          {error ? <p className="recents-empty">{error}</p> : null}
          {settings && recents.length === 0 ? <p className="recents-empty">Projects you open appear here.</p> : null}
          {recents.length > 0 ? (
            <ul>
              {recents.map((p) => (
                <li key={p}>
                  <button className="recent" onClick={() => void open(p)} title={p}>
                    <Icon name="folder" size={15} />
                    <span className="recent-name">{basename(p)}</span>
                    <span className="recent-path truncate">{p}</span>
                    <Icon name="chevronRight" size={14} className="recent-chev" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <footer className="welcome-foot">
          <button className="btn btn-ghost btn-sm" onClick={onSettings}>
            <Icon name="settings" size={13} /> Settings
          </button>
          {host === "browser-dev" ? <span className="badge badge-info">Browser dev mode</span> : null}
        </footer>
      </div>
    </div>
  );
}
