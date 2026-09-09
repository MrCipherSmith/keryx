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

export const GITHUB_COPILOT_DEVICE: DeviceCodeEndpoints = {
  deviceAuthorizationEndpoint: "https://github.com/login/device/code",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  clientId: "Ov23li8tweQw6odWQebz",
  scope: "read:user",
  headers: { Accept: "application/json", "User-Agent": "keryx" },
  afterToken: "github-copilot",
};

export const PROVIDER_AUTH_CATALOG: readonly ProviderAuthCatalog[] = [
  {
    provider: "grok",
    label: "xAI (Grok)",
    methods: ["device-code", "api-key"],
    device: XAI_GROK_DEVICE,
  },
  {
    provider: "openai",
    label: "OpenAI",
    methods: ["oauth-pkce-loopback", "device-code", "api-key"],
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
  if (provider === "openai") return "ChatGPT Plus/Pro (headless)";
  return "Device authorization";
}

export function oauthMethodOf(method: AuthMethodKind): OAuthGrantMethod | undefined {
  if (method === "device-code" || method === "oauth-pkce-loopback") {
    return method;
  }
  return undefined;
}
