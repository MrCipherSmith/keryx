import { lookup as systemLookup } from "node:dns/promises";
import { sanitizeWebContent, type SanitizedWebContent } from "./web-content";
import {
  parsePublicHttpsUrl,
  validatePublicTarget,
  type HostLookup,
  type WebPolicyResult,
} from "./web-policy";

export const WEB_MAX_REDIRECTS = 3;
export const WEB_MAX_TEXT_BYTES = 128_000;

export interface WebWorkerRequest {
  url: string;
  hostname: string;
  address: string;
  method: "GET";
}

export interface WebWorkerResponse {
  status: number;
  contentType: string;
  body: string;
  location?: string;
}

export interface WebWorkerRunner {
  run(request: WebWorkerRequest, signal?: AbortSignal): Promise<WebPolicyResult<WebWorkerResponse>>;
}

export interface WebPageRequest {
  url: string;
  providerId: string;
  signal?: AbortSignal;
}

export interface SandboxedWebTransportOptions {
  lookup?: HostLookup;
  runner: WebWorkerRunner;
  now?: () => string;
}

function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  return systemLookup(hostname, { all: true }).then((answers) => answers.map(({ address }) => ({ address })));
}

function readableContentType(contentType: string): boolean {
  return /^(?:text\/(?:html|plain)|application\/(?:json|xml|xhtml\+xml))(?:\s*;|$)/i.test(contentType);
}

/**
 * Single remote-web boundary. Its runner is intentionally injected so tests and
 * provider adapters cannot substitute a direct network client for this port.
 */
export class SandboxedWebTransport {
  private readonly lookup: HostLookup;
  private readonly runner: WebWorkerRunner;
  private readonly now: () => string;

  constructor(options: SandboxedWebTransportOptions) {
    this.lookup = options.lookup ?? defaultLookup;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async fetchPage(request: WebPageRequest): Promise<WebPolicyResult<SanitizedWebContent>> {
    let parsed = parsePublicHttpsUrl(request.url);
    if (!parsed.ok) return parsed;
    let url = parsed.value;
    for (let redirects = 0; redirects <= WEB_MAX_REDIRECTS; redirects += 1) {
      const target = await validatePublicTarget(url, this.lookup);
      if (!target.ok) return target;
      const worker = await this.runner.run(
        { url: target.value.url, hostname: target.value.hostname, address: target.value.address, method: "GET" },
        request.signal,
      );
      if (!worker.ok) return worker;
      const response = worker.value;
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        return { ok: false, reason: "sandbox worker returned an invalid response" };
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects === WEB_MAX_REDIRECTS) return { ok: false, reason: "too many redirects" };
        if (typeof response.location !== "string") return { ok: false, reason: "invalid redirect destination" };
        parsed = parsePublicHttpsUrl(new URL(response.location, url).toString());
        if (!parsed.ok) return parsed;
        url = parsed.value;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: `request failed with HTTP ${response.status}` };
      }
      if (!readableContentType(response.contentType)) {
        return { ok: false, reason: "response is not readable text content" };
      }
      if (new TextEncoder().encode(response.body).byteLength > WEB_MAX_TEXT_BYTES) {
        return { ok: false, reason: "response exceeds size limit" };
      }
      return sanitizeWebContent({
        url: url.toString(),
        providerId: request.providerId,
        retrievedAt: this.now(),
        contentType: response.contentType,
        text: response.body,
      });
    }
    return { ok: false, reason: "too many redirects" };
  }
}
