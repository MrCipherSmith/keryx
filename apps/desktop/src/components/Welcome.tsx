import { useEffect, useState } from "react";
import { pickFolder, settingsGet, type Settings } from "../platform/commands";
import { basename } from "../session/useAcpSession";

export function Welcome({ onOpen, onSettings }: { onOpen: (cwd: string) => void; onSettings: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void settingsGet().then(setSettings).catch(() => {});
  }, []);

  const pick = async () => {
    const picked = await pickFolder();
    if (picked) onOpen(picked);
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Keryx</h1>
        <p className="muted">Open a project folder to start working with keryx.</p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => void pick()}>Open Folder…</button>
          <button className="btn" onClick={onSettings}>Settings</button>
        </div>
        {settings && settings.recentProjects.length > 0 ? (
          <>
            <h3>Recent projects</h3>
            <ul className="recents">
              {settings.recentProjects.map((p) => (
                <li key={p}>
                  <button onClick={() => onOpen(p)} title={p}>
                    <strong>{basename(p)}</strong>
                    <span className="muted path">{p}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
