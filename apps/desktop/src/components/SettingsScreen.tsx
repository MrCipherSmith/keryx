import { useEffect, useState } from "react";
import { pickFile, settingsGet, settingsSet, type KeryxSource, type Settings } from "../platform/commands";

const SOURCES: Array<{ id: KeryxSource; label: string; help: string }> = [
  { id: "bundled", label: "Bundled keryx", help: "The keryx that ships inside this app (recommended)." },
  { id: "path", label: "keryx on PATH", help: "The `keryx` your login shell finds, for example a Homebrew or npm install." },
  { id: "custom", label: "Custom path", help: "An executable you choose, such as a wrapper that runs a development build." },
];

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void settingsGet().then(setSettings).catch((e) => setError(String(e)));
  }, []);

  if (!settings) return <div className="settings"><p className="muted">{error ?? "Loading…"}</p></div>;

  const update = (patch: Partial<Settings>) => {
    setSaved(false);
    setSettings({ ...settings, ...patch });
  };

  const browse = async () => {
    const picked = await pickFile("Choose a keryx executable");
    if (picked) update({ customPath: picked });
  };

  const save = async () => {
    try {
      setSettings(await settingsSet(settings));
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="settings">
      <div className="settings-card">
        <header className="settings-head">
          <button className="btn btn-small" onClick={onBack}>‹ Back</button>
          <h2>Settings</h2>
        </header>
        <h3>Which keryx to run</h3>
        <div className="radios">
          {SOURCES.map((s) => (
            <label key={s.id} className="radio">
              <input type="radio" name="source" checked={settings.keryxSource === s.id} onChange={() => update({ keryxSource: s.id })} />
              <span><span className="ask-label">{s.label}</span><span className="hint block">{s.help}</span></span>
            </label>
          ))}
        </div>
        {settings.keryxSource === "custom" ? (
          <div className="row">
            <input
              className="text-input"
              placeholder="/path/to/keryx or a wrapper script"
              value={settings.customPath ?? ""}
              onChange={(e) => update({ customPath: e.target.value })}
            />
            <button className="btn" onClick={() => void browse()}>Browse…</button>
          </div>
        ) : null}
        <div className="row">
          <button className="btn btn-primary" onClick={() => void save()}>Save</button>
          {saved ? <span className="muted">Saved. Applies to windows opened or restarted from now on.</span> : null}
          {error ? <span className="notice-error">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
