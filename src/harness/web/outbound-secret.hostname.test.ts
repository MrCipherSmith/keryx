import { expect, test } from "bun:test";
import { containsOutboundSecret } from "./outbound-secret";

// review-degradation-w4:F-001: ordinary long platform hosts must not be refused.
test("realistic long platform hosts are not secret-shaped", () => {
  for (const url of [
    "https://my-project-k3j9x2a1b-myteam.vercel.app/",
    "https://my-project-git-feature-add-login-flow-myteam.vercel.app/docs",
    "https://my-really-long-project-name-git-fix-headers-acme-corp-team.vercel.app/",
    "https://deploy-preview-42--site.netlify.app/",
    "https://64f1c2e0a7b3d9001c2e8f10--my-awesome-marketing-site.netlify.app/",
    "https://a1b2c3d4.my-docs-site-for-the-team.pages.dev/",
    "https://3f9c2a1b.my-long-cloudflare-pages-project.pages.dev/",
    "https://my-application-staging-1a2b3c4d5e6f.herokuapp.com/",
    "https://my-internal-service-name-production-x7k2.onrender.com/",
    "https://my-fly-application-name-staging-instance.fly.dev/",
    "https://some-organisation-name.github.io/some-repository-name/",
    "https://my-company-production-assets-bucket-eu-west-1.s3.eu-west-1.amazonaws.com/img/a.png",
    "https://d111111abcdef8.cloudfront.net/index.html",
  ]) {
    expect(containsOutboundSecret(url)).toBe(false);
  }
});

test("real secret-shaped host labels are still refused", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  expect(containsOutboundSecret(`https://${secret}.attacker.example/`)).toBe(true);
  expect(containsOutboundSecret("https://sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.evil.example/")).toBe(true);
  expect(containsOutboundSecret("https://ghp_abcdefghijklmnopqrstuvwxyz0123456789.evil.example/")).toBe(true);
  expect(containsOutboundSecret("https://AbCdEf0123456789xYzQwErTyUiOpAsDfGhJkLz.evil.example/")).toBe(true);
});

// review-security-code-w3:F-001: the host is read from the same parse the request uses.
test("a URL the WHATWG parser reads differently from a regex cannot hide the host", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  for (const url of [
    `ht\ttps://${secret}.attacker.example/`,
    `https://${secret}.attacker.example\\@x/`,
    `https://${secret}.attacker.example\n/`,
    `  https://${secret}.attacker.example/`,
    `https://${secret}.attacker.example\t/x`,
  ]) {
    expect(containsOutboundSecret(url)).toBe(true);
  }
});

// review-regression-w2:F-001: 20-31 char mixed-case labels fell between the old 20 and new 32 thresholds.
test("random mixed-case host labels of 20-31 characters are refused", () => {
  for (const url of [
    "https://aB3dE5gH7jK9mN2pQ4sT6vX8.attacker.example/", // 24
    "https://Zq8Lm2Xv9Rt4Wp7Kd3Nh6Bc1Fy5Gs0J.attacker.example/", // 32
    "https://Zq8Lm2Xv9Rt4Wp7Kd3Nh6Bc1Fy5Gs0.attacker.example/", // 31
    "https://k9Fq2LxV7mRt3WzP8nYb4Hc6.attacker.example/", // 24
    "https://Xp9Qr2Lm7Kt4Vn8Wz3Bc6Hd1.attacker.example/", // 24
    "https://my-site-aB3dE5gH7jK9mN2pQ4sT6vX8.attacker.example/", // glued after a word
  ]) {
    expect(containsOutboundSecret(url)).toBe(true);
  }
});

test("lowercase hex deploy ids and word slugs of 20-31 characters still pass", () => {
  for (const url of [
    "https://64f1c2e0a7b3d9001c2e8f10--my-awesome-marketing-site.netlify.app/",
    "https://my-project-k3j9x2a1b-myteam.vercel.app/",
    "https://internationalisation-documentation.example.com/",
  ]) {
    expect(containsOutboundSecret(url)).toBe(false);
  }
});
