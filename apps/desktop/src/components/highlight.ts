// Syntax highlighting for fenced code: highlight.js core with the languages agents actually write.
// Its output escapes the source and adds only `<span class="hljs-…">`, so it is set after sanitising.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, c, cpp, css, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, python, ruby, rust, scss, sql, swift, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

const ALIAS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellsession: "bash",
  py: "python", rs: "rust", rb: "ruby", kt: "kotlin", yml: "yaml",
  html: "xml", svg: "xml", plist: "xml", vue: "xml",
  md: "markdown", toml: "ini", jsonc: "json", json5: "json",
  "c++": "cpp", h: "c", hpp: "cpp", docker: "dockerfile", make: "makefile", golang: "go",
};

/** The registered language a fence's info string names, or null. */
export function highlightLanguage(lang: string): string | null {
  const l = lang.toLowerCase();
  const name = ALIAS[l] ?? l;
  return hljs.getLanguage(name) ? name : null;
}

/** File extension → fence language, for an embedded resource. */
export function languageForPath(path: string): string {
  const ext = /\.([\w+-]+)$/.exec(path.toLowerCase())?.[1] ?? "";
  if (/(^|\/)dockerfile$/i.test(path)) return "dockerfile";
  if (/(^|\/)makefile$/i.test(path)) return "makefile";
  return ext === "diff" || ext === "patch" ? "diff" : highlightLanguage(ext) !== null ? ext : "";
}

/** Highlighted HTML for `text`, or null when the language is not one this build knows. */
export function highlightToHtml(text: string, lang: string): string | null {
  const name = highlightLanguage(lang);
  if (name === null) return null;
  try {
    return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
