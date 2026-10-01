# Use a local model

You can run `keryx shell` against a model on your own machine or network, with no API key and no traffic to a hosted service. This guide covers a runner on the same machine (Ollama, or Rapid-MLX on macOS) and an OpenAI-compatible server elsewhere on your network.

## Prerequisites

- Keryx installed ([Install](../getting-started/install.md)).
- A model runner already installed and a model downloaded. Keryx does not install runners or download models.
- For a runner on another machine: the server's address, and a model it serves.

## How a local model is allowed

Keryx blocks every request to a loopback or private-network address by default, so a hosted provider can never be pointed at an internal service. Local providers get a narrow exception, granted per provider:

| Provider | Allowed addresses |
|---|---|
| `ollama` | Loopback only (`localhost`, `127.0.0.0/8`, `::1`). Default endpoint `http://localhost:11434`. |
| `rapid-mlx` (macOS) | Loopback only. Default endpoint `http://127.0.0.1:8010`. |
| A custom provider you added | Loopback and private LAN ranges. |
| Every built-in hosted provider | Neither. |

Link-local and cloud-metadata addresses stay denied for every provider, whatever you configure.

## Steps

1. **Start the runner** and confirm it answers. For Ollama:

    ```bash
    ollama serve
    ollama pull llama3.1:latest
    ```

    Keep `ollama serve` running in its own terminal. Skip the first command if the runner already runs as a service.

2. **Start the shell on that provider and model.**

    ```bash
    keryx shell --provider ollama --model llama3.1:latest
    ```

    If you omit the flags, the provider picker probes `http://localhost:11434` and lists Ollama with its installed chat models when the server answers. Embedding-only models are left out. A model that is not installed is not offered.

3. **Use a different loopback port** with `--base-url`:

    ```bash
    keryx shell --provider ollama --model llama3.1:latest --base-url http://localhost:11500
    ```

4. **For a runner on another machine,** add a custom provider. In the shell, run `/provider`, choose "add custom provider" and enter a name, the base URL, an optional key and the model ids. This writes `llm-providers.json` beside `auth.json` in your keryx data directory. You can also write it by hand:

    ```json
    {
      "schemaVersion": 1,
      "providers": {
        "lab-gpu": {
          "name": "lab-gpu",
          "label": "Lab GPU box",
          "baseUrl": "http://192.168.1.50:8000",
          "requiresApiKey": false,
          "models": ["<model id served by that machine>"],
          "note": "OpenAI-compatible server on the lab network"
        }
      }
    }
    ```

    Then start with `keryx shell --provider lab-gpu --model <model id>`. A name that collides with a built-in provider is rejected. The server must speak the OpenAI chat-completions format; if its paths differ, set `chatPath` and `modelsPath` on the entry.

!!! warning "A custom endpoint is a trust boundary"
    A URL you put in your own config file is treated as your decision, so keryx will send prompts, including file contents the agent read, to that address. Use it only for servers you control.

## Verify

```bash
keryx providers status
keryx providers test lab-gpu
```

`providers status` lists each provider with its reachability and model count, and `providers test <name>` probes one. For Ollama itself, a running session shows `ollama/<model>` in its header. `providers test` covers the registry and your custom providers; it does not know the `ollama` name.

## Troubleshooting

- **`could not be reached`.** The server is not running, or the URL or port is wrong. For a custom provider, open the base URL's models path in a browser or with `curl`.
- **A LAN address is refused with `--provider ollama`.** The Ollama provider is loopback only. Add the server as a custom provider.
- **Tool calls misbehave or turns are slow.** Small models vary widely at following tool schemas. Try a larger model, and keep the default `ask` approval mode while you evaluate it.
- **`rapid-mlx` is not offered.** It is available on macOS only, and its model list comes from the running server, so start the server first.

## Next steps

- [Models and providers](../modules/providers.md): routing categories to different models, including a cheap local one for reviews.
- [Keep private work in-house](keep-private-work-in-house.md): block hosted providers entirely.
- [Use local SearXNG](use-local-searxng.md): a local search engine for the agent.
