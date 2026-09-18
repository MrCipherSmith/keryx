# PRD: Keryx OpenTUI Shell UX & Layout Remediation

Version: 0.1.0

## 1. Overview

This requirements document specifies the fixes, layout refactorings, and ergonomic enhancements needed to eliminate visual defects, layout clipping, and interaction blockers observed during live testing of `keryx shell`. It brings consistency across all modal dialogs, fixes keyboard scroll navigation traps, unifies interactive pickers under the shared modal host, and polishes text formatting in constrained terminal viewports.

## 2. Context

- **Product:** Keryx AI Coding Agent & Context Harness (`keryx`)
- **Module:** Terminal User Interface (`src/tui/`)
- **User Role:** Software Engineer / AI Agent Operator in interactive terminal sessions
- **Tech Stack:** Bun, TypeScript, `@opentui/core` (Zig-based native TUI engine), `tmux` / PTY

## 3. Problem Statement

Live testing of `keryx shell` inside a standard 120x40 PTY environment identified five critical UI/UX shortcomings:
1. **Modal Background Bleed-Through:** Opening modals (`/status`, `/theme`) fails to clear the background columns 1–4 on the left and overflows on the right, causing previous transcript text and border characters to bleed directly through the dialog borders.
2. **Destructive Pickers (`/model`, `/sessions`):** Invoking `/model` or `/sessions` destroys the entire shell chrome (header, sidebar, composer, status line) and dumps raw unstyled text into an empty 40-row terminal, giving the appearance of an unhandled crash or fallback to raw terminal mode.
3. **Scroll Offset & Sticky-Scroll Trap:** When the transcript is scrolled up (e.g. following `/help`), newly submitted tasks and incoming assistant responses do not restore `stickyScroll`. Output streams invisibly below the viewport with zero visual indication that the agent is answering. Furthermore, pressing `Esc` in block navigation unconditionally snaps `scrollTop` back to an old offset, discarding user scroll position.
4. **Disproportionate Empty Modals & Irrelevant Shortcuts:** Modals maintain an inflexible ~85% viewport height even when empty (e.g. `/review` with 0 items, or `/status` Context tab with 0 tokens), displaying 25–30 blank rows. In `/review`, inactive action hotkeys (`a`, `d`, `y`, `arm`) remain in the footer, confusing operators.
5. **Jagged Line Wrapping & Typographic Artifacts:** Narrow sidebar blocks and command tables wrap words arbitrarily across row boundaries (e.g. `0.\n2.115`, `npm install -g @mrcip\nhersmith/keryx@latest`), and command descriptions lack hanging indentation. In addition, opening the `/` dropdown produces two competing scrollbar indicators in the same vertical plane.

## 4. Goals

- **Goal 1:** Eliminate all visual bleed-through artifacts by ensuring `ModalHost` renders an opaque, cleanly bordered dialog box over a dimmed background with strictly bounded geometry.
- **Goal 2:** Migrate `/model` and `/sessions` pickers into the shared `ModalHost` component, preserving shell chrome and providing uniform styling across all overlay views.
- **Goal 3:** Establish intuitive scroll ergonomics: auto-scroll to the newest output when user submits a prompt, provide a visible "New messages below ↓" indicator when scrolled up, and preserve user scroll intent when exiting block navigation.
- **Goal 4:** Implement adaptive modal heights (`hug-content` with `max-height` ceiling) and contextual empty states that hide inapplicable action shortcuts.
- **Goal 5:** Polish typography across the shell: apply hanging indents in multi-line listings, use ellipsis for overflowing URLs/paths, and eliminate conflicting scrollbar thumbs.

## 5. Non-Goals

- Rewriting the underlying `@opentui/core` C/Zig rendering engine.
- Introducing a mouse-first GUI paradigm (keyboard-first navigation remains primary).
- Changing the behavior or API of the `--no-tui` (readline) fallback mode.
- Adding third-party external dependencies (must stay within existing dependencies and optional `@opentui/core`).
- Altering core agent execution semantics or harness driver logic in `src/commands/agent.ts`.

## 6. Functional Requirements

