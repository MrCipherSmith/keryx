// T53 — resolution-sufficiency probe.
//
// Row 2 of the T53 dispatch: the claim is that TWO base pairs are *sufficient*,
// not merely more — pair 1 realises the equal-scheme branch and pair 2 the
// differing-scheme branch for every special scheme. This probe tests the claim
// rather than accepting it, by looking for a destination whose classification
// depends on a base property NEITHER pair varies.
//
// The base properties the two pairs hold constant are enumerated from the WHATWG
// URL "basic URL parser", not guessed:
//   scheme        — varied (https / keryx-detector)
//   host          — varied (base-a / base-b)
//   is-special    — varied (https special, keryx-detector not)
//   is-file       — NOT varied (neither pair is a `file:` base, and the file
//                   state is a distinct branch of both the scheme state and the
//                   no-scheme state)
//   opaque path   — NOT varied (both pairs have a hierarchical path; the
//                   no-scheme state FAILS against an opaque-path base)
//   port          — NOT varied (no port on either pair)
//   userinfo      — NOT varied
//   path depth    — NOT varied (`/keryx/page` on all four)
//   query / frag  — NOT varied
//
// So the probe drives every destination form against renderer document bases
// that vary each of those properties, and asks the platform URL parser — not the
// detector — whether a renderer with that document base would issue an http(s)
// request to a host that is not its own. If it would, the detector must flag.
//
// Read-only.
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATTACKER = "attacker.invalid";

// Renderer document bases. The first five are the reviewer's original set; the
// rest vary exactly the base properties neither synthetic pair varies.
const RENDERER_BASES: Array<{ id: string; base: string }> = [
  { id: "https-page", base: "https://client.example.org/chat/thread" },
  { id: "http-page", base: "http://client.example.org/chat/thread" },
  { id: "file-doc", base: "file:///Users/u/Library/App/index.html" },
  { id: "vscode-webview", base: "vscode-webview://0a1b2c3d/index.html" },
  { id: "electron-app-scheme", base: "app://client.example.org/index.html" },
  // base properties neither synthetic pair varies:
  { id: "https-with-port", base: "https://client.example.org:8443/chat/thread" },
  { id: "https-userinfo-path", base: "https://u:p@client.example.org/a/b/c/d" },
  { id: "https-root-no-path", base: "https://client.example.org" },
  { id: "https-query-fragment", base: "https://client.example.org/chat?t=1#x" },
  { id: "ws-special", base: "ws://client.example.org/socket" },
  { id: "ftp-special", base: "ftp://client.example.org/pub/x" },
  { id: "file-unc", base: "file://share.example.org/dir/index.html" },
  { id: "opaque-path-base", base: "app:opaque-document" },
  { id: "custom-hierarchical", base: "chrome-extension://abcdefghij/panel.html" },
  { id: "tauri-scheme", base: "tauri://localhost/index.html" },
];

