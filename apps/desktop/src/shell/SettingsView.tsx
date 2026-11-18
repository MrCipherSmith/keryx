import { useEffect, useRef, useState } from "react";
import { hostKind, pickFile, settingsGet, settingsSet, type KeryxSource, type Settings } from "../platform/commands";
import { setPrefs, usePrefs, MOD, PALETTES, type PaletteId, type Prefs } from "../lib/prefs";
import { errMessage } from "../lib/format";
import { RETENTION_CHOICES, retentionDays, setRetentionDays } from "../lib/retention";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import { useToast } from "../components/Toasts";

const SOURCES: Array<{ id: KeryxSource; label: string; help: string }> = [
  { id: "auto", label: "Automatic", help: "keryx on your PATH (an npm install, updated with npm i -g), else the keryx inside this app (recommended)." },
  { id: "bundled", label: "Bundled keryx", help: "The keryx inside this app. Always compatible, updated only with the app." },
  { id: "path", label: "keryx on PATH", help: "The keryx your login shell finds, such as a Homebrew or npm install." },
  { id: "custom", label: "Custom executable", help: "A binary or wrapper script you choose, such as a development build." },
];

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PaletteSwatch({ id, label, checked, canvas, surface, accent }: { id: PaletteId; label: string; checked: boolean; canvas?: string; surface?: string; accent?: string }) {
  return (
    <button className="palette-swatch" role="radio" aria-checked={checked} aria-label={label} title={label} onClick={() => setPrefs({ palette: id })}>
      <span
        className="palette-chip"
        style={canvas ? { background: canvas, borderColor: accent } : undefined}
        data-default={canvas ? undefined : "true"}
      >
        {canvas ? (
          <>
            <span className="palette-chip-surface" style={{ background: surface }} />
            <span className="palette-chip-accent" style={{ background: accent }} />
          </>
        ) : null}
      </span>
      <span className="palette-label">{label}</span>
    </button>
  );
}