### Modal & Dialog Isolation
- **FR-1 (Modal Backdrop Opacity):** `ModalHost` (`src/tui/modal-host.ts`) MUST paint an opaque background (fill with spaces styled with modal background color) across its entire bounding rectangle `[x, y, width, height]` so no underlying text or borders bleed into dialog content.
- **FR-2 (Modal Viewport Clamping):** Modal dialog width and position MUST strictly respect the main pane's right boundary, ensuring that dialog borders do not overlap or corrupt the sidebar vertical separator.
- **FR-3 (Picker Unification):** The `/model` model picker and `/sessions` session switcher MUST be rendered within `ModalHost` rather than executing a full-screen wipe (`clearScreen` / unmounting chrome).

### Scroll & Output Ergonomics
- **FR-4 (Auto-Follow on Input):** Submitting any new user prompt or slash command MUST immediately re-enable `stickyScroll: true` and scroll the transcript viewport to the bottom.
- **FR-5 (Unread Output Indicator):** When new transcript blocks arrive while the transcript is scrolled up away from the bottom, a floating badge or footer hint (`↓ New output below (press G or scroll)`) MUST be displayed.
- **FR-6 (Non-Destructive Block-Nav Exit):** Exiting block navigation mode (`Ctrl+O` -> `Esc`) MUST NOT force `scrollTop` back to `savedScrollTop` if the user intentionally navigated or scrolled to a different block.

### Modal Layout & State Polish
- **FR-7 (Adaptive Modal Height):** Modals MUST calculate their rendered height dynamically based on content rows plus header/footer padding, capped at 85% of terminal rows.
- **FR-8 (Contextual Empty States):** When a modal contains no actionable items (e.g. `/review` when all proposals are reviewed):
  - An informative empty state banner MUST be displayed.
  - Irrelevant action shortcuts (`a/d accept/decline`, `y confirm`) MUST be omitted from the footer instructions.

### Typography & Responsive Cleanliness
- **FR-9 (Hanging Indent in Listings):** Command help (`/help`), flow listings (`/flows`), and inspector items MUST render multi-line descriptions with a hanging indent aligning with the description start column.
- **FR-10 (Sidebar Truncation & Wrapping):** Update notices, package names, and directory paths in `ShellChrome` sidebar MUST use smart truncation (ellipsis `…`) or word-boundary wrapping instead of splitting semver tags or identifiers across lines.
- **FR-11 (Scrollbar Isolation):** The floating `/` command dropdown MUST NOT draw its scrollbar indicator in the same column as the main transcript scrollbar.

## 7. Non-Functional Requirements

- **NFR-1 (Performance & Zero Latency):** Modal opening, closing, and tab switching MUST complete in under 16ms (60 FPS feel) with zero visible screen flickering.
- **NFR-2 (Terminal Compatibility):** All layouts MUST render without visual distortion on standard terminal dimensions from 80x24 (minimum supported) up to 200x60 (large displays).
- **NFR-3 (Theme Conformance):** All borders, backdrops, empty states, and badges MUST consume colors from `src/tui/theme.ts` (`currentTheme()`), ensuring consistent contrast in dark, light, and high-contrast palettes.
- **NFR-4 (Headless Testability):** Every layout calculation, modal lifecycle transition, and scroll state change MUST be verifiable via automated headless tests without requiring a real TTY.

## 8. Constraints

- **Zero Added Dependencies:** No new npm packages may be introduced to `dependencies` or `optionalDependencies`.
- **OpenTUI Imperative Model:** Changes must work within the existing `@opentui/core` component hierarchy (`BoxRenderable`, `ScrollBoxRenderable`, `TextRenderable`).
- **Readline Parity Preservation:** Readline mode (`--no-tui`) must remain untouched and fully functional.

## 9. Edge Cases

- **EC-1 (Terminal Resize Mid-Modal):** When the terminal is resized (SIGWINCH) while a modal is open, modal bounds and backdrop fill MUST recompute to maintain centering without clipping.
- **EC-2 (Extremely Long URLs / Paths):** URLs in MCP server listings (`/mcp`) exceeding column width MUST be truncated with middle-ellipsis (e.g. `https://mcp.context7.com/.../tools`) to preserve table column alignments.
- **EC-3 (Fast Double-Escape):** Rapidly pressing `Esc` in a modal that contains a nested search input MUST dismiss the search filter first, and the modal on second press, without leaking focus.
- **EC-4 (Streaming While Navigating Blocks):** If the model streams tokens while the user is actively inspecting blocks with `Ctrl+O`, the stream MUST NOT forcibly jerk the user's scroll position, but MUST show the "New output below" indicator.

