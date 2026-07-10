// Test-only helper. Bun runs test files concurrently in a single process, so an
// unguarded `process.chdir` in one test races with another test that reads
// `process.cwd()` across an await point (F-601). Route every cwd-dependent test
// section through this mutex: it serializes the chdir critical sections and
// always restores the previous cwd, so no two tests ever hold a different cwd at
// the same time.
let chain: Promise<unknown> = Promise.resolve();

export function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(previous);
    }
  });
  // Keep the chain alive regardless of this section's outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

let heldRelease: (() => void) | null = null;

// beforeEach/afterEach variant: acquire the shared cwd mutex, chdir into `dir`,
// and hold it (blocking other cwd sections across all test files) until
// releaseCwd() is called from afterEach. Restores the previous cwd on release.
export async function acquireCwd(dir: string): Promise<void> {
  const previous = chain;
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  chain = held;
  await previous;
  const cwdBefore = process.cwd();
  process.chdir(dir);
  heldRelease = () => {
    process.chdir(cwdBefore);
    unlock();
  };
}

export function releaseCwd(): void {
  const release = heldRelease;
  heldRelease = null;
  release?.();
}
