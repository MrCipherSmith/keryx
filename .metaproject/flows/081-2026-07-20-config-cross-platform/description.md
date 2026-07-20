# Flow 081 — cross-platform config dir

Flow 080 hardcoded ~/.local/share/keryx (Linux/XDG). Windows needs %APPDATA%; Linux should honor XDG_DATA_HOME. Fixed configDir() to branch on process.platform + env; key-prompt note de-hardcoded.
