# Flow 061 — OpenTUI shell Phase 2 (chrome parity)

Phase 2 of docs/requirements/keryx-opentui-shell. Brings the readline shell's
render chrome (flows 050-057) to the OpenTUI agent shell: worker-free markdown
assistant body, `● keryx` role header, `⚙ tool(args)` + collapsed tool output,
dim `⋯ thinking` reasoning, dim usage line, styled system/error — reusing the pure
helpers. `runAgentTurn`, the readline path, and chat mode are unchanged; the
native MarkdownRenderable is avoided (headless-unavailable WASM parser worker).
