import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hostKind, pickFile, settingsGet, settingsSet, type BrowserEngineSetting, type KeryxSource, type Settings } from "../platform/commands";
import { setPrefs, useAppearanceMode, usePrefs, MOD, PALETTES, type PaletteId, type Prefs } from "../lib/prefs";
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

const SETTINGS_TABS = [
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "sessions", label: "Sessions", icon: "chat" },
  { id: "integrations", label: "Integrations", icon: "globe" },
  { id: "desktop", label: "Desktop", icon: "settings" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

function PaletteSwatch({ id, label, checked, canvas, surface, accent, onSelect, accessibleLabel = label }: {
  id: PaletteId;
  label: string;
  checked: boolean;
  canvas?: string;
  surface?: string;
  accent?: string;
  accessibleLabel?: string;
  onSelect: (id: PaletteId) => void;
}) {
  return (
    <button className="palette-swatch" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1}
      aria-label={accessibleLabel} title={accessibleLabel} onClick={() => onSelect(id)}>
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

interface SettingsViewProps {
  onBack?: () => void;
  agentVersion?: string | null;
  integrations?: ReactNode;
  initialTab?: SettingsTab;
}

function directionalIndex(key: string, index: number, length: number): number {
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return (index + 1) % length;
  if (key === "ArrowUp" || key === "ArrowLeft") return (index + length - 1) % length;
  return -1;
}

export function SettingsView({ onBack, agentVersion, integrations, initialTab = "appearance" }: SettingsViewProps) {
  const prefs = usePrefs();
  const appearance = useAppearanceMode(prefs.theme);
  const palette = appearance === "light" ? prefs.lightPalette : prefs.darkPalette;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [retention, setRetention] = useState(retentionDays);
  const toast = useToast();

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [tab]);

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

  // The engine is saved at once, merged into the stored settings (an unsaved keryx choice stays a draft).
  const setBrowserEngine = async (browserEngine: BrowserEngineSetting) => {
    try {
      const stored = await settingsSet({ ...(await settingsGet()), browserEngine });
      setSettings((cur) => (cur ? { ...cur, browserEngine: stored.browserEngine } : stored));
      setError(null);
      toast({ level: "ok", title: "Browser engine saved", body: "It applies to projects opened from now on." });
    } catch (e) {
      setError(errMessage(e));
    }
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

  const choosePalette = (id: PaletteId) => {
    setPrefs(appearance === "light" ? { lightPalette: id } : { darkPalette: id });
  };

  const selectPaletteByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLButtonElement)) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const next = directionalIndex(e.key, buttons.indexOf(e.target), buttons.length);
    if (next < 0) return;
    e.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  };

  const selectTabByKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = directionalIndex(e.key, index, SETTINGS_TABS.length);
    if (next < 0) return;
    e.preventDefault();
    setTab(SETTINGS_TABS[next]!.id);
    tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const closeByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onBack || e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing || !(e.target instanceof Element)) return;
    if (!e.currentTarget.contains(e.target) || e.target.closest('[role="dialog"]')) return;
    e.stopPropagation();
    if (e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    onBack();
  };

  const panel = (name: SettingsTab) => ({
    className: "settings-panel",
    role: "tabpanel",
    id: `${id}-${name}-panel`,
    "aria-labelledby": `${id}-${name}-tab`,
    hidden: tab !== name,
    tabIndex: 0,
  });

  return (
    <div className="settings-view" onKeyDown={closeByKey}>
      <header className="settings-head">
        <h1>Settings</h1>
        {onBack ? (
          <button ref={closeButton} className="icon-btn" onClick={onBack} aria-label="Close Settings" title="Close Settings">
            <Icon name="x" size={17} />
          </button>
        ) : null}
      </header>
      <div className="settings-layout">
        <div className="settings-tabs" ref={tabList} role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          {SETTINGS_TABS.map(({ id: name, label, icon }, index) => (
            <button
              className="settings-tab"
              key={name}
              role="tab"
              id={`${id}-${name}-tab`}
              aria-controls={`${id}-${name}-panel`}
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
              onKeyDown={(e) => selectTabByKey(e, index)}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </div>
        <div className="settings-content" ref={content}>
          <div {...panel("appearance")}>
            <section className="settings-group" aria-labelledby="s-appearance">
              <h2 id="s-appearance" className="settings-panel-title">Appearance</h2>
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
                  <div className="settings-row-title">{appearance === "light" ? "Light palette" : "Dark palette"}</div>
                </div>
                <div className="palette-picker" role="radiogroup" aria-label="Color palette" onKeyDown={selectPaletteByKey}>
                  <div className="palette-swatches">
                    <PaletteSwatch
                      id="default"
                      label="Default"
                      checked={palette === "default"}
                      onSelect={choosePalette}
                    />
                    {PALETTES.filter((choice) => choice.group === appearance).map((choice) => (
                      <PaletteSwatch key={choice.id} {...choice} checked={palette === choice.id} onSelect={choosePalette} />
                    ))}
                  </div>
                  {appearance === "dark" ? (
                    <div className="palette-black-group" role="group" aria-label="Black palettes">
                      <div className="palette-group-title" aria-hidden="true">Black</div>
                      <div className="palette-swatches">
                        {PALETTES.filter((choice) => choice.group === "black").map((choice) => (
                      <PaletteSwatch key={choice.id} {...choice} accessibleLabel={`Black ${choice.label}`} checked={palette === choice.id} onSelect={choosePalette} />
                        ))}
                      </div>
                    </div>
                  ) : null}
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
          </div>

          <div {...panel("sessions")}>
            <h2 className="settings-panel-title">Sessions</h2>
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

            <section className="settings-group" aria-labelledby="s-retention">
              <h2 id="s-retention">Retention</h2>
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
          </div>

          <div {...panel("integrations")}>
            <h2 className="settings-panel-title">Integrations</h2>
            {integrations}
          </div>

          <div {...panel("desktop")}>
            <h2 className="settings-panel-title">Desktop</h2>
            <section className="settings-group" aria-labelledby="s-browser">
              <h2 id="s-browser">Browser panel</h2>
              <div className="settings-row">
                <div className="settings-row-text">
                  <div className="settings-row-title">Engine</div>
                  <div className="settings-row-help">
                    Chromium runs your installed Google Chrome with a separate profile for each project, so the agent clicks and types for real and
                    reads the network; WebKit is the built-in fallback. Auto picks Chromium when Chrome is installed. Applies to projects opened after the change.
                  </div>
                </div>
                <Segmented<BrowserEngineSetting>
                  label="Browser engine"
                  value={settings?.browserEngine ?? "auto"}
                  onChange={(v) => void setBrowserEngine(v)}
                  options={[
                    { id: "auto", label: "Auto" },
                    { id: "chromium", label: "Chromium" },
                    { id: "webkit", label: "WebKit" },
                  ]}
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
      </div>
    </div>
  );
}
