# Connect a model provider

`keryx shell` needs one configured model provider before it can run a turn. This guide connects one with an API key, a subscription login or an environment variable, and shows how to check it works. The project-knowledge commands (graph, wiki, memory, health) need no provider at all.

## Prerequisites

- Keryx installed ([Install](../getting-started/install.md)).
- One of: an API key for a provider in the [provider table](../modules/providers.md#how-it-works), a ChatGPT, SuperGrok or GitHub Copilot subscription, or a model running locally (see [Use a local model](use-a-local-model.md)).

## Steps

1. **Start the shell and use the picker.** With no provider configured, the first run opens a picker.

    ```bash
    keryx shell
    ```

    Choose a built-in provider, or "add custom provider" for any OpenAI-compatible endpoint. If the provider needs a key, you are prompted for it before the model list loads, so a gateway that rejects an unauthenticated request still shows a real model list. Pick a model and the session starts. The key is saved to `auth.json` in your keryx data directory, owner-only (`~/.local/share/keryx/` on macOS and Linux, or `$XDG_DATA_HOME/keryx/` when that is set). It is never written into the project.

2. **Or use a subscription login.** For `grok`, `openai-codex` (ChatGPT Plus or Pro) and `github-copilot`, log in by device code from outside the shell:

    ```bash
    keryx auth login openai-codex
    ```

    Keryx prints a code and a URL, opens the URL, and stores the grant when you approve. `keryx auth login` accepts only these providers. For any other provider it refuses and tells you to use an API key:

    ```text
    DeepSeek has no consumer OAuth grant. Use DEEPSEEK_API_KEY.
    ```

3. **Or export an environment variable.** Each provider reads a fixed variable, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `DEEPSEEK_API_KEY`; the full list is in [Models and providers](../modules/providers.md). A variable that is already set wins over a saved key.

    ```bash
    export DEEPSEEK_API_KEY="<your key>"
    keryx shell --provider deepseek --model deepseek-chat
    ```

4. **Add or switch providers later.** Inside a session, `/provider` reopens the add and reconfigure wizard, and `/connect` switches between providers you already configured. `/connect` rows have Test and Disconnect buttons. `/model` and `/models` change the model.

## Verify

```bash
keryx providers list
keryx providers test <name>
keryx auth status openai-codex
```

`providers list` shows what is configured. `providers test <name>` runs the live model-list probe and prints the model count or the failure reason. `auth status <provider>` says whether a subscription grant is active. `keryx doctor` also reports provider state.

!!! note "Always listed"
    A keyless local runner such as `rapid-mlx` appears in `providers list` even when nothing is running. Use `providers test` or `providers status` to see whether it answers.

## Troubleshooting

- **`auth login` refuses a provider.** Only `grok`, `openai-codex` and `github-copilot` have a subscription login. Use the provider's key instead.
- **A key in a project `.env` is ignored.** The `keryx` executable starts Bun with `--no-env-file`, so a working-directory `.env` is not loaded on purpose. Export the variable in your shell, or enter the key through `/provider` once.
- **`providers test` says the provider could not be reached.** Check the URL and port for a custom or local provider, and your network for a hosted one.
- **ChatGPT model lists look stale.** Discovery reads the current Codex catalog version from npm metadata and caches it for a day. `keryx providers test openai-codex`, or Test in `/connect`, always checks for a newer version first. It does not install anything or poll in the background, and if npm is unreachable it reuses the last discovered version.
- **Remove a key or grant.** `keryx providers remove <name>` asks first, then deletes the saved key, grant or custom entry. `keryx auth logout <provider>` deletes a stored grant locally and makes no call to the vendor.

## Next steps

- [Models and providers](../modules/providers.md): routing reviews and subagents to other models.
- [Use a local model](use-a-local-model.md): a model on your machine or network.
- [Choose an approval mode](permission-modes.md): decide what the agent may do without asking.
