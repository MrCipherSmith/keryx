import { describe, expect, test } from "bun:test";
import { containsOutboundSecret } from "./outbound-secret";
import { redactSensitiveText } from "../../security/redact";

// F-LOG-F1/F-SEC-F1 follow-up (flow 355 review round 2): the coordinator's own
// probe against REAL urls found two ordinary ones refused — an npm tarball
// URL and a `+`-joined search query. Both are fixed (see `detect/entropy.ts`'s
// header), but a crafted regression test proves only the two REPORTED shapes.
// This fixture is the broader net: 60+ realistic URLs and search queries that
// a normal `web_fetch`/`web_search` session produces constantly, asserting
// NEITHER `containsOutboundSecret` NOR `redactSensitiveText` treats any of
// them as secret-shaped — except the one documented class below.

const ORDINARY_URLS: string[] = [
  // Search queries — English, plus-joined (the wire shape web_search sends).
  "https://www.google.com/search?q=bun+test+timeout+flaky",
  "https://www.google.com/search?q=how+to+fix+flaky+tests+in+bun",
  "https://www.google.com/search?q=TypeError%3A+Cannot+read+properties+of+undefined",
  "https://www.google.com/search?q=how+to+debug+memory+leak+in+node+process",
  "https://www.google.com/search?q=what+is+the+difference+between+let+and+const",
  "https://www.google.com/search?q=docker+compose+up+detached+mode+logs",
  "https://www.google.com/search?q=javascript+array+sort+comparator+function",
  "https://www.google.com/search?q=git+rebase+interactive+squash+commits",
  "https://www.google.com/search?q=eslint+no-unused-vars+typescript+config",
  "https://www.bing.com/search?q=rust+async+tokio+select+macro",
  "https://duckduckgo.com/?q=python+list+comprehension+example",
  "https://en.wikipedia.org/wiki/Special:Search?search=distributed+consensus+algorithms",
  // Search queries — Russian, percent-encoded Cyrillic (the wire shape a
  // browser or `fetch` actually sends; literal UTF-8 bytes never appear).
  "https://www.google.com/search?q=%D0%BA%D0%B0%D0%BA+%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B8%D1%82%D1%8C+bun+test",
  "https://www.google.com/search?q=%D0%BE%D1%88%D0%B8%D0%B1%D0%BA%D0%B0+TypeError+undefined",
  "https://www.google.com/search?q=%D0%BF%D0%BE%D1%87%D0%B5%D0%BC%D1%83+node_modules+%D0%BD%D0%B5+%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%B0%D0%B2%D0%BB%D0%B8%D0%B2%D0%B0%D0%B5%D1%82%D1%81%D1%8F",
  "https://yandex.ru/search/?text=%D0%BA%D0%B0%D0%BA%20%D0%BD%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B8%D1%82%D1%8C%20docker%20compose",

  // npm / PyPI / crates.io tarball URLs with versions.
  "https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz",
  "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
  "https://registry.npmjs.org/@babel/core/-/core-7.24.7.tgz",
  "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  "https://files.pythonhosted.org/packages/py3/n/numpy/numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.whl",
  "https://pypi.org/project/requests/2.32.3/",
  "https://pypi.org/simple/flask/",
  "https://static.crates.io/crates/tokio/tokio-1.38.0.crate",
  "https://static.crates.io/crates/serde/serde-1.0.203.crate",
  "https://static.crates.io/crates/rand/rand-0.8.5.crate",

  // GitHub raw / blob / commit / compare URLs with real 40-hex SHAs.
  "https://raw.githubusercontent.com/facebook/react/main/packages/react/package.json",
  "https://raw.githubusercontent.com/oven-sh/bun/main/README.md",
  "https://raw.githubusercontent.com/microsoft/TypeScript/main/package.json",
  "https://github.com/facebook/react/blob/main/packages/react/src/React.js",
  "https://github.com/facebook/react/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  "https://github.com/facebook/react/compare/v18.0.0...v18.3.1",
  "https://api.github.com/repos/facebook/react/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  "https://github.com/torvalds/linux/commit/1234567890abcdef1234567890abcdef12345678",
  "https://github.com/microsoft/TypeScript/commit/deadbeefcafebabe0123456789abcdef01234567",
  "https://github.com/oven-sh/bun/pull/12345",
  "https://github.com/oven-sh/bun/issues/9876",
  "https://github.com/oven-sh/bun/releases/tag/bun-v1.1.20",

  // Docs URLs with long slugs.
  "https://nodejs.org/docs/latest/api/child_process.html",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort",
  "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch",
  "https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html",
  "https://bun.sh/docs/runtime/env",
  "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html",
  "https://example.com/docs/concepts/very-long-page-title-with-many-words-explaining-the-concept",

  // Stack Overflow question URLs.
  "https://stackoverflow.com/questions/1732348/regex-match-open-tags-except-xhtml-self-contained-tags",
  "https://stackoverflow.com/questions/201323/how-many-spaces-for-tab-character-eslint",
  "https://stackoverflow.com/questions/tagged/bun",
  "https://stackoverflow.com/a/1732454",

  // YouTube — 11-character video ids.
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLexample",

  // S3 public object URLs WITHOUT a presigned signature.
  "https://my-public-bucket.s3.amazonaws.com/assets/logo.png",
  "https://my-public-bucket.s3.us-east-1.amazonaws.com/reports/2026-q3-summary.pdf",
  "https://s3.amazonaws.com/public-assets/images/banner-2026.jpg",
  "https://cdn.example.com/static/js/main.a1b2c3d4.js",

  // arXiv.
  "https://arxiv.org/abs/2103.00020",
  "https://arxiv.org/pdf/2103.00020.pdf",

  // Wikipedia with percent-encoded Cyrillic titles.
  "https://ru.wikipedia.org/wiki/%D0%9A%D0%BE%D1%88%D0%BA%D0%B0", // Кошка (cat)
  "https://ru.wikipedia.org/wiki/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0", // Москва (Moscow)
  "https://en.wikipedia.org/wiki/Special:Random",
  "https://en.wikipedia.org/wiki/Byzantine_fault",

  // REG-F1 (flow 355 review round 2): Medium's and GitHub Gist's common
  // `<slug>-<hex-id>` URL convention — a public post/gist id, not a secret.
  // The Medium URL is the EXACT one already linked from this repo's own
  // docs/requirements/keryx-wiki-graph-next/README.md.
  "https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9",
  "https://gist.github.com/someuser/keryx-audit-remediation-notes-3a9bae9ec8f9",

  // REG-F2 (flow 355 review round 3): a Gist's REAL, common shape — a bare
  // 32-hex id, not a word slug with a hex tail — plus a plain GitHub commit
  // URL, both from the reviewer's own repro.
  "https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890",
  "https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
];

