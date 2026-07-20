# Flow 070 — OpenTUI UX fixes

Addresses live-terminal feedback: (2) model picker showed nothing → showDescription:false; (3) / menu arrows/Enter did nothing (Input had focus) → route via _internalKeyInput.onInternal before the Input; (4) composer too short → vertical padding. Command expansion (/provider, /model, metaproject) is a follow-up.
