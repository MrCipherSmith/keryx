# Flow 076 — copy-on-select

User cannot copy selected text (alternate-screen disables native selection). Fix: enable mouse so OpenTUI tracks selection, and on the SELECTION event copy the selected text to the system clipboard via OSC52.
