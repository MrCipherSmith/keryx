import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type ThemeMode = "system" | "light" | "dark";
const themeKey = "keryx.hub.theme";
function savedMode(): ThemeMode {
  try {
    const value = localStorage.getItem(themeKey);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* Appearance works without storage. */
  }
  return "system";
}
function preferredDark() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}
function apply(mode: ThemeMode) {
  document.documentElement.dataset.theme =
    mode === "system" ? (preferredDark() ? "dark" : "light") : mode;
}
apply(savedMode());
export function ThemeSelect({ preferred, onSelect, disabled }: { preferred?: ThemeMode | null; onSelect?: (mode: ThemeMode) => void; disabled?: boolean } = {}) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith("ru");
  const [localMode, setMode] = useState<ThemeMode>(savedMode);
  const mode = preferred ?? localMode;
  useEffect(() => {
    apply(mode);
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : undefined;
    const update = () => apply(mode);
    if (mode === "system") media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, [mode]);
  const options = [
    ["system", ru ? "Системная" : "System"],
    ["light", ru ? "Светлая" : "Light"],
    ["dark", ru ? "Тёмная" : "Dark"],
  ] as const;
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1" role="group" aria-label={ru ? "Оформление" : "Appearance"}>
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          disabled={disabled}
          className={`rounded-md px-2 py-1 text-xs font-bold focus-visible:outline-2 focus-visible:outline-emerald-700 ${mode === value ? "bg-emerald-800 text-white" : "text-slate-500 hover:bg-slate-100"}`}
          onClick={() => {
            if (onSelect) { onSelect(value); return; }
            setMode(value);
            try {
              localStorage.setItem(themeKey, value);
            } catch {
              /* Appearance works without storage. */
            }
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