const DESTINATIONS: Array<{ id: string; url: string; note: string }> = [
  // absolute / protocol-relative, every slash and backslash spelling
  { id: "d.absHttps", url: `https://${ATTACKER}/p`, note: "absolute https" },
  { id: "d.absHttp", url: `http://${ATTACKER}/p`, note: "absolute http" },
  { id: "d.protoRelative", url: `//${ATTACKER}/p`, note: "protocol-relative" },
  { id: "d.backslashAuthority", url: `\\\\${ATTACKER}/p`, note: "backslash authority" },
  { id: "d.tripleSlash", url: `///${ATTACKER}/p`, note: "three slashes" },
  { id: "d.schemeTripleSlash", url: `https:///${ATTACKER}/p`, note: "scheme + three slashes" },
  { id: "d.schemeBackslash", url: `https:\\\\${ATTACKER}/p`, note: "scheme + backslashes" },
  { id: "d.schemeMixedSlash", url: `https:/\\${ATTACKER}/p`, note: "scheme + / then backslash" },

  // scheme with no slashes — the T42#F-002 class, in every special scheme
  { id: "d.httpsNoSlash", url: `https:${ATTACKER}/p`, note: "https, no slashes" },
  { id: "d.httpsOneSlash", url: `https:/${ATTACKER}/p`, note: "https, one slash" },
  { id: "d.httpNoSlash", url: `http:${ATTACKER}/p`, note: "http, no slashes" },
  { id: "d.httpOneSlash", url: `http:/${ATTACKER}/p`, note: "http, one slash" },
  { id: "d.httpsUpper", url: `HTTPS:${ATTACKER}/p`, note: "uppercase scheme" },
  { id: "d.httpsMixed", url: `HtTpS:${ATTACKER}/p`, note: "mixed-case scheme" },
  { id: "d.httpsSpacePad", url: ` https:${ATTACKER}/p `, note: "leading/trailing space" },
  { id: "d.wsNoSlash", url: `ws:${ATTACKER}/p`, note: "ws, no slashes (special)" },
  { id: "d.wssNoSlash", url: `wss:${ATTACKER}/p`, note: "wss, no slashes (special)" },
  { id: "d.ftpNoSlash", url: `ftp:${ATTACKER}/p`, note: "ftp, no slashes (special)" },
  { id: "d.fileNoSlash", url: `file:${ATTACKER}/p`, note: "file, no slashes (special)" },
  { id: "d.fileAuthority", url: `file://${ATTACKER}/p`, note: "file with authority" },

  // the detector's own private scheme, spelled by the attacker
  { id: "d.privateScheme", url: `keryx-detector://${ATTACKER}/p`, note: "detector's own base scheme" },
  { id: "d.privateSchemeNoSlash", url: `keryx-detector:${ATTACKER}/p`, note: "detector scheme, no slashes" },

  // non-special / non-network schemes
  { id: "d.dataUri", url: "data:image/png;base64,iVBORw0KGgo=", note: "data" },
  { id: "d.blob", url: `blob:https://${ATTACKER}/1-2-3`, note: "blob" },
  { id: "d.mailto", url: "mailto:a@example.org", note: "mailto" },
  { id: "d.javascript", url: "javascript:fetch(1)", note: "javascript" },
  { id: "d.about", url: "about:blank", note: "about" },
  { id: "d.customScheme", url: `x-custom://${ATTACKER}/p`, note: "unknown non-special scheme" },

  // relative destinations — must never be flagged
  { id: "r.rootRelative", url: "/assets/a.png", note: "root-relative" },
  { id: "r.pathRelative", url: "a.png", note: "path-relative" },
  { id: "r.dotSegments", url: "../../a.png", note: "dot segments" },
  { id: "r.fragmentOnly", url: "#frag", note: "fragment only" },
  { id: "r.queryOnly", url: "?q=1", note: "query only" },
  { id: "r.empty", url: "", note: "empty" },
  { id: "r.backslashPath", url: "/assets/a\\b/logo.png", note: "backslash in a relative path" },
  { id: "r.percentSlashes", url: `%2f%2f${ATTACKER}/p`, note: "percent-encoded slashes" },
  { id: "r.percentColon", url: `https%3a//${ATTACKER}/p`, note: "percent-encoded colon" },
  { id: "r.bareHostText", url: "docs.example.org/pixel.png", note: "host-looking relative path" },
  { id: "r.colonInPath", url: "a:b/c.png", note: "colon in a relative path segment" },
  { id: "r.singleSlashHost", url: `/${ATTACKER}/p`, note: "one slash then a host-looking name" },
  { id: "r.dotSlashHost", url: `.//${ATTACKER}/p`, note: "dot then protocol-relative-looking" },
];

function remoteHttpHost(url: string, base: string): string | null {
  let resolved: URL;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
    resolved = new URL(url, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  const host = resolved.hostname.toLowerCase();
  if (host.length === 0) return null;
  if (host === baseUrl.hostname.toLowerCase()) return null; // same-origin: no channel
  return host;
}

interface Row {
  id: string;
  url: string;
  note: string;
  detectorFlagged: boolean;
  detectorPolicyIds: string[];
  rendererRemoteHosts: Record<string, string>;
  verdict: "OK" | "BYPASS" | "FALSE-POSITIVE";
}

function main(): void {
  const rows: Row[] = [];
  const bypasses: string[] = [];
  const falsePositives: string[] = [];

  for (const destination of DESTINATIONS) {
    const rendererRemoteHosts: Record<string, string> = {};
    for (const renderer of RENDERER_BASES) {
      const host = remoteHttpHost(destination.url, renderer.base);
      if (host) rendererRemoteHosts[renderer.id] = host;
    }
    const anyRendererFetchesRemote = Object.keys(rendererRemoteHosts).length > 0;

    // Drive the destination through the real detector on the HTML image surface.
    const matches = detectExfil(`<img src="${destination.url}">`, []);
    const detectorFlagged = matches.length > 0;

    let verdict: Row["verdict"] = "OK";
    if (anyRendererFetchesRemote && !detectorFlagged) {
      verdict = "BYPASS";
      bypasses.push(destination.id);
    } else if (!anyRendererFetchesRemote && detectorFlagged) {
      verdict = "FALSE-POSITIVE";
      falsePositives.push(destination.id);
    }

    rows.push({
      id: destination.id,
      url: destination.url,
      note: destination.note,
      detectorFlagged,
      detectorPolicyIds: matches.map((match) => match.policyId),
      rendererRemoteHosts,
      verdict,
    });
  }

  const summary = {
    destinations: DESTINATIONS.length,
    rendererBases: RENDERER_BASES.length,
    bypasses: bypasses.length,
    bypassIds: bypasses,
    falsePositives: falsePositives.length,
    falsePositiveIds: falsePositives,
  };

  for (const row of rows) {
    const reach = Object.entries(row.rendererRemoteHosts)
      .map(([renderer, host]) => `${renderer}=${host}`)
      .join(" ");
    console.log(
      `${row.verdict.padEnd(14)} ${row.id.padEnd(24)} flagged=${String(row.detectorFlagged).padEnd(5)} ${reach || "(no remote host under any renderer base)"}`,
    );
  }
  console.log(JSON.stringify(summary, null, 2));

  const out = process.argv[2];
  if (out) {
    Bun.write(out, JSON.stringify({ summary, rows }, null, 2));
  }
}

main();
