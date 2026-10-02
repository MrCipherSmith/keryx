# Keep private work in-house

The `/external` switch stops Keryx from sending private work (code, diffs, CI-log excerpts, prompts, rule text) to a hosted review service and to model vendors you have not decided to trust with it. This guide turns it on, shows what it blocks and how to change the list.

## Prerequisites

- Keryx installed and a project initialised.
- An idea of which providers you connect. The switch decides what is allowed to leave your machine, so it matters most when you use gateways or several vendors.

## How it works

The switch has two positions, and the names read from the point of view of external destinations:

- `on` is the default: nothing is blocked, and Keryx behaves as if the switch did not exist.
- `off` keeps work in-house: every destination on the block list is refused.

It is enforced at the two places that send data out. Every request to the hosted review service (all `keryx review jev-*` checks, `conform`, `ci-triage`, selection, the routing classifier and the turn guard) passes one check. Routing and model selection pass another: a blocked provider or model is skipped for a category and the next layer is used, with a notice, never silently.

## Steps

1. **See the current state.**

    ```bash
    keryx external status
    ```

    ```text
    external: on (source: default)
    jev credential: not resolved (OPENROUTER_API_KEY / saved key)
    blocked right now: nothing — external is on.
    ```

2. **Turn it off.** For all your projects, or for one project:

    ```bash
    keryx external off
    keryx external off --project
    ```

    A project setting wins over your per-user setting. After `off --project`, a later `keryx external on` changes only your per-user value, and the project stays off until you run `keryx external on --project`.

    ```text
    external: off (source: project)
    jev credential: not resolved (OPENROUTER_API_KEY / saved key)
    jev: blocked
    blocked right now: 6 provider id(s), 14 model pattern(s) — see `keryx external list`.
    ```

3. **Read the block list.**

    ```bash
    keryx external list
    ```

    Each entry shows its provider id or model pattern and the reason it is listed.

4. **Edit the list.** It is a JSON file, `external-providers.json`, in your keryx data directory (`~/.local/share/keryx/` on macOS and Linux). Keryx creates it with the defaults on first use and never overwrites it again. Delete an entry to allow that destination, or delete the file to restore the defaults.

Inside the shell, `/external` shows the same status, and `/external on` or `/external off` toggles your per-user setting. While the switch is `off`, the sidebar shows a row for it.

## What is blocked by default

| Entry | Matches | Why it is listed |
|---|---|---|
| `jev` | the hosted review service | receives code, diffs and CI-log excerpts on every call |
| `deepseek`, `zai`, `zai-coding`, `moonshot` | direct provider ids | vendors whose terms may allow retention or training on prompts |
| `deepseek/*`, `z-ai/*`, `moonshotai/*`, `qwen/*` and similar | OpenRouter model-id prefixes | the same vendors, and others with no direct provider, reached through a gateway |
| `*:free` | OpenRouter free-tier models | the underlying provider's logging policy is not audited per model |
| `antigravity-cli` | an external agent CLI | prompts and agent actions are collected by default |

Providers you connect directly from the major US vendors (`anthropic`, `openai`, `gemini`, `github-copilot`, `grok`, `groq`) are not on the list. Add them in the file if your policy is stricter.

## Verify

Run `keryx external status` and confirm `external: off` with a non-zero blocked count. If a routing category resolves to a blocked model, Keryx falls through to the next layer and prints a notice.

## Troubleshooting

- **A review check still sends data.** Check `keryx external status` for the effective source. A project override can differ from your per-user setting.
- **The review service is blocked but you want it on for one project.** Run `keryx external on --project` there.
- **The recommended review steps turned on by themselves.** With a review-service credential available and the switch `on`, three low-risk steps are on by default; the first time a project sends data because of that default, one line says so. `keryx external off` stops it. See [the recommended profile](../jev-in-review.md#recommended-profile-now-on-by-default-when-jev-is-reachable).

## Next steps

- [Models and providers](../modules/providers.md): routing categories to models you trust.
- [Use a local model](use-a-local-model.md): a model that never leaves your network.
- [Security model](../concepts/security-model.md): what else keeps data inside the project.