// DOCUMENTED DECISION (not a bug): a Google Docs/Drive file id is
// CAPABILITY-LIKE — whoever holds the id can open the file, the same shape of
// risk as a presigned S3 URL's signature (round 1's own documented decision).
// Refusing it outbound, and redacting it in tool output, is the same
// deliberate, documented asymmetry: fetching a Drive link is out of scope for
// `web_fetch`; the SAME id printed in a tool's OUTPUT (e.g. a `gh` or `gdrive`
// CLI listing) is correctly redacted.
const CAPABILITY_ID_URLS: string[] = [
  "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
  "https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/view",
];

describe("ordinary outbound fixture (flow 355 review round 2): 60+ realistic urls/queries", () => {
  test("the fixture has at least 60 entries", () => {
    expect(ORDINARY_URLS.length).toBeGreaterThanOrEqual(60);
  });

  test("none of them is refused outbound", () => {
    const refused = ORDINARY_URLS.filter((url) => containsOutboundSecret(url));
    if (refused.length > 0) {
      console.log("unexpectedly refused:", refused);
    }
    expect(refused).toEqual([]);
  });

  // KNOWN, OUT-OF-SCOPE, PRE-EXISTING ISSUE (found incidentally, not fixed
  // here): `detect/pii.ts`'s `pii.phone` pattern matches an arXiv id's
  // `YYMM.NNNNN` shape (`2103.00020`) as a phone number — nothing to do with
  // entropy or the outbound check (`detectEntropy` returns `[]` for this
  // URL; `containsOutboundSecret` correctly does not refuse it, per the test
  // above). Excluded from the redaction assertion and reported separately
  // rather than silently patched in an unrelated detector this flow does not
  // own.
  // REG-F2 (flow 355 review round 3): the Gist's bare-hex32-id shape is an
  // OUTBOUND-only exemption (`outbound-secret.ts`'s host+path allowlist) by
  // design — `entropy.ts`'s redaction path (S-6/S-9) is deliberately
  // unchanged, and an UNLABELLED 32-hex path segment is still caught there
  // via the unconditional hex-blob branch (it is not a git-SHA/UUID/integrity
  // allow-shape, so nothing exempts it there). This is the documented
  // asymmetry stated in `outbound-secret.ts`'s own REG-F2 comment: a value
  // already fetched costs nothing to identify later in tool output, while
  // refusing an ordinary outbound fetch is a pure loss.
  const REDACTION_EXCEPTIONS = new Set([
    "https://arxiv.org/abs/2103.00020",
    "https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890",
  ]);

  test("none of them is redacted in tool output (arXiv id / pii.phone excepted — see comment)", () => {
    const redacted = ORDINARY_URLS.filter(
      (url) => !REDACTION_EXCEPTIONS.has(url) && redactSensitiveText(url) !== url,
    );
    if (redacted.length > 0) {
      console.log("unexpectedly redacted:", redacted);
    }
    expect(redacted).toEqual([]);
  });

  test("DOCUMENTED — a Google Docs/Drive capability id IS refused outbound and IS redacted", () => {
    for (const url of CAPABILITY_ID_URLS) {
      expect(containsOutboundSecret(url)).toBe(true);
      expect(redactSensitiveText(url)).not.toBe(url);
    }
  });
});

describe("crafted-secret recall (flow 355 review rounds 1 and 2): still caught after both fixes", () => {
  const CRAFTED_SECRET_URLS: string[] = [
    "https://x.example/c?k=sk-AAAAAAAAAAAAAAAAAAAAAAAA",
    "https://x.example/c?d=K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI",
    "https://x.example/c?t%6fken=K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI",
    "https://x.example/c#K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI",
    "https://x.example/webhooks/K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI",
    "https://my-bucket.s3.amazonaws.com/r.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
    // SEC-F1 (flow 355 review round 2): a real secret re-segmented into
    // single-character-class chunks joined by '-' used to defeat `isWordSlug`'s
    // shape check entirely.
    "https://exfil.example/aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8",
  ];

  test("every round-1/round-2 crafted secret URL is still refused outbound", () => {
    const missed = CRAFTED_SECRET_URLS.filter((url) => !containsOutboundSecret(url));
    if (missed.length > 0) {
      console.log("recall miss:", missed);
    }
    expect(missed).toEqual([]);
  });
});
