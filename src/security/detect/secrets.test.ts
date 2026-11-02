import { describe, expect, test } from "bun:test";
import { detectSecrets } from "./secrets";

function spans(content: string, policyId: string): string[] {
  return detectSecrets(content)
    .filter((match) => match.policyId === policyId)
    .map((match) => content.slice(match.start, match.end));
}

function timed(content: string): number {
  const started = performance.now();
  detectSecrets(content);
  return performance.now() - started;
}

const BODY = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\nVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\n";

describe("secrets.private-key-block", () => {
  test("masks a PGP armored private key block", () => {
    const block = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF${BODY}=abcd\n-----END PGP PRIVATE KEY BLOCK-----`;
    expect(spans(`gpg output:\n${block}\ndone`, "secrets.private-key-block")).toEqual([block]);
  });

  test("masks an ENCRYPTED PKCS#8 private key", () => {
    const block = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${BODY}-----END ENCRYPTED PRIVATE KEY-----`;
    expect(spans(block, "secrets.private-key-block")).toEqual([block]);
  });

  test("still masks the RSA, EC, OPENSSH and bare PKCS#8 forms", () => {
    for (const kind of ["RSA ", "EC ", "OPENSSH ", ""]) {
      const block = `-----BEGIN ${kind}PRIVATE KEY-----\n${BODY}-----END ${kind}PRIVATE KEY-----`;
      expect(spans(`x ${block} y`, "secrets.private-key-block")).toEqual([block]);
    }
  });

  test("masks two blocks separately and leaves the text between them", () => {
    const one = `-----BEGIN RSA PRIVATE KEY-----\n${BODY}-----END RSA PRIVATE KEY-----`;
    const two = `-----BEGIN EC PRIVATE KEY-----\n${BODY}-----END EC PRIVATE KEY-----`;
    expect(spans(`${one}\nbetween\n${two}`, "secrets.private-key-block")).toEqual([one, two]);
  });

  test("an unterminated header (head -20 id_rsa) fails closed to the end of the input", () => {
    const truncated = `-----BEGIN RSA PRIVATE KEY-----\n${BODY}${BODY}`;
    expect(spans(`$ head -20 ~/.ssh/id_rsa\n${truncated}`, "secrets.private-key-block")).toEqual([truncated]);
  });

  test("public keys and certificates are not private keys", () => {
    const pub = `-----BEGIN PUBLIC KEY-----\n${BODY}-----END PUBLIC KEY-----`;
    const cert = `-----BEGIN CERTIFICATE-----\n${BODY}-----END CERTIFICATE-----`;
    const pgpPub = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${BODY}-----END PGP PUBLIC KEY BLOCK-----`;
    const sshPub = `-----BEGIN OPENSSH PUBLIC KEY-----\n${BODY}-----END OPENSSH PUBLIC KEY-----`;
    expect(spans(`${pub}\n${cert}\n${pgpPub}\n${sshPub}`, "secrets.private-key-block")).toEqual([]);
  });

  test("many unclosed headers scan in linear time", () => {
    const content = "-----BEGIN PRIVATE KEY-----".repeat(8000);
    expect(timed(content)).toBeLessThan(250);
    expect(spans(content, "secrets.private-key-block")).toEqual([content]);
  });

  test("an unclosed header followed by 100k characters scans in linear time", () => {
    const content = `-----BEGIN RSA PRIVATE KEY-----\n${"a".repeat(100_000)}`;
    expect(timed(content)).toBeLessThan(250);
  });
});

describe("secrets.url-credentials", () => {
  test("still masks scheme://user:pass@host, including a long or glued scheme", () => {
    expect(spans("see postgres://admin:hunter22@db.internal:5432/app", "secrets.url-credentials")).toEqual([
      "postgres://admin:hunter22@db.internal:5432",
    ]);
    const long = `${"x".repeat(40)}https://u:secretpw@host`;
    expect(spans(long, "secrets.url-credentials").join("")).toContain("u:secretpw@host");
  });

  test("a URL without credentials is not a match", () => {
    expect(spans("https://example.com/a:b@c and mailto:x@y", "secrets.url-credentials")).toEqual([]);
  });

  for (const [name, content] of [
    ["50k letters", "a".repeat(50_000)],
    ["a dotted run", "a.".repeat(50_000)],
    ["a plus-joined run", "a+".repeat(50_000)],
    ["a hyphenated slug run", "foo-bar-baz-".repeat(8_000)],
  ] as const) {
    test(`scans ${name} with no :// in linear time`, () => {
      expect(timed(content)).toBeLessThan(250);
    });
  }
});

describe("assignment rules with quoted values", () => {
  test("a double-quoted passphrase with spaces is masked whole", () => {
    expect(spans('DB_PASSWORD="pass phrase"', "secrets.env-assignment")).toEqual(["pass phrase"]);
    expect(spans('DB_PASSWORD="correct horse battery staple"\n', "secrets.env-assignment")).toEqual([
      "correct horse battery staple",
    ]);
  });

  test("a single-quoted value containing # and spaces is masked whole", () => {
    expect(spans("API_KEY='a#b c d e'", "secrets.env-assignment")).toEqual(["a#b c d e"]);
    expect(spans('API_KEY="ab#9f2kLq0Zx"', "secrets.env-assignment")).toEqual(["ab#9f2kLq0Zx"]);
  });

  test("the JSON form with a quoted name and a quoted value with spaces", () => {
    expect(spans('{"ZAI_API_KEY": "two words here"}', "secrets.env-assignment")).toEqual(["two words here"]);
  });

  test("the lowercase credential-file rule takes quoted values whole too", () => {
    expect(spans('client_secret = "my client secret"', "secrets.credential-file-assignment")).toEqual([
      "my client secret",
    ]);
  });

  test("an unquoted value keeps its trailing comment", () => {
    expect(spans("API_KEY=abcdef123 # rotate monthly", "secrets.env-assignment")).toEqual(["abcdef123"]);
    expect(spans("API_KEY=abcdef123#comment", "secrets.env-assignment")).toEqual(["abcdef123"]);
  });

  test("an unclosed opening quote still masks the unquoted run", () => {
    expect(spans('PASSWORD="abcdefgh', "secrets.env-assignment")).toEqual(["abcdefgh"]);
  });

  test("a short value stays below the floor, quoted or not", () => {
    expect(spans('PASSWORD="abc"', "secrets.env-assignment")).toEqual([]);
    expect(spans("PASSWORD=abc", "secrets.env-assignment")).toEqual([]);
  });

  test("a value equal to its own name is located at the value, not the name", () => {
    const content = "PASSWORD=PASSWORD";
    const [match] = detectSecrets(content).filter((m) => m.policyId === "secrets.env-assignment");
    expect(match?.start).toBe("PASSWORD=".length);
  });
});

describe("secrets.github-token", () => {
  test("masks a fine-grained github_pat_ token", () => {
    const token = `github_pat_11ABCDEFG0${"x".repeat(72)}`;
    expect(spans(`token: ${token}`, "secrets.github-token")).toEqual([token]);
  });

  test("a short github_pat_ mention is not a token", () => {
    expect(spans("set github_pat_XXXX in the env", "secrets.github-token")).toEqual([]);
  });
});
