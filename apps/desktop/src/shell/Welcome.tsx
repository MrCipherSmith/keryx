import { useEffect, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { hostKind, settingsGet, type Settings } from "../platform/commands";
import { basename } from "../lib/format";
import { MOD } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { Kbd } from "../components/ui";

import type { ProjectConfig } from "./projectConfig";

export function Welcome({ onOpen, onSettings, onAddProject, saved, onOpenConfigured, modalOpen }: {
  onOpen: (cwd: string) => Promise<void>; onSettings: () => void; onAddProject: () => void;
  saved: ProjectConfig[]; onOpenConfigured: (project: ProjectConfig) => Promise<void>; modalOpen: boolean;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string>("");

  useEffect(() => {
    void settingsGet()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void hostKind().then(setHost);
  }, []);

  const open = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modalOpen && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        onAddProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, onAddProject]);

  const recents = (settings?.recentProjects ?? []).filter(path => !saved.some(project => !project.host && project.path === path));

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

        <button className="welcome-open" onClick={onAddProject} autoFocus>
          <span className="welcome-open-icon">
            <Icon name="folderOpen" size={18} />
          </span>
          <span className="welcome-open-text">
            <strong>Add Project…</strong>
            <span>Choose a local folder or connect via SSH in the desktop app</span>
          </span>
          <Kbd>{MOD}O</Kbd>
        </button>

        <section className="recents" aria-labelledby="recents-h">
          <h2 id="recents-h">Recent projects</h2>
          {error ? <p className="recents-empty">{error}</p> : null}
          {settings && recents.length === 0 && saved.length === 0 ? <p className="recents-empty">Projects you open appear here.</p> : null}
          {saved.length > 0 && <ul>{saved.map(project => {
            const target = project.host ? `${project.host}:${project.path}` : project.path;
            return <li key={target}><button className="recent" onClick={() => void open(() => onOpenConfigured(project))} title={target}>
              <Icon name="folder" size={15} /><span className="recent-name">{project.name}</span>
              <span className="recent-path truncate">{target}</span><Icon name="chevronRight" size={14} className="recent-chev" />
            </button></li>;
          })}</ul>}
          {recents.length > 0 ? (
            <ul>
              {recents.map((p) => (
                <li key={p}>
                  <button className="recent" onClick={() => void open(() => onOpen(p))} title={p}>
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
