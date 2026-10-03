Security review of PR #863 at 25e6fb45: no blocker or major findings, two low-severity items. Checked with no finding: bot token handling, injection into rich blocks, mention and command auto-detection (unchanged from HTML mode), live probe or send to a real chat (none in the diff), fixtures and PII, /rendering and the config write.

```json keryx:findings
[
  {
    "id": "S-001",
    "severity": "minor",
    "problem": "[reported severity: info/minor] Telegram's error text can carry message content and is stored with only secret-redaction: `reason` is the Bot API `description` after `redactSensitiveText`, not length-capped or sanitised (src/remote/rendering.ts describe, record and pauseRich; surfaced by src/remote/hub.ts fallbackEvent and /channels).",
    "impact": "A model or tool output containing PII or a long URL is refused by Telegram with a message that echoes the fragment (an unsupported tag name, an invalid URL). The echo lands in the `format-fallback` event, `lastFallback.reason` and the `/channels` response: local operator surfaces only, but the code comment says 'never message text', which is not strictly guaranteed.",
    "suggested_fix": "Truncate `reason` to about 200 characters, or keep only the status plus the part before the first quote.",
    "evidence": "Read of describe, record and pauseRich at 25e6fb45.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-security",
    "file": "src/remote/rendering.ts",
    "quote": "return redactSensitiveText(error instanceof Error ? error.message : String(error));"
  },
  {
    "id": "S-002",
    "severity": "info",
    "problem": "Link label can differ from the real target: `[https://bank.example](https://evil.example)` renders as a clickable link whose visible text differs from its target (src/remote/format-html.ts, reused by format-rich.ts via htmlToRichText).",
    "impact": "A prompt-injected tool result makes the agent emit a deceptive link that the operator then taps. The scheme is already restricted to https and http (no tg://, javascript: or data:) and the URL regex rejects whitespace, quotes and angle brackets. Existed before this PR (flow 376 HTML mode); the rich path adds no new reach.",
    "suggested_fix": "Optional hardening: show the target host next to a label that looks like a URL.",
    "evidence": "Read of the link() function in format-html.ts at 25e6fb45.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-security",
    "file": "src/remote/format-html.ts",
    "quote": "if (!HTTP_URL.test(url)) {"
  }
]
```
