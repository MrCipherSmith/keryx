import { spawn } from "node:child_process";
import { catalogAllows, catalogRefusal, deviceCodeMethodLabel, PROVIDER_AUTH_CATALOG } from "../lib/oauth/catalog";
import { applyOAuthAccessToEnv, listOAuthGrantProviders, oauthGrantStatus } from "../lib/oauth/grants";
import { loginDeviceCode, logoutProvider } from "../lib/oauth/login";

function printAuthHelp(): void {
  console.log(`Usage:
  keryx auth list [--json]
  keryx auth login <provider>
  keryx auth logout <provider>
  keryx auth status <provider> [--json]

Providers with a sanctioned subscription login: grok (SuperGrok), openai (ChatGPT Plus/Pro), github-copilot.
Claude Pro/Max, Gemini Google-account login, and DeepSeek OAuth are not offered.
`);
}

function openVerificationUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Printing the URL is enough; opening a browser is best-effort.
  }
}

export async function authCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printAuthHelp();
    return;
  }
  if (command === "list") {
    runAuthList(args.slice(1));
    return;
  }
  if (command === "login") {
    await runAuthLogin(args.slice(1));
    return;
  }
  if (command === "logout") {
    runAuthLogout(args.slice(1));
    return;
  }
  if (command === "status") {
    runAuthStatus(args.slice(1));
    return;
  }
  console.error(`Unknown auth command: ${command}`);
  printAuthHelp();
  process.exitCode = 1;
}

function runAuthList(args: string[]): void {
  const authorized = listOAuthGrantProviders().map((provider) => oauthGrantStatus(provider)).filter((row) => row !== undefined);
  const offered = PROVIDER_AUTH_CATALOG.filter((entry) => entry.methods.some((m) => m === "device-code" || m === "oauth-pkce-loopback")).map((entry) => ({
    provider: entry.provider,
    methods: [...entry.methods],
  }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ authorized, offered }, null, 2));
    return;
  }
  console.log("# authorized providers");
  console.log("");
  if (authorized.length === 0) {
    console.log("none");
  } else {
    for (const row of authorized) {
      console.log(`- ${row.provider}: ${row.method} (${row.state}${row.refreshable ? ", refreshable" : ""})`);
    }
  }
  console.log("");
  console.log("# subscription login offered");
  for (const row of offered) {
    console.log(`- ${row.provider}: ${row.methods.join(", ")}`);
  }
}

async function runAuthLogin(args: string[]): Promise<void> {
  const provider = args[0];
  if (provider === undefined || provider.length === 0) {
    console.error("Usage: keryx auth login <provider>");
    process.exitCode = 1;
    return;
  }
  if (!catalogAllows(provider, "device-code") && !catalogAllows(provider, "oauth-pkce-loopback")) {
    const refusal = catalogRefusal(provider);
    console.error(refusal ?? `${provider} has no subscription login. Use an API key.`);
    process.exitCode = 1;
    return;
  }
  const result = await loginDeviceCode({
    provider,
    fetch: (input, init) => globalThis.fetch(input, init),
    onChallenge: (challenge) => {
      console.log(challenge.instructions);
      openVerificationUrl(challenge.verificationUriComplete ?? challenge.verificationUri);
    },
  });
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  applyOAuthAccessToEnv();
  console.log(`Authorized ${provider} via ${deviceCodeMethodLabel(provider)}.`);
}

function runAuthLogout(args: string[]): void {
  const provider = args[0];
  if (provider === undefined || provider.length === 0) {
    console.error("Usage: keryx auth logout <provider>");
    process.exitCode = 1;
    return;
  }
  logoutProvider(provider);
  console.log(`Logged out ${provider}.`);
}

function runAuthStatus(args: string[]): void {
  const provider = args[0];
  if (provider === undefined || provider.length === 0) {
    console.error("Usage: keryx auth status <provider>");
    process.exitCode = 1;
    return;
  }
  const status = oauthGrantStatus(provider);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ status: status ?? null }, null, 2));
    return;
  }
  if (status === undefined) {
    console.log(`${provider}: not authorized`);
    return;
  }
  console.log(`${provider}: ${status.method} ${status.state}${status.expiresAt !== undefined ? ` (expires ${status.expiresAt})` : ""}${status.refreshable ? ", refreshable" : ""}`);
}
