# Context

## Desktop and Review boundaries

- Desktop SettingsView already has a back callback for onboarding. App project mode needs a return path that preserves Review state.
- prefs.ts currently forces every custom palette into Dark. themes.css and styles.css share a palette-group selector with the command palette.
- The Activity panel belongs to SessionView and can receive project connection metadata from App.
- src/review/board-github.ts owns the GitHub CLI read path. The Review executor fetches private PR refs through the HTTPS Git credential helper. The detached watcher pins tool paths and verifies viewer and repository. All three paths need one account context.
- The user selected one Flow. The Flow lives in the primary project checkout. Implementation branch is feat-desktop-project-integrations under the existing Review worktree.
