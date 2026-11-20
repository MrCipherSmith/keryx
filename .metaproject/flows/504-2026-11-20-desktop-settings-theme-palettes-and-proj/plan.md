# Implementation plan

Use Keryx design tokens and existing controls for the Settings shell. Track the previous project view. Keep editor state across Settings tab changes. Store light and dark palette preferences separately, migrating the old palette to the dark choice and following the system's actual mode.

Use the accounts already in GitHub CLI. Store an explicitly chosen account locally by the primary Git checkout. Resolve a named account for trusted GitHub operations, verify actual viewer and repository before saving, and use the same identity for API reads, private fetch and the watcher. Existing unbound projects can still use the legacy default CLI account. Missing access for a bound account is an actionable error. An account change pauses the former watcher and resets its scheduling baseline before manual enablement of the new watcher.

Use Settings Integrations for global GitHub account management. Use the same project account picker in first-open onboarding and Project Settings. Show the verified project account in the Activity header.

| State | Change | Close or change project | Retry |
|---|---|---|---|
| Settings open | Switch tabs with the same settings draft | Restore previous work surface | Repeat the failed settings operation |
| Account list loading | Keep selection disabled until ready | Ignore stale UI responses | Refetch accounts |
| No account configured | Show connect and choose actions for GitHub projects | Store an explicit skip or leave selection pending | Recheck registered accounts |
| Account selected | Validate replacement and pause old watcher before next start | Reload canonical project binding | Revalidate chosen account |
| Account or repo inaccessible | Show reconnection or access failure | Keep account scopes isolated | Revalidate the same identity |
| System appearance | Render palette for actual OS mode | Persist both preferences | Apply matching palette after OS mode changes |
