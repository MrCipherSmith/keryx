# Acceptance criteria

- AC1: The Settings screen has grouped Appearance, Sessions, Integrations and Desktop tabs and a close control. Close or Escape returns to the prior project surface and preserves the current PR or work context. [verify: judged]
- AC2: Light offers light palettes and Dark offers dark and black palettes. Light and dark choices persist independently across explicit and system theme changes. Swatches fit the supported minimum window width. [verify: judged]
- AC3: Integrations lists multiple GitHub accounts and exposes a browser-based sign-in flow for another GitHub.com account. [verify: judged]
- AC4: Opening an unconfigured GitHub project offers account selection. Project Settings can change it after access verification. A worktree shares the primary project's choice. [verify: judged]
- AC5: Activity shows the current project GitHub account and reflects a changed selection. [verify: judged]
- AC6: Two projects can use distinct GitHub accounts for PR reads and private review checkout preparation. Their opted-in watchers follow the same project identities with Desktop closed and the global gh account changed. [verify: judged]
- AC7: Revoked access or a failed replacement leaves an actionable status. A replacement cannot silently redirect old scheduled work or make its pending events act under the new account. [verify: judged]
