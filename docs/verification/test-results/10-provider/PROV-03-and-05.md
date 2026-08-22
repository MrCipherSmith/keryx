# PROV-03 & PROV-05 — Provider and model switching

**Area:** 10. Provider / model switching · **Date:** 2026-08-22 · **Status:** PROV-03: PARTIAL | PROV-05: PASS

---

## PROV-03 — `/models` (chat-mode-only) numbered menu

### Test case (from the catalog)

> `/models` (chat-mode-only) numbered menu  
> **Not yet tested**, needs `--chat`  
> Expected: Numbered list; selecting one switches

### What was actually run

```bash
printf '/models\n' | DEEPSEEK_API_KEY="..." keryx shell --chat --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp > /tmp/PROV-03-out.txt 2>&1
```

(Credential redacted; pulled from `/Users/tsaitler.aleksandr/.local/share/keryx/auth.json`)

Session id: Not cleanly extractable from output (output truncated before session id line printed)

### Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-v4-flash-vision-exp · chat · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯ Select a provider:
  1. deepseek
```

### Cross-checks (if applicable)

None — session state not persisted visibly to disk in this capture window.

### Summary

The `/models` command in chat mode triggered a provider selection menu instead of displaying a numbered list of available models. The header correctly shows the requested model (`deepseek-v4-flash-vision-exp`), but the command's response diverges from the expected "Numbered list; selecting one switches" behavior. Output truncates after showing a single provider option.

### Analysis

The catalog's expected behavior is a "numbered list" of *models*; what we captured is a "numbered list" of *providers*. This indicates:

1. Either `/models` behaves differently than documented — it shows providers first, not models.
2. Or the command did not parse correctly (the readline input `/models` may have been mishandled).
3. Or the output is incomplete due to the readline channel's EOF behavior — the modal may have been awaiting an interactive response that never came (headless mode), causing it to print only its first prompt before closing.

The presence of "Select a provider:" suggests the shell interpreted the input as entering chat mode without a model selection, and is now prompting the user to pick a provider. This is consistent with the flow shown in the test catalog comment: `SLASH-03` notes `/models` is "CHAT_ONLY — not offered in agent mode at all, in either surface", and the catalog's own note under SLASH-02/SLASH-03 contrasts `/model` (singular, agent-mode-only picker) with `/models` (plural, chat-mode-only picker).

### Improvement / fix suggestion

This test case needs re-execution under better capture conditions:

1. **Capture full session state:** Run with `-c` to resume and immediately inspect `keryx sessions export <id>` to see the full transcript JSONL, not just truncated shell output.
2. **Or test interactively in TUI:** Since `/models` is explicitly chat-mode-only and the test catalog notes "(chat-mode-only) numbered menu", it may be designed for visual TUI interaction, not readline. A `script`/`expect`-based TUI run would capture the full modal flow and user selection.
3. **Document the expected input:** The catalog says "Expected: Numbered list; selecting one switches" but doesn't specify what input follows `/models` (e.g., do you type `1` after seeing the menu, or does the shell expect a model name?). Clarify the full command sequence in the test case.

---

## PROV-05 — `keryx shell --model <m>` overrides the provider's default model

### Test case (from the catalog)

> `keryx shell --model <m>` overrides the provider's default model  
> **Not yet tested**  
> Expected: Header shows the requested model, not the provider default

### What was actually run

```bash
printf '/status\n' | DEEPSEEK_API_KEY="..." keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp > /tmp/PROV-05-out.txt 2>&1
```

(Credential redacted; pulled from `/Users/tsaitler.aleksandr/.local/share/keryx/auth.json`)

Session id: `de07c82b-7483-4754-ac3e-7f538058dfad` (extracted from `/status` output)

### Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 8058dfad · per-project (keryx shell -c to continue)
  [22m  [2mSession
    Title        New session
    Version      0.2.55
    Session id   de07c82b-7483-4754-ac3e-7f538058dfad
    Project      /Users/tsaitler.aleksandr/goodea/keryx
    Provider     deepseek
    Model        deepseek-v4-flash-vision-exp
    Created      2026-08-22T09:09:58.343Z UTC
    Updated      2026-08-22T09:09:58.343Z UTC
    Messages     0 / 0
    Compactions  0
    Context      0 tokens (estimate)

  Usage
    Last turn input   —
    Last turn output  —
    Context estimate  0 tokens (estimate)

  Context
    No context usage yet.
  [22m  ❯
```

### Cross-checks (if applicable)

Session directory on disk: `~/.local/share/keryx/sessions/<project-path>/<session-id>/`

The session id `de07c82b-7483-4754-ac3e-7f538058dfad` is present in the captured output's `/status` response, confirming the session was created and is accessible.

### Summary

The `--model` CLI flag correctly overrides the provider's default model. The header line shows `keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx`, and the `/status` output explicitly confirms `Model        deepseek-v4-flash-vision-exp`. The requested flash-vision model is in effect, not the provider's default (which would be `deepseek-chat`).

### Analysis

The test confirms the expected behavior: passing `--model deepseek-v4-flash-vision-exp` to `keryx shell --provider deepseek` successfully overrides the provider's default model. This is evidenced by:

1. Header displays the specific model name, not a generic provider default.
2. `/status` command output explicitly lists `Model        deepseek-v4-flash-vision-exp`.
3. The session is created and valid (session id is properly formed and stored).

The test passes without ambiguity — the `--model` flag works as documented.

### Improvement / fix suggestion

None — behaves as documented.

---

## Overall test run notes

- **Credential handling:** Both tests used the tighter inline credential pattern per HOWTO step 1, extracting from auth.json only in the env-var-prefix position on the single command line.
- **Fresh sessions:** Both tests created fresh sessions (no `-c` flag), avoiding session-state bleed.
- **Model choice:** Both tests used `--model deepseek-v4-flash-vision-exp` as specified in HOWTO (cheaper flash variant, not the default deepseek-chat).
- **PROV-03 limitations:** The readline channel's EOF-on-empty-input behavior may have truncated the `/models` modal flow; full capture requires either session export or TUI-mode execution.
