# Acceptance Criteria — flow 081 (cross-platform config dir)

- AC1: `shell-config`'s config directory is cross-platform: Windows → `%APPDATA%\keryx` (or `~/AppData/Roaming/keryx`); Linux/BSD → `$XDG_DATA_HOME/keryx` (or `~/.local/share/keryx`); macOS → `~/.local/share/keryx`. Was hardcoded to `~/.local/share/keryx`.
- AC2: A unit test asserts `shellConfigPath()` honors `XDG_DATA_HOME` on non-Windows. Existing shell-config tests (0600, merge, malformed) stay green.
- AC3: The OpenRouter key-prompt note no longer hardcodes a Unix path (says "your keryx config dir, owner-only 0600"). Everything else unchanged.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1515). No new dependency.
