# Flow 062 — OpenTUI live /-command dropdown

Phase 3 of docs/requirements/keryx-opentui-shell — the flagship Pi/grok feature.
A shared command registry drives a SelectRenderable dropdown that filters live as
the user types `/` in the OpenTUI composer; commands run on submit (type-to-
complete model). Arrow-key highlight navigation is a follow-up (needs live TTY
iteration). runAgentTurn + the readline shell are unchanged.
