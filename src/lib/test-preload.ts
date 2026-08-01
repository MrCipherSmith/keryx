// Test preload: no test run touches the developer's real user-global config.
//
// `keryx init` registers the project it initializes in the user-global project
// registry (flow 127), which `keryxConfigDir` resolves from `XDG_DATA_HOME` on
// Unix and `APPDATA` on Windows. Most tests that drive `initCommand` never
// redirect either, so the registration landed in `~/.local/share/keryx`.
//
// Measured, not theorised: a review of PR #216 found 1006 entries in the real
// registry on this machine, every one a `/tmp/…` fixture path from a past
// `bun test`, and the count grew by one on each further run. The same exposure
// covers `auth.json` — a test that saved an API key would write it into the
// developer's real credential file, at 0600, indistinguishable from a real one.
//
// This is fixed HERE rather than per test file for one reason: the reach is not
// visible in a test's own source. `modules.test.ts` never mentions `init`, but
// `keryx modules enable` calls `initCommand`, so it registered a project too.
// Any guard that scans test sources for a call misses that path; redirecting the
// resolver before any test module loads does not.
//
// A test that wants its own isolated directory still sets `XDG_DATA_HOME`
// itself and overrides this. A test that deliberately exercises the
// un-redirected resolver deletes the variable, which `config-dir.test.ts` does.
//
// Wired through `bunfig.toml` `[test].preload`.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "keryx-test-config-"));
process.env.XDG_DATA_HOME = root;
process.env.APPDATA = root;
// Published through the ENVIRONMENT, not as a module export, and that is
// load-bearing. The guard in `test-preload.test.ts` originally imported this
// module to read the root — which executed it, set the variables, and passed
// whether or not `bunfig.toml` still wired the preload. Removing the wiring was
// mutation-checked and produced no failure at all: a guard that could not fail.
// An env var is only present if something actually ran this file first.
process.env.KERYX_TEST_CONFIG_ROOT = root;

// Sweep the roots left by earlier runs.
//
// Without this every `bun test` left a directory behind — 23 had accumulated on
// the machine a review measured. The obvious fix, an `exit` handler, does not
// work: `bun test` fires neither `exit` nor `beforeExit`, verified directly
// before writing this. So the cleanup runs at START and removes roots older
// than an hour, which is far longer than any suite and therefore cannot touch a
// concurrent run's directory.
//
// What that bounds, stated accurately: accumulation per HOUR, not to a single
// leftover. A comment here claimed the latter and a review counted 16 live
// roots to disprove it. Ten runs in ten minutes still leave ten directories
// until the next run an hour later sweeps them.
const STALE_MS = 60 * 60 * 1_000;
try {
  const now = Date.now();
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("keryx-test-config-")) {
      continue;
    }
    const candidate = path.join(tmpdir(), entry.name);
    if (candidate === root) {
      continue;
    }
    try {
      if (now - statSync(candidate).mtimeMs > STALE_MS) {
        rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Someone else's, already gone, or not ours to remove.
    }
  }
} catch {
  // An unreadable tmpdir is not worth failing a test run over.
}
