// Declared authentication methods and OAuth endpoints per provider.
// Compliance boundary (D-01): a method is listed only when the vendor
// sanctions third-party clients. Claude Pro/Max, Gemini Google-account
// login, and DeepSeek subscription OAuth are not in this file as grants.

import type { OAuthGrantMethod } from "./grants";

export type AuthMethodKind = "none" | "api-key" | "device-code" | "oauth-pkce-loopback" | "cloud-credentials";

export interface DeviceCodeEndpoints {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
  extraForm?: Record<string, string>;
  headers?: Record<string, string>;
  /** After the RFC 8628 token, a second exchange (GitHub Copilot). */
  afterToken?: "github-copilot";
}

export interface ProviderAuthCatalog {
  provider: string;
  label: string;
  methods: readonly AuthMethodKind[];
  device?: DeviceCodeEndpoints;
  /** Shown when an operator asks for a forbidden subscription login. */
  refusal?: string;
}

export const XAI_GROK_DEVICE: DeviceCodeEndpoints = {
  deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access",
  extraForm: { referrer: "keryx" },
  headers: { "User-Agent": "keryx" },
};

/**
 * Identity GitHub's Copilot endpoints accept. `copilot_internal/v2/token`
 * and `api.githubcopilot.com` 403 without these; `User-Agent: keryx` is not enough.
 */
export const GITHUB_COPILOT_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.99.3",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
};

/**
 * GitHub Copilot GitHub App — same client VS Code, Copilot CLI, copilot.vim,
 * and LiteLLM use. OpenCode's OAuth App `Ov23li8tweQw6odWQebz` mints `gho_`
 * tokens that `copilot_internal/v2/token` rejects with 403/404.
 */
export const GITHUB_COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const GITHUB_COPILOT_DEVICE: DeviceCodeEndpoints = {
  deviceAuthorizationEndpoint: "https://github.com/login/device/code",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  clientId: GITHUB_COPILOT_OAUTH_CLIENT_ID,
  scope: "read:user",
  headers: GITHUB_COPILOT_REQUEST_HEADERS,
  afterToken: "github-copilot",
};

export function extraRequestHeaders(provider: string): Readonly<Record<string, string>> | undefined {
  if (provider === "github-copilot") {
    return GITHUB_COPILOT_REQUEST_HEADERS;
  }
  return undefined;
}

export const PROVIDER_AUTH_CATALOG: readonly ProviderAuthCatalog[] = [
  {
    provider: "grok",
    label: "xAI (Grok)",
    methods: ["device-code", "api-key"],
    device: XAI_GROK_DEVICE,
  },
  {
    provider: "openai",
    label: "OpenAI API",
    methods: ["api-key"],
  },
  {
    provider: "openai-codex",
    label: "ChatGPT / Codex subscription",
    methods: ["device-code"],
  },
  {
    provider: "github-copilot",
    label: "GitHub Copilot",
    methods: ["device-code"],
    device: GITHUB_COPILOT_DEVICE,
  },
  { provider: "anthropic", label: "Anthropic", methods: ["api-key"], refusal: "Anthropic does not permit third-party Claude Pro/Max login. Use an API key from the Anthropic Console." },
  { provider: "gemini", label: "Google Gemini", methods: ["api-key"], refusal: "Gemini Google-account login is for Gemini CLI. In keryx use GEMINI_API_KEY from Google AI Studio." },
  { provider: "deepseek", label: "DeepSeek", methods: ["api-key"], refusal: "DeepSeek has no consumer OAuth grant. Use DEEPSEEK_API_KEY." },
  { provider: "openrouter", label: "OpenRouter", methods: ["api-key"] },
  { provider: "zai", label: "Z.AI (GLM)", methods: ["api-key"] },
  { provider: "zai-coding", label: "Z.AI GLM Coding Plan", methods: ["api-key"] },
  { provider: "cerebras", label: "Cerebras", methods: ["api-key"] },
  { provider: "groq", label: "Groq", methods: ["api-key"] },
  { provider: "moonshot", label: "Moonshot (Kimi)", methods: ["api-key"] },
  { provider: "ollama", label: "Ollama", methods: ["none"] },
  { provider: "rapid-mlx", label: "Rapid-MLX (Local)", methods: ["none"] },
];

export function authCatalogEntry(provider: string): ProviderAuthCatalog | undefined {
  return PROVIDER_AUTH_CATALOG.find((entry) => entry.provider === provider);
}

export function catalogMethods(provider: string): readonly AuthMethodKind[] {
  return authCatalogEntry(provider)?.methods ?? ["api-key"];
}

export function catalogAllows(provider: string, method: AuthMethodKind): boolean {
  return catalogMethods(provider).includes(method);
}

export function catalogRefusal(provider: string): string | undefined {
  return authCatalogEntry(provider)?.refusal;
}

export function deviceCodeMethodLabel(provider: string): string {
  if (provider === "grok") return "SuperGrok Subscription";
  if (provider === "github-copilot") return "Login with GitHub Copilot";
  if (provider === "openai-codex") return "ChatGPT Plus/Pro (headless)";
  return "Device authorization";
}

export function oauthMethodOf(method: AuthMethodKind): OAuthGrantMethod | undefined {
  if (method === "device-code" || method === "oauth-pkce-loopback") {
    return method;
  }
  return undefined;
}
