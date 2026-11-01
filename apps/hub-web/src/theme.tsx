import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type ThemeMode = "system" | "light" | "dark";
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
export function ThemeSelect() {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith("ru");
  const [mode, setMode] = useState<ThemeMode>(savedMode);
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
  return (
    <select
      className="theme-select"
      aria-label={ru ? "Оформление" : "Appearance"}
      value={mode}
      onChange={(event) => {
        const next = event.target.value;
        if (next !== "system" && next !== "light" && next !== "dark") return;
        setMode(next);
        apply(next);
        try {
          localStorage.setItem(themeKey, next);
        } catch {
          /* Storage is optional. */
        }
      }}
    >
      <option value="system">{ru ? "Системная" : "System"}</option>
      <option value="light">{ru ? "Светлая" : "Light"}</option>
      <option value="dark">{ru ? "Тёмная" : "Dark"}</option>
    </select>
  );
}
