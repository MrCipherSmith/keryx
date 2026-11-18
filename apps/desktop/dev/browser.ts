// `bun run dev:browser`: the dev bridge (ws://127.0.0.1:1421) and Vite
// (http://localhost:1420) together; stopping this stops both.

const children = [
  Bun.spawn(["bun", "run", `${import.meta.dir}/bridge.ts`], { stdout: "inherit", stderr: "inherit", env: process.env }),
  Bun.spawn([`${import.meta.dir}/../node_modules/.bin/vite`], { cwd: `${import.meta.dir}/..`, stdout: "inherit", stderr: "inherit", env: process.env }),
];

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// If either one dies, take the other down too.
await Promise.race(children.map((c) => c.exited));
stop();
