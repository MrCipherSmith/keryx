import { useEffect, useState } from "react";
import { setWindowTitle, settingsAddRecent, windowInitialCwd } from "./acp/tauri";
import { SessionScreen } from "./components/SessionScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { Welcome } from "./components/Welcome";

type Screen = { name: "welcome" } | { name: "session"; cwd: string } | { name: "settings"; back: Screen };

export function App() {
  const [screen, setScreen] = useState<Screen | null>(null);

  // A window created by "Open Folder…" is told its folder by the Rust side.
  useEffect(() => {
    void windowInitialCwd()
      .then((cwd) => setScreen(cwd ? { name: "session", cwd } : { name: "welcome" }))
      .catch(() => setScreen({ name: "welcome" }));
  }, []);

  useEffect(() => {
    if (screen?.name === "welcome") void setWindowTitle("Keryx");
    if (screen?.name === "session") void settingsAddRecent(screen.cwd).catch(() => {});
  }, [screen]);

  if (!screen) return null;
  if (screen.name === "settings") {
    return <SettingsScreen onBack={() => setScreen(screen.back)} />;
  }
  if (screen.name === "session") {
    // Keyed by folder so switching folders gets a fresh keryx process.
    return (
      <SessionScreen
        key={screen.cwd}
        cwd={screen.cwd}
        onSettings={() => setScreen({ name: "settings", back: screen })}
        onClose={() => setScreen({ name: "welcome" })}
      />
    );
  }
  return <Welcome onOpen={(cwd) => setScreen({ name: "session", cwd })} onSettings={() => setScreen({ name: "settings", back: screen })} />;
}
