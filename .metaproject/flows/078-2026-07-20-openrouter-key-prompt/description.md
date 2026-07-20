# Flow 078 — OpenRouter always offered + in-TUI key prompt

Only ollama showed because openrouter was gated on OPENROUTER_API_KEY. Now detectProviders always offers openrouter (curated cheap models); the TUI picker prompts for the key when missing and sets it in process.env (in-memory).
