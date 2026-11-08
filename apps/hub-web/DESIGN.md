# Team Hub chat pages

- Session lists are for finding and opening a conversation.
- A managed session and a connected shell each open a dedicated chat URL in the same Hub workspace.
- Back to sessions is in the same position for both. Browser Back and Forward follow the selected conversation.
- Give the transcript the largest area and align it with the composer. Use the Hub canvas and existing type and color tokens.
- Keep message actions in the composer and show actionable approvals immediately above it.
- Retain the conversation title, connection state and machine in the header. Leave the existing session controls available.
- On narrow screens the conversation takes one column, with a 44 px Back control and room for translated labels.
- A connected shell acquires browser control on the first send, stop, or answer. Opening it to read history leaves any current controller alone.
- On a connected shell page only the transcript scrolls during normal chat use. The composer stays beneath it, and a pending question or approval sits immediately above the composer.
- Show usage after the shell sends measured counts. Older shells can still send text and display history.
- Use the shell's own command registry for discovery. Mark commands that still need the terminal. The connected chat can run `/help`, `/status`, `/usage`, `/model`, `/models` and `/queue` without passing arbitrary slash text to the terminal.
