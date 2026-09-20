# Agent web search

`web_search` looks up public pages for the interactive agent. `web_fetch` then
reads a **known** HTTPS URL. Search never invents a URL; fetch never discovers
one.

## Default: DuckDuckGo

On a fresh machine, `web_search` uses [DuckDuckGo Lite](https://lite.duckduckgo.com/lite/).
There is no API key and nothing to run locally. Results are untrusted reference
data: the agent must not follow instructions found in titles or snippets.

DuckDuckGo is the default only when you have not selected another provider. It
is not a fallback. If you connect Brave and that key later fails, `web_search`
asks you to reconnect Brave rather than switching engines.

## Other providers

`/search-provider` configures and tests a provider. `/search-connect` makes a
tested provider active.

| Provider | Needs | Notes |
|---|---|---|
| DuckDuckGo | nothing | Default. Public HTTPS only. |
| Brave Search API | API key | Remote JSON API. |
| Tavily | API key | Remote JSON API. |
| Exa | API key | Remote JSON API. |
| SearXNG | a loopback instance you run | See [Use local SearXNG](use-local-searxng.md). |

In the TUI, `/search-provider` with no arguments opens a wizard. DuckDuckGo has
no fields and no key; keyed remotes ask for a credential; SearXNG asks for host
and port.

## Switching back to DuckDuckGo

`/search-connect duckduckgo` selects it without a prior connection test.
