# Agent web search

`web_search` looks up public pages for the interactive agent. `web_fetch` then
reads a **known** HTTPS URL. Search never invents a URL; fetch never discovers
one.

## Default: DuckDuckGo

On a fresh machine, `web_search` uses [DuckDuckGo Lite](https://lite.duckduckgo.com/lite/).
There is no API key and nothing to run locally. Results are untrusted reference
data: the agent must not follow instructions found in titles or snippets.

DuckDuckGo is the default unless you selected another provider after this
default shipped. A leftover local SearXNG from an older keryx is not kept as
the active engine — `/search-connect searxng` if you still want it.

It is not a fallback. If you connect Brave and that key later fails, `web_search`
asks you to reconnect Brave rather than switching engines. The agent cannot
change the engine; only `/search-provider` and `/search-connect` can.

## Other providers

`/search-provider` configures, tests and **makes the provider active**:
`/search-provider deepseek` is a one-step connect. `/search-connect` switches to
a provider that is already connected.

| Provider | Needs | Notes |
|---|---|---|
| DuckDuckGo | nothing | Default. Public HTTPS only. |
| Brave Search API | API key | Remote JSON API. |
| Tavily | API key | Remote JSON API. |
| Exa | API key | Remote JSON API. |
| DeepSeek Search | API key | Remote JSON API, billed per successful request. Also serves `web_fetch`. See below. |
| SearXNG | a loopback instance you run | See [Use local SearXNG](use-local-searxng.md). |

In the TUI, `/search-provider` with no arguments opens a wizard. DuckDuckGo has
no fields and no key; keyed remotes ask for a credential; SearXNG asks for host
and port.

## DeepSeek Search

`/search-provider deepseek` connects [DeepSeek's Search API](https://api-docs.deepseek.com/guides/search/)
and makes it active in one step.
The key is the same one DeepSeek's chat models use, so keryx reuses the key you
already saved for the `deepseek` model provider: pressing Enter on the wizard's
credential step (or running `/search-provider deepseek` with no `key=`) borrows
it. A key you paste there is stored separately and wins.

**It also takes over `web_fetch`.** While DeepSeek is the active provider,
`web_fetch` asks [DeepSeek's Fetch API](https://api-docs.deepseek.com/guides/search/)
for the page and gets Markdown back, instead of scraping HTML through the
sandbox transport. That is usually better content for a model; it is also a
second billable request. Every other provider leaves `web_fetch` on the local
transport, and a provider that refuses a page is reported rather than quietly
replaced by the transport.

Three things to know:

- **It costs money.** Search and fetch are billed per successful request ($0.75
  per 1,000 each, not per result), and the account balance is shared with chat
  usage. With no credit the API answers HTTP 402; keryx reports that as
  `insufficient balance` rather than as a broken connection. Requests that fail
  or return nothing are not billed.
- **Queries and URLs leave the machine.** As with every remote provider here,
  the query and the page URL are sent to the provider. Content that looks like a
  secret is refused before any request is made.
- **A fetched page is still untrusted.** Fetched Markdown goes through the same
  sanitizer as scraped HTML: the injection scan and secret redaction apply, and
  the result is marked untrusted for the rest of the turn.

Search results are read into `snippet` from DeepSeek's `summary` field, which is
the long form written for a model. Publication dates are shown with each result
as `Published: YYYY-MM-DD` when the provider reports them.

## Reading the page

`web_fetch` returns readable text, not markup. A page longer than 128 KB is not
an error: keryx keeps the first 128 KB and says so, because a model reads the
beginning of a page and a failed fetch teaches it nothing. JSON responses (the
remote search and fetch APIs) are never cut — half a JSON document is not a
smaller document, so an oversized JSON body stays an error.

## Switching back to DuckDuckGo

`/search-connect duckduckgo` selects it without a prior connection test.
