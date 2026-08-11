import { lookup as systemLookup } from "node:dns/promises";
import { sanitizeWebContent, type SanitizedWebContent } from "./web-content";
import type {
  SandboxedWebRequest as SearchWebRequest,
  SandboxedWebResponse as SearchWebResponse,
} from "../search/types";
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
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  credential?: { injection: "header" | "json-body"; name: string; value: string };
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
    const raw = await this.fetchRaw({ url: request.url, method: "GET", ...(request.signal !== undefined ? { signal: request.signal } : {}) });
    if (!raw.ok) return raw;
    if (raw.value.response.status < 200 || raw.value.response.status >= 300) {
      return { ok: false, reason: `request failed with HTTP ${raw.value.response.status}` };
    }
    return sanitizeWebContent({
      url: raw.value.url,
      providerId: request.providerId,
      retrievedAt: this.now(),
      contentType: raw.value.response.contentType,
      text: raw.value.response.body,
    });
  }

  /** Search-provider bridge: only adapter-owned request shapes reach this API. */
  async request(request: SearchWebRequest): Promise<SearchWebResponse> {
    const raw = await this.fetchRaw({
      url: request.url,
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.credential !== undefined ? { credential: request.credential } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      localOnly: request.capability === "local-search",
    });
    if (!raw.ok) {
      return {
        ok: false,
        status: 0,
        url: request.url,
        contentType: "",
        text: "",
        error: request.signal?.aborted ? "cancelled" : raw.reason.includes("policy") || raw.reason.includes("private") ? "policy-denied" : "transport-failed",
      };
    }
    return {
      ok: raw.value.response.status >= 200 && raw.value.response.status < 300,
      status: raw.value.response.status,
      url: raw.value.url,
      contentType: raw.value.response.contentType,
      text: raw.value.response.body,
    };
  }

  private async fetchRaw(request: {
    url: string;
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    credential?: { injection: "header" | "json-body"; name: string; value: string };
    signal?: AbortSignal;
    localOnly?: boolean;
  }): Promise<WebPolicyResult<{ url: string; response: WebWorkerResponse }>> {
    let parsed = parsePublicHttpsUrl(request.url);
    if (request.localOnly === true) {
      try {
        const local = new URL(request.url);
      const allowedHost = local.hostname === "localhost" || local.hostname === "127.0.0.1" || local.hostname === "::1" || local.hostname === "[::1]";
        if (local.protocol !== "http:" || !allowedHost || local.username || local.password) {
          return { ok: false, reason: "local search endpoint violates its capability policy" };
        }
        parsed = { ok: true, value: local };
      } catch {
        return { ok: false, reason: "local search endpoint violates its capability policy" };
      }
    }
    if (!parsed.ok) return parsed;
    let url = parsed.value;
    for (let redirects = 0; redirects <= WEB_MAX_REDIRECTS; redirects += 1) {
      const target = request.localOnly === true
        ? { ok: true as const, value: { url: url.toString(), hostname: url.hostname, address: url.hostname === "::1" || url.hostname === "[::1]" ? "::1" : "127.0.0.1" } }
        : await validatePublicTarget(url, this.lookup);
      if (!target.ok) return target;
      const worker = await this.runner.run(
        {
          url: target.value.url,
          hostname: target.value.hostname,
          address: target.value.address,
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
          ...(request.credential !== undefined ? { credential: request.credential } : {}),
        }, request.signal,
      );
      if (!worker.ok) return worker;
      const response = worker.value;
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        return { ok: false, reason: "sandbox worker returned an invalid response" };
      }
      if (response.status >= 300 && response.status < 400) {
        if (request.localOnly === true) return { ok: false, reason: "local search redirects are not allowed" };
        if (redirects === WEB_MAX_REDIRECTS) return { ok: false, reason: "too many redirects" };
        if (typeof response.location !== "string") return { ok: false, reason: "invalid redirect destination" };
        parsed = parsePublicHttpsUrl(new URL(response.location, url).toString());
        if (!parsed.ok) return parsed;
        url = parsed.value;
        continue;
      }
      if (!readableContentType(response.contentType)) {
        return { ok: false, reason: "response is not readable text content" };
      }
      if (new TextEncoder().encode(response.body).byteLength > WEB_MAX_TEXT_BYTES) {
        return { ok: false, reason: "response exceeds size limit" };
      }
      return { ok: true, value: { url: url.toString(), response } };
    }
    return { ok: false, reason: "too many redirects" };
  }
}
