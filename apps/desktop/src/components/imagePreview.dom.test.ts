import { afterAll, beforeAll, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "../test/dom";

let mod: typeof import("./imagePreview");
let md: typeof import("./Markdown");

beforeAll(async () => {
  registerDom();
  mod = await import("./imagePreview");
  md = await import("./Markdown");
});
afterAll(async () => {
  await unregisterDom();
});

test("only local image files count as local images", () => {
  for (const ok of [".keryx/browser/screenshots/tab-1.png", "/Users/me/p/a.JPG", "file:///tmp/x.webp", "shots/a%20b.jpeg"]) {
    expect(mod.isLocalImageLink(ok)).toBe(true);
  }
  for (const no of ["https://e.com/a.png", "//e.com/a.png", "javascript:alert(1)//a.png", "notes.txt", "/etc/passwd", "data:image/png;base64,xx"]) {
    expect(mod.isLocalImageLink(no)).toBe(false);
  }
});

// DOMPurify does not strip URIs under happy-dom (it did not before this change either), so only what a
// test can see here is checked: local image links survive and an image becomes a link, not an <img>.
test("a message keeps a local image link and renders ![](…) as a link", () => {
  const html = md.renderMarkdown("[shot](.keryx/browser/screenshots/a.png) ![page](/tmp/b.png) [web](https://e.com)");
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const hrefs = Array.from(doc.querySelectorAll("a")).map((a) => a.getAttribute("href"));
  expect(hrefs).toEqual([".keryx/browser/screenshots/a.png", "/tmp/b.png", "https://e.com"]);
  expect(doc.querySelector("a[href='/tmp/b.png']")!.textContent).toBe("page");
  expect(doc.querySelector("img")).toBeNull();
});

test("the sanitizer's link pattern allows local images and refuses other local or scripted links", () => {
  const re =
    /^(?:https?:|mailto:|#|file:\/\/\/[^?#]*\.(?:png|jpe?g|webp|gif)$|\/(?!\/)[^?#]*\.(?:png|jpe?g|webp|gif)$|(?![a-z][a-z0-9+.-]*:)[^/?#][^?#]*\.(?:png|jpe?g|webp|gif)$)/i;
  for (const ok of [".keryx/browser/screenshots/a.png", "/tmp/b.png", "file:///tmp/c.webp", "https://e.com", "mailto:a@b.c", "#x"]) expect(re.test(ok)).toBe(true);
  for (const no of ["javascript:alert(1)", "javascript:x//a.png", "/etc/passwd", "//e.com/a.png", "data:image/png;base64,x", "notes.txt"]) expect(re.test(no)).toBe(false);
});

test("thumbnails appear once per link, only when the host returns the image", async () => {
  const root = document.createElement("div");
  root.innerHTML = `<p><a href="shots/a.png">a</a> <a href="shots/missing.png">m</a> <a href="https://e.com/x.png">w</a></p>`;
  const asked: string[] = [];
  const load = async (href: string) => {
    asked.push(href);
    if (href.includes("missing")) throw new Error("not there");
    return "data:image/png;base64,AAAA";
  };
  mod.decorateImageLinks(root, load);
  mod.decorateImageLinks(root, load);
  await new Promise((r) => setTimeout(r, 0));
  const thumbs = root.querySelectorAll<HTMLButtonElement>(".md-thumb");
  expect(thumbs).toHaveLength(1);
  expect(thumbs[0]!.hidden).toBe(false);
  expect(thumbs[0]!.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(asked).toEqual(["shots/a.png", "shots/missing.png"]);
  expect(mod.clickedImageLink(thumbs[0]!.querySelector("img")!)).toBe("shots/a.png");
  expect(mod.clickedImageLink(root.querySelector("a")!)).toBe("shots/a.png");
  expect(mod.clickedImageLink(root.querySelectorAll("a")[2]!)).toBeNull();
});

test("the preview closes on Esc or a click", () => {
  const close = mod.openImagePreview("data:image/png;base64,AAAA", "shot");
  expect(document.querySelector(".img-preview img")!.getAttribute("alt")).toBe("shot");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".img-preview")).toBeNull();
  mod.openImagePreview("data:image/png;base64,AAAA", "x");
  (document.querySelector(".img-preview") as HTMLElement).click();
  expect(document.querySelector(".img-preview")).toBeNull();
  close();
});
