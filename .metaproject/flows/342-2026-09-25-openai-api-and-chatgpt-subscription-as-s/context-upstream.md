# Verified OpenAI subscription protocol

Verified 2026-09-26 against OpenAI Codex commit `58670eeac4b0bdb9fcb86929d8631c14aee0d9f6`. Latest published release observed: `rust-v0.157.0`.

- Native SSE endpoint: `https://chatgpt.com/backend-api/codex/responses`; bearer OAuth access token plus `ChatGPT-Account-ID`. Platform API remains separate.
- Request follows Responses input/tool structures, `store:false`, `stream:true`. Upstream Codex struct does not send `max_output_tokens` or `temperature`; omit these subscription parameters. Native tool execution remains Keryx-owned; no app-server dependency.
- Model listing: `GET .../codex/models?client_version=<semver>`, response models use `slug` and `visibility`. Version query is Codex compatibility metadata, not a guarantee of entitlement.
- Device authorization: JSON client_id to `/api/accounts/deviceauth/usercode`; browser at `/codex/device`; poll `/api/accounts/deviceauth/token` with device_auth_id and user_code. 403/404 pending, server interval, 15-minute maximum. Exchange returned authorization_code + verifier at `/oauth/token` using form encoding and `/deviceauth/callback` redirect URI.
- Account identity comes from id_token claim `["https://api.openai.com/auth"].chatgpt_account_id`; legacy access JWT supports the same metadata fallback. Decoding does not authenticate a token: backend validation remains authoritative. Access JWT exp provides expiry when expires_in is absent.
- Refresh: JSON POST `/oauth/token` with grant_type refresh_token, client_id `app_EMoamEEZ73f0CkXaXp7hrann`, refresh_token. Preserve omitted refresh token/identity, persist rotation. Never expose remote token response or transport error text. Invalid grant/expired/reused/revoked refresh requires login.
- Device login requires enabling the ChatGPT security setting. Browser-completed device login is sufficient for this scope; loopback PKCE is not advertised.

## Primary sources
- [Authentication documentation](https://learn.chatgpt.com/docs/auth)
- [Provider URL routing](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/model-provider-info/src/lib.rs)
- [Bearer/account headers](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/model-provider/src/bearer_auth_provider.rs)
- [Responses request fields](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/codex-api/src/common.rs)
- [Request construction](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/core/src/client.rs)
- [Device login](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/login/src/device_code_auth.rs)
- [JWT metadata](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/login/src/token_data.rs)
- [Refresh lifecycle](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/login/src/auth/manager.rs)
- [Model discovery](https://github.com/openai/codex/blob/58670eeac4b0bdb9fcb86929d8631c14aee0d9f6/codex-rs/codex-api/src/endpoint/models.rs)

No real user authorization or entitlement request was performed. Protocol compatibility is established from source, not a promise that private backend contracts will remain stable.
