# Keryx OpenTUI Shell UX & Layout Remediation — Requirements Package
Version: 0.1.0

## Status

`proposed` · Generated from live PTY / tmux exploratory review of `keryx shell` v0.2.114/0.2.115 on darwin-arm64.

## Purpose

Remediate visual bleed-through artifacts, modal layout inconsistencies, scroll offset traps, and typographic clipping issues in the OpenTUI terminal shell (`keryx shell`), elevating the TUI to production-grade polish.

## Documents

- [Product Requirements Document (PRD)](prd.md)
- [Technical Specification](specification.md)

## Delivery Roadmap

| Phase | Focus Area | Scope |
|---|---|---|
| **Phase 1: Modal Isolation & Picker Unification** | Visual Integrity | Fix modal backdrop clearing (stop left/right margin bleeding); migrate `/model` and `/sessions` from destructive full-screen wipes to `ModalHost`. |
| **Phase 2: Scroll Ergonomics & Stream Following** | Interaction & Navigation | Auto-follow on new messages; fix `createBlockNavController` Esc reset trap (`scrollTop = savedScrollTop`); isolate dropdown scrollbar from main transcript. |
| **Phase 3: Adaptive Height & Empty-State Clarity** | Layout & Ergonomics | Dynamic modal sizing (`hug-content` up to `maxHeight`); clean empty states in `/review` and `/status` Context tab; context-aware footer key hints. |
| **Phase 4: Typography, Wrapping & Responsive Polish** | Visual Polish | Hanging indents in command listings (`/help`, `/flows`); safe truncation / ellipsis for sidebar versions and MCP server endpoints; minimum viewport guard. |

## References & Related Packages

- [Keryx OpenTUI Shell](../keryx-opentui-shell/README.md) — Base shell requirements
- [OpenTUI Modal & Tabs](../keryx-opentui-modal-tabs/README.md) — Modal host architecture
- [Session Info](../keryx-opentui-session-info/README.md) — `/status` surface
- Source files: `src/tui/modal-host.ts`, `src/tui/shell-chrome.ts`, `src/tui/transcript-blocks.ts`, `src/tui/tui-shell.ts`, `src/tui/review-inspector.ts`
