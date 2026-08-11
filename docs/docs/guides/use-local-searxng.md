# Use local SearXNG for agent web search

Keryx can use a SearXNG instance that you operate yourself. It is an explicit
search-provider option, not a general permission for the agent to access your
local network.

## Start SearXNG

For a quick local instance, follow the official [SearXNG installation
guide](https://docs.searxng.org/admin/installation.html). A typical Docker
command is:

```sh
docker run --rm -p 8080:8080 searxng/searxng
```

Keryx does not run Docker or alter your SearXNG configuration.

## Connect it in Keryx

In agent mode:

1. Run `/search-provider` and choose **SearXNG**.
2. Confirm or edit the default URL `http://localhost` and port `8080`.
3. Run the connection test. A provider is not considered connected until this
   request returns the expected SearXNG JSON result shape.
4. Run `/search-connect` and select SearXNG. That list intentionally includes
   only providers with a successful connection test.

Then the agent can call `web_search`. When no provider is active, it returns
setup guidance rather than silently choosing another service.

## Troubleshooting

- **Connection refused:** make sure SearXNG is running and its published port
  matches the configured port.
- **Incompatible response:** the configured endpoint must expose SearXNG's
  `/search?...&format=json` API, not an HTML error page or a reverse-proxy login
  page.
- **Provider disappears from `/search-connect`:** edit/test it again. Changing
  configuration invalidates its connected state until a new test succeeds.

The SearXNG exception is limited to its configured loopback endpoint. It does
not make `web_fetch` or cloud search providers able to access private addresses.
