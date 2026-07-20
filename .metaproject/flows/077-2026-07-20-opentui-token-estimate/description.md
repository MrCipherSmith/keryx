# Flow 077 — token counter estimate

Counter was always 0 because local Ollama/gemma reports no usage. Prefer exact provider usage; fall back to an estimate (chars/4) from the history after each turn, shown as ~N.
