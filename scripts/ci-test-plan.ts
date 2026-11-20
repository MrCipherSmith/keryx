// File inventory for a clean CI checkout. The serial AC8 run checks this
// inventory against Bun's actual discovery on main.
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TEST_FILE = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;
export const CORE_SHARDS = 4;

export function coreTestFilters(script: string): string[] {
  const [bun, test, ...filters] = script.trim().split(/\s+/u);
  if (bun !== "bun" || test !== "test" || filters.length === 0 ||
    filters.some((filter) => !/^[\w./-]+$/u.test(filter) || filter.startsWith("-"))) {
    throw new Error("test:core must declare plain Bun path filters.");
  }
  return filters;
}

export function testFilesForPart(
  files: string[],
  filters: string[],
  ignoredPaths: string[],
  part: string,
): string[] {
  const ignored = ignoredPaths.map((pattern) => new Bun.Glob(pattern));
  const tests = files.filter((file) => {
    const directories = file.split("/").slice(0, -1);
    return TEST_FILE.test(file) &&
      !directories.some((dir) => dir.startsWith(".") || dir === "node_modules") &&
      !ignored.some((pattern) => pattern.match(file));
  }).sort();

  if (part === "all") return tests;
  const matchesCore = (file: string) => filters.some((filter) => file.includes(filter));
  if (part === "remaining") return tests.filter((file) => !matchesCore(file));
  if (!/^[1-4]$/u.test(part)) throw new Error(`Unknown CI test partition: ${part}`);
  return tests.filter(matchesCore).filter((_, index) => index % CORE_SHARDS === Number(part) - 1);
}

function readInventory(part: string): string[] {
  const config = Bun.TOML.parse(readFileSync(path.join(ROOT, "bunfig.toml"), "utf8")) as {
    test: { pathIgnorePatterns: string[]; root?: string };
  };
  if (config.test.root !== undefined && config.test.root !== ".") {
    throw new Error("The CI test inventory expects Bun to discover from the repository root.");
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const listed = Bun.spawnSync([
    "git", "ls-files", "-z", "--", ":(glob)**/*[._]test.*", ":(glob)**/*[._]spec.*",
  ], { cwd: ROOT });
  if (listed.exitCode !== 0) throw new Error(`Could not list test files: ${listed.stderr.toString()}`);
  const files = listed.stdout.toString().split("\0").filter(Boolean);
  const selected = testFilesForPart(files, coreTestFilters(pkg.scripts["test:core"] ?? ""), config.test.pathIgnorePatterns, part);
  if (selected.length === 0 || selected.some((file) => file !== file.trim() || /[\r\n]/u.test(file))) {
    throw new Error(`CI test partition ${part} is empty or has an unsupported filename.`);
  }
  return selected;
}

export function verifyTestInventory(expected: string[], report: unknown, part: string): number {
  if (report === null || typeof report !== "object" || !("version" in report) || report.version !== 1 ||
    !("files" in report) || report.files === null || typeof report.files !== "object" || Array.isArray(report.files)) {
    throw new Error("Unexpected Bun timings format.");
  }
  const actual = new Set(Object.keys(report.files).map((file) => file.replace(/^\.\//u, "")));
  const planned = new Set(expected);
  const missing = expected.filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !planned.has(file));
  if (missing.length || extra.length) {
    throw new Error(`Bun test inventory differs for ${part}. Missing: ${missing.join(", ")}. Extra: ${extra.join(", ")}.`);
  }
  return actual.size;
}

if (import.meta.main) {
  const [part = "", timings] = process.argv.slice(2);
  const expected = readInventory(part);
  if (!timings) {
    console.log(expected.map((file) => `./${file}`).join("\n"));
  } else {
    const report: unknown = JSON.parse(readFileSync(timings, "utf8"));
    const verified = verifyTestInventory(expected, report, part);
    console.log(`Verified ${verified} test files for ${part}.`);
  }
}