export function SettingsView({ onBack, agentVersion }: { onBack?: () => void; agentVersion?: string | null }) {
  const prefs = usePrefs();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [retention, setRetention] = useState(retentionDays);
  const toast = useToast();

  useEffect(() => {
    void settingsGet()
      .then(setSettings)
      .catch((e) => setError(errMessage(e)));
    void hostKind().then(setHost);
  }, []);

  // Bumped by every edit: a save that finishes after one must not overwrite it.
  const rev = useRef(0);
  const update = (patch: Partial<Settings>) => {
    rev.current += 1;
    setDirty(true);
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
  };

  const save = async () => {
    if (!settings) return;
    const started = rev.current;
    setSaving(true);
    try {
      const stored = await settingsSet(settings);
      if (rev.current === started) {
        setSettings(stored);
        setDirty(false);
      }
      setError(null);
      toast({ level: "ok", title: "Settings saved", body: "The keryx choice applies to windows opened or restarted from now on." });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-view">
      <div className="settings-col">
        <header className="settings-head">
          {onBack ? (
            <button className="icon-btn" onClick={onBack} aria-label="Back" title="Back">
              <Icon name="chevronRight" size={16} className="flip" />
            </button>
          ) : null}
          {onBack ? <h1>Settings</h1> : <h1 className="sr-only">Settings</h1>}
        </header>

        <section className="settings-group" aria-labelledby="s-appearance">
          <h2 id="s-appearance">Appearance</h2>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Theme</div>
              <div className="settings-row-help">System follows macOS light and dark mode.</div>
            </div>
            <Segmented<Prefs["theme"]>
              label="Theme"
              value={prefs.theme}
              onChange={(theme) => setPrefs({ theme })}
              options={[
                { id: "system", label: "System" },
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
              ]}
            />
          </div>
          <div className="settings-row palette-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Color theme</div>
              <div className="settings-row-help">Dark and Black themes are always dark. Default follows the choice above.</div>
            </div>
            <div className="palette-picker" role="radiogroup" aria-label="Color theme">
              <PaletteSwatch id="default" label="Default" checked={prefs.palette === "default"} />
              {(["dark", "black"] as const).map((group) => (
                <div className="palette-group" key={group}>
                  <div className="palette-group-title">{group === "dark" ? "Dark" : "Black"}</div>
                  <div className="palette-swatches">
                    {PALETTES.filter((p) => p.group === group).map((p) => (
                      <PaletteSwatch key={p.id} id={p.id} label={p.label} checked={prefs.palette === p.id} canvas={p.canvas} surface={p.surface} accent={p.accent} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Font</div>
              <div className="settings-row-help">The interface and the conversation.</div>
            </div>
            <Segmented<Prefs["font"]>
              label="Font"
              value={prefs.font}
              onChange={(font) => setPrefs({ font })}
              options={[
                { id: "system", label: "System" },
                { id: "rounded", label: "Rounded" },
                { id: "serif", label: "Serif" },
                { id: "mono", label: "Mono" },
              ]}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Code font</div>
              <div className="settings-row-help">Code blocks, commands and tool output.</div>
            </div>
            <Segmented<Prefs["codeFont"]>
              label="Code font"
              value={prefs.codeFont}
              onChange={(codeFont) => setPrefs({ codeFont })}
              options={[
                { id: "sf-mono", label: "SF Mono" },
                { id: "menlo", label: "Menlo" },
                { id: "monaco", label: "Monaco" },
                { id: "courier", label: "Courier" },
              ]}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Text size</div>
            </div>
            <Segmented<Prefs["textSize"]>
              label="Text size"
              value={prefs.textSize}
              onChange={(textSize) => setPrefs({ textSize })}
              options={[
                { id: "small", label: "Small" },
                { id: "default", label: "Default" },
                { id: "large", label: "Large" },
                { id: "larger", label: "Larger" },
              ]}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Conversation width</div>
              <div className="settings-row-help">Full runs the conversation across the whole window.</div>
            </div>
            <Segmented<Prefs["chatWidth"]>
              label="Conversation width"
              value={prefs.chatWidth}
              onChange={(chatWidth) => setPrefs({ chatWidth })}
              options={[
                { id: "narrow", label: "Narrow" },
                { id: "wide", label: "Wide" },
                { id: "full", label: "Full" },
              ]}
            />
          </div>
        </section>

        <section className="settings-group" aria-labelledby="s-composer">
          <h2 id="s-composer">Composer</h2>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Send a message with</div>
              <div className="settings-row-help">
                {prefs.sendKey === "enter" ? "Shift+Return adds a new line." : "Return adds a new line."}
              </div>
            </div>
            <Segmented<Prefs["sendKey"]>
              label="Send key"
              value={prefs.sendKey}
              onChange={(sendKey) => setPrefs({ sendKey })}
              options={[
                { id: "enter", label: "Return" },
                { id: "mod-enter", label: `${MOD}Return` },
              ]}
            />
          </div>
        </section>

        <section className="settings-group" aria-labelledby="s-sessions">
          <h2 id="s-sessions">Sessions</h2>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Archive idle sessions after</div>
              <div className="settings-row-help">
                A session with no messages for this long moves to Archived. Pinned sessions and ones still running stay.
              </div>
            </div>
            <Segmented<string>
              label="Archive idle sessions after"
              value={String(retention)}
              onChange={(v) => {
                setRetentionDays(Number(v));
                setRetention(Number(v));
              }}
              options={RETENTION_CHOICES.map((d) => ({ id: String(d), label: d === 0 ? "Never" : `${d} d` }))}
            />
          </div>
        </section>

        <section className="settings-group" aria-labelledby="s-keryx">
          <h2 id="s-keryx">Which keryx to run</h2>
          {host === "browser-dev" ? (
            <div className="inline-banner tone-info">
              <Icon name="info" size={14} />
              <span>
                Browser dev mode always runs <code>KERYX_DEV_CMD</code> from the dev bridge; this choice is stored but not used.
              </span>
            </div>
          ) : null}
          {!settings ? (
            <div className="loading-row">{error ?? <><Spinner /> Loading…</>}</div>
          ) : (
            <>
              <div className="choice-list" role="radiogroup" aria-label="keryx source">
                {SOURCES.map((s) => (
                  <label key={s.id} className={`choice${settings.keryxSource === s.id ? " is-on" : ""}`}>
                    <input type="radio" name="source" checked={settings.keryxSource === s.id} onChange={() => update({ keryxSource: s.id })} />
                    <span>
                      <span className="choice-label">{s.label}</span>
                      <span className="choice-help">{s.help}</span>
                    </span>
                  </label>
                ))}
              </div>
              {settings.keryxSource === "custom" ? (
                <div className="field-row">
                  <label className="field grow">
                    <span className="field-label">Executable</span>
                    <input
                      className="mono"
                      placeholder="/path/to/keryx or a wrapper script"
                      value={settings.customPath ?? ""}
                      onChange={(e) => update({ customPath: e.target.value })}
                    />
                  </label>
                  <button
                    className="btn"
                    onClick={() =>
                      void pickFile("Choose a keryx executable").then((p) => {
                        if (p) update({ customPath: p });
                      })
                    }
                  >
                    Browse…
                  </button>
                </div>
              ) : null}
              <div className="settings-actions">
                {error ? <span className="field-error">{error}</span> : null}
                <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
                  {saving ? <Spinner /> : null} Save
                </button>
              </div>
            </>
          )}
        </section>

        <section className="settings-group" aria-labelledby="s-about">
          <h2 id="s-about">About</h2>
          <dl className="about-list">
            <div>
              <dt>Keryx Desktop</dt>
              <dd>0.1.0</dd>
            </div>
            {agentVersion ? (
              <div>
                <dt>keryx in this window</dt>
                <dd>{agentVersion}</dd>
              </div>
            ) : null}
            <div>
              <dt>Host</dt>
              <dd>{host === "tauri" ? "Keryx.app" : host === "browser-dev" ? "Browser dev mode (dev/bridge.ts)" : host}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
