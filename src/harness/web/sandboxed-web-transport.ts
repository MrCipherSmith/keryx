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
/** One budget for DNS, every redirect hop and every worker run of a request. */
export const WEB_TOTAL_DEADLINE_MS = 20_000;
const DEADLINE_REASON = "web request deadline exceeded";

export interface WebWorkerRequest {
  url: string;
  hostname: string;
  address: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  credential?: { injection: "header" | "json-body"; name: string; value: string };
  /**
   * Send the browser-shaped header set instead of the bare `accept` list.
   *
   * Set for SEARCH providers only: they answer a browser and bot-check
   * anything else, while a page `web_fetch` retrieves must not be requested
   * as if a browser were loading it.
   */
  browserHeaders?: boolean;
}

export interface WebWorkerResponse {
  status: number;
  contentType: string;
  body: string;
  location?: string;
  /** The worker cut the body at the byte budget instead of failing the page. */
  truncated?: boolean;
}

export interface WebWorkerRunner {
  run(request: WebWorkerRequest, signal?: AbortSignal): Promise<WebPolicyResult<WebWorkerResponse>>;
}

export interface WebPageRequest {
  url: string;
  providerId: string;
  signal?: AbortSignal;
}

interface FetchRawRequest {
  url: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  credential?: { injection: "header" | "json-body"; name: string; value: string };
  signal?: AbortSignal;
  localOnly?: boolean;
  browserHeaders?: boolean;
}

export interface SandboxedWebTransportOptions {
  lookup?: HostLookup;
  runner: WebWorkerRunner;
  now?: () => string;
  /** Overall deadline for one request across all redirect hops. */
  deadlineMs?: number;
}

function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  return systemLookup(hostname, { all: true }).then((answers) => answers.map(({ address }) => ({ address })));
}

/** A function, so the check is not narrowed away across an await. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
  private readonly deadlineMs: number;

  constructor(options: SandboxedWebTransportOptions) {
    this.lookup = options.lookup ?? defaultLookup;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.deadlineMs = options.deadlineMs ?? WEB_TOTAL_DEADLINE_MS;
  }

  async fetchPage(request: WebPageRequest): Promise<WebPolicyResult<SanitizedWebContent>> {
    const raw = await this.fetchRaw({ url: request.url, method: "GET", ...(request.signal !== undefined ? { signal: request.signal } : {}) });
    if (!raw.ok) return raw;
    if (raw.value.response.status < 200 || raw.value.response.status >= 300) {
      return { ok: false, reason: `request failed with HTTP ${raw.value.response.status}` };
    }
    const content = sanitizeWebContent({
      url: raw.value.url,
      providerId: request.providerId,
      retrievedAt: this.now(),
      contentType: raw.value.response.contentType,
      text: raw.value.response.body,
    });
    return content.ok && raw.value.response.truncated === true
      ? { ok: true, value: { ...content.value, truncated: true } }
      : content;
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
      browserHeaders: request.capability === "public-search",
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

  /**
   * Runs the hops under one deadline. The signal given to the runner joins the
   * caller's signal with the deadline, and the race below also bounds a DNS
   * lookup, which takes no signal.
   */
  private async fetchRaw(request: FetchRawRequest): Promise<WebPolicyResult<{ url: string; response: WebWorkerResponse }>> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.deadlineMs);
    const signal = request.signal !== undefined ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const hops = this.fetchHops({ ...request, signal });
    hops.catch(() => undefined);
    try {
      const winner = await Promise.race([hops, aborted]);
      if (winner !== "aborted") return winner;
      return { ok: false, reason: request.signal?.aborted === true ? "cancelled" : DEADLINE_REASON };
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  private async fetchHops(request: FetchRawRequest): Promise<WebPolicyResult<{ url: string; response: WebWorkerResponse }>> {
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
    // AC2: the credential is scoped to the ORIGIN of the request the caller
    // actually made, not to wherever a 3xx ends up pointing. Without this, a
    // search provider's own API key (or a caller-supplied header/json-body
    // credential) rides along on every hop, so a redirect to an attacker- or
    // third-party-controlled host receives it. Dropped rather than refused:
    // the redirect itself is still followed (search/content behaviour is
    // unaffected for the common same-origin case, e.g. bare domain to `www.`),
    // it is only the secret that stops crossing an origin boundary — the same
    // choice browsers make for `Authorization` on a cross-origin redirect.
    const originalOrigin = url.origin;
    for (let redirects = 0; redirects <= WEB_MAX_REDIRECTS; redirects += 1) {
      if (request.signal?.aborted === true) return { ok: false, reason: "cancelled" };
      const target = request.localOnly === true
        ? { ok: true as const, value: { url: url.toString(), hostname: url.hostname, address: url.hostname === "::1" || url.hostname === "[::1]" ? "::1" : "127.0.0.1" } }
        : await validatePublicTarget(url, this.lookup);
      if (!target.ok) return target;
      // The DNS await can outlive the deadline or a cancel; never start a worker after it.
      if (isAborted(request.signal)) return { ok: false, reason: "cancelled" };
      const sameOrigin = url.origin === originalOrigin;
      const worker = await this.runner.run(
        {
          url: target.value.url,
          hostname: target.value.hostname,
          address: target.value.address,
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
          ...(request.credential !== undefined && sameOrigin ? { credential: request.credential } : {}),
          ...(request.browserHeaders === true ? { browserHeaders: true } : {}),
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
      // A non-truncated body over the budget is still refused: only the worker
      // may hand back a cut body, and it says so.
      if (response.truncated !== true && new TextEncoder().encode(response.body).byteLength > WEB_MAX_TEXT_BYTES) {
        return { ok: false, reason: "response exceeds size limit" };
      }
      return { ok: true, value: { url: url.toString(), response } };
    }
    return { ok: false, reason: "too many redirects" };
  }
}
