import { MachineError } from './errors';
import { trustedHubUrl } from './config';
const valid = (value: string | undefined): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
/**
 * Cloudflare Access service-token headers for a Hub behind Access, with the rules of the MCP bridge (src/hub/mcp-bridge.ts): the URL must
 * pass trustedHubUrl first, both variables or neither, environment only. Values are never stored and never named in an error.
 */
export function hubAccessHeaders(hubUrl: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
    trustedHubUrl(hubUrl);
    const id = env.KERYX_CF_ACCESS_CLIENT_ID, secret = env.KERYX_CF_ACCESS_CLIENT_SECRET;
    if (id === undefined && secret === undefined)
        return {};
    if (id === undefined || secret === undefined)
        throw new MachineError('cloudflare-access-incomplete');
    if (!valid(id) || !valid(secret))
        throw new MachineError('cloudflare-access-invalid');
    return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}
