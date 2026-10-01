# Models and providers

Keryx talks to models through providers: native adapters for the major vendors, a registry of OpenAI-compatible gateways and local runners, and any custom endpoint you add. Swapping the provider does not change the loop, the tools or the approval rules, so you choose the model per task instead of per tool.

## When to use it

- You want the shell to run on a hosted model with an API key, or on a subscription you already pay for.
- You want a model on your own machine or LAN, with no key and no traffic leaving it.
- You want reviews and subagents to run on a cheaper or stronger model than your main session.
- You need to keep private code away from named vendors or services, even when a model id would route there.
- You want the agent to look things up on the web through a provider you choose.

## Quick example

These commands only read state, so they are safe to run before any provider is configured.

```bash
keryx auth list
keryx routing list
keryx external status
```

```text
# authorized providers

none

# subscription login offered
- grok: device-code, api-key
- openai-codex: device-code
- github-copilot: device-code
# routing table

default      session default  [default]
review       session default  [default]
subagents    session default  [default]
quick        session default  [default]
coding       session default  [default]
planning     session default  [default]
docs         session default  [default]
unattended   session default  [default]
external: on (source: default)
…
```

To add a provider, follow [Connect a model provider](../guides/connect-a-provider.md).

## How it works

**Providers.** A provider turns a model request into a vendor's wire format. The first column is the name you pass to `--provider`.

| Provider | Kind | Credential |
|---|---|---|
| `anthropic` | native | `ANTHROPIC_API_KEY` |
| `openai` | native (Responses API) | `OPENAI_API_KEY` |
| `gemini` | native | `GEMINI_API_KEY`, or `GOOGLE_API_KEY` |
| `openai-codex` | native, ChatGPT subscription | `keryx auth login openai-codex` |
| `ollama` | native, local (loopback) | none |
| `fake` | offline test provider | none |
| `openrouter` | OpenAI-compatible gateway | `OPENROUTER_API_KEY` |
| `deepseek` | OpenAI-compatible | `DEEPSEEK_API_KEY` |
| `zai`, `zai-coding` | OpenAI-compatible | `ZAI_API_KEY` |
| `cerebras` | OpenAI-compatible | `CEREBRAS_API_KEY` |
| `groq` | OpenAI-compatible | `GROQ_API_KEY` |
| `moonshot` | OpenAI-compatible | `MOONSHOT_API_KEY` |
| `grok` | OpenAI-compatible; subscription login available | `XAI_API_KEY`, or `keryx auth login grok` |
| `github-copilot` | OpenAI-compatible; subscription login | `keryx auth login github-copilot` |
| `rapid-mlx` | local runner, macOS only | none |
| your own | custom OpenAI-compatible endpoint | optional |

A provider that needs a credential never makes a network call without one. Model lists come from each provider's live model endpoint, with a short built-in list as a fallback.

**Subscription login or API key.** `keryx auth login <provider>` is for subscription logins only: `grok`, `openai-codex` and `github-copilot`, by device code. It refuses every other provider and says to use an API key. API keys are entered in the shell's provider picker (`/provider`, `/connect`) or supplied as the environment variables above. Saved keys and login grants live in `auth.json` in your keryx data directory (`~/.local/share/keryx/` on macOS and Linux, or `$XDG_DATA_HOME/keryx/`), written owner-only and never into a project. An environment variable that is already set wins over a saved key. Keryx does not read other tools' credential stores, even to check whether you are logged in.

**Custom endpoints.** The `/provider` wizard's "add custom provider" entry walks name, URL, key and models, and writes `llm-providers.json` beside `auth.json`. A custom provider may use a loopback or private-LAN address; built-in providers never may, and cloud-metadata and link-local addresses stay denied for everyone. See [Use a local model](../guides/use-a-local-model.md).

**Routing and tiers.** `keryx routing` (and `/routing`) maps a task category (`default`, `review`, `subagents`, `quick`, `coding`, `planning`, `docs`, `unattended`) to a model; a category with no entry shows `session default` in `routing list`. A per-project `routing.config.json` beats your per-user table, and `routing stats` shows measured cost per model. Dispatch tiers `light`, `standard` and `deep` are anchored on the session model: `standard` is that model, `deep` the next size up and `light` the next size down among models your provider lists. `keryx review tier` prints how a tier was resolved.

**Keeping work in-house.** `/external` and `keryx external` block code, diffs and prompts from going to listed providers and models, including through a gateway's model ids. See [Keep private work in-house](../guides/keep-private-work-in-house.md).

**Web search.** The agent's `web_search` tool uses DuckDuckGo by default with no key. Brave, Tavily, Exa and a loopback SearXNG are available through `/search-provider` and `/search-connect`. See [Agent web search](../guides/web-search.md).

## Common tasks

| I want to… | Command or page |
|---|---|
| Connect a provider | [Connect a model provider](../guides/connect-a-provider.md) |
| Log in with a subscription | `keryx auth login <provider>` |
| See and test what is configured | `keryx providers list`, `keryx providers test <name>` |
| Disconnect a provider | `keryx providers remove <name>` |
| Use a model on my machine | [Use a local model](../guides/use-a-local-model.md) |
| Send reviews to a different model | `keryx routing set review <provider>/<model>` |
| Block private work from listed vendors | `keryx external off` |
| Change the web search engine | `/search-provider`, `/search-connect` |

## Status

Stable: provider selection, native adapters and the compatible-provider registry. `rapid-mlx` is macOS only. Features that call a model beyond your own turns (`test suggest`, `flow plan`, `wiki enrich`, `memory reflect --narrate`) need a configured provider; the rest of Keryx runs without one. See [Project status](../project/status.md).

## Reference

- CLI: [providers](../cli-reference.md#providers), [auth](../cli-reference.md#auth), [routing](../cli-reference.md#routing), [external](../cli-reference.md#external)
- Concepts: [The agent harness](../harness.md)
- Guides: [Connect a model provider](../guides/connect-a-provider.md), [Use a local model](../guides/use-a-local-model.md), [Keep private work in-house](../guides/keep-private-work-in-house.md), [Agent web search](../guides/web-search.md), [Use local SearXNG](../guides/use-local-searxng.md)