## 10. Acceptance Criteria (Gherkin)

### Scenario 1: Clean Modal Backdrop & Margins
```gherkin
Given the shell is running with multiple prior lines in the transcript
When the operator opens the "/status" modal
Then the modal dialog renders with a completely opaque interior
And no characters from previous transcript lines bleed into columns 1 through 4
And the modal right border does not overlap the sidebar divider
```

### Scenario 2: Unified Model Picker Modal
```gherkin
Given an active TUI shell session
When the operator runs "/model" or selects "/model" from the slash menu
Then a modal dialog titled "Select a model" opens using ModalHost
And the shell header, sidebar, and background chrome remain visible behind the dimmed overlay
And the model list allows arrow-key navigation and typing to filter
And pressing Esc closes the modal and returns focus cleanly to the composer
```

### Scenario 3: Unified Sessions Switcher Modal
```gherkin
Given an active TUI shell session
When the operator runs "/sessions"
Then the session switcher opens inside ModalHost with proper styling and borders
And the footer displays "↑/↓ select · Enter open · Esc cancel" once without duplication
And the main shell layout is preserved
```

### Scenario 4: Auto-Scroll on Prompt Submission
```gherkin
Given the operator has scrolled up into prior transcript history
When the operator types a new prompt and presses Enter
Then the transcript scrollbox automatically scrolls to the bottom
And the new user message block and agent streaming output are immediately visible in the viewport
```

### Scenario 5: Non-Destructive Scroll Position on Block Nav Exit
```gherkin
Given the operator enters block navigation mode with Ctrl+O
When the operator scrolls down to inspect recent tool blocks
And presses Esc to return to the composer
Then the transcript viewport remains at the inspected scroll position
And does not jump back to the top of the transcript
```

### Scenario 6: Adaptive Height for Empty Review Modal
```gherkin
Given a project workspace with no pending review items
When the operator runs "/review"
Then the modal height is sized compactly to fit the empty state message
And the modal does not render 25+ blank rows
And the footer omits "a d accept/decline" and "arm -> confirm" action hotkeys
```

### Scenario 7: Typographic Hanging Indent in Command Help
```gherkin
Given an active shell session
When the operator runs "/help"
Then commands with multi-line descriptions (such as "/goal" or "/game") wrap cleanly
And wrapped lines are indented to match the description column
And no wrapped words touch the left margin
```

### Scenario 8: Isolated Dropdown Scrollbar
```gherkin
Given a session with sufficient transcript history to exhibit a main scrollbar
When the operator types "/" to open the command menu
Then the command menu's scrollbar is rendered strictly within the menu's own boundary
And does not visually collide or render in the main transcript scroll column
```

## 11. Verification

### Automated Unit & Component Tests
- `src/tui/modal-host.test.ts`: Add test cases for opaque backdrop rendering, boundary clamping, and dynamic height calculation.
- `src/tui/transcript-blocks.test.ts`: Add regression test verifying that `exit()` preserves current `scrollTop` when intentional navigation occurred.
- `src/tui/shell-chrome.test.ts`: Add tests verifying auto-scroll triggers on new turn submission and dropdown scrollbar column isolation.
- `src/tui/review-inspector.test.ts`: Test empty-state compact rendering and conditional key hints.

### Headless & Integration Verification
- Execute test suites:
  ```bash
  bun test src/tui/modal-host.test.ts
  bun test src/tui/transcript-blocks.test.ts
  bun test src/tui/shell-chrome.test.ts
  bun test src/tui/review-inspector.test.ts
  ```

### Live PTY Verification
- Launch test session in a 120x40 tmux window:
  ```bash
  tmux new-session -d -s keryx-verify -x 120 -y 40 "keryx shell"
  ```
- Send commands (`/status`, `/theme`, `/model`, `/sessions`, `/review`, `/help`, long prompts) and capture pane buffers via `tmux capture-pane -t keryx-verify -p`.
- Assert absence of left-column bleed-through, verify modal containment, verify picker chrome preservation, and confirm auto-follow on response generation.
