// Decode issuer-returned metadata only; the backend validates token authenticity.
export function codexTokenMetadata(token: unknown): {
  accountId?: string;
  expiresAt?: number;
} {
  if (typeof token !== "string" || token.length > 100000 || token.split(".").length !== 3)
    return {};
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null)
      return {};
    const claims = payload as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    const accountId = typeof auth === "object" && auth !== null
      ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    return {
      ...(typeof accountId === "string" && accountId.length > 0 && accountId.trim() === accountId && !/[\r\n]/.test(accountId) ? { accountId } : {}),
      ...(typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0 ? { expiresAt: claims.exp * 1000 } : {}),
    };
  }
  catch {
    return {};
  }
}
