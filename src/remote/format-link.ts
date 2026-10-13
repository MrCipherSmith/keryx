// A link whose visible text names one site and whose target is another (flow 395, S-002).
//
// `[https://mybank.example](https://evil.example/login)` shows the operator one address and opens
// another. When the label looks like a URL or a host and the target's host is a different host, the
// renderer writes the target's host next to the label: `https://mybank.example (→ evil.example)`.
// A label that is ordinary text (`docs`, `the report`), and a label whose host is the target's host
// (ignoring case, a leading `www.` and a port), are left exactly as they were.
//
// The host is read with the WHATWG URL parser, so an internationalised name is shown in its
// punycode form (`xn--...`), which is what makes a look-alike visible. An address with a user part
// (`https://bank.example@evil.example`) always shows the host: the part before the `@` is exactly
// what a spoofed label uses. A target the parser refuses falls back to the text between `://` and
// the next `/`, `?` or `#`; nothing here throws.

const SCHEME = /^https?:\/\//i;
/** `www.example.com`, `example.com`, `example.com/path`, `example.com:8080`: a dot, no spaces, a letter-only last label. */
const HOST_LIKE = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?::\d+)?(?:[/?#]\S*)?$/u;
/** `README.md` and `index.ts` have a dot and no spaces but name a file, not a site. */
const FILE_EXTENSION = /\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|lock|log|csv|tsv|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|sh|zsh|bash|sql|png|jpe?g|gif|svg|webp|pdf|zip|tgz|gz|ini|env|conf|cfg)(?:[?#]\S*)?$/i;

interface Address {
  host: string;
  /** The address has a user part (`user@host`). */
  userinfo: boolean;
}

function parse(text: string): Address {
  try {
    const url = new URL(text);
    return { host: normalise(url.hostname), userinfo: url.username !== "" || url.password !== "" };
  } catch {
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text)?.[1] ?? text.split(/[/?#]/, 1)[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = (at < 0 ? authority : authority.slice(at + 1)).replace(/:\d*$/, "");
    return { host: normalise(host), userinfo: at >= 0 };
  }
}

function normalise(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** The label with the emphasis and code marks a model wraps around it removed. */
function bare(label: string): string {
  return label.replace(/^[\s*_~`]+|[\s*_~`]+$/g, "");
}

/** Whether the label reads as an address: a scheme, `www.`, or a host with a dot. */
function looksLikeAddress(label: string): boolean {
  return SCHEME.test(label) || /^www\./i.test(label) || (HOST_LIKE.test(label) && !FILE_EXTENSION.test(label));
}

/**
 * The host to show next to a link, or undefined when the link needs nothing. `label` is the Markdown
 * source of the visible text and `url` the http(s) target.
 */
export function mismatchedHost(label: string, url: string): string | undefined {
  const text = bare(label);
  if (!looksLikeAddress(text)) {
    return undefined;
  }
  const target = parse(url);
  const shown = parse(SCHEME.test(text) ? text : `https://${text}`);
  if (target.host.length === 0) {
    return undefined;
  }
  if (!target.userinfo && !shown.userinfo && shown.host === target.host) {
    return undefined;
  }
  // At most what the Markdown spent on the target (`](` + url + `)` ...), so the part never grows.
  const room = Math.max(1, url.length - 1);
  return target.host.length > room ? `${target.host.slice(0, room - 1)}…` : target.host;
}

/** The text written after the link, already free of markup: ` (→ host)`. */
export function hostMarker(label: string, url: string): string {
  const host = mismatchedHost(label, url);
  return host === undefined ? "" : ` (→ ${host})`;
}
