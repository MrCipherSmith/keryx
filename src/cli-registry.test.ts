import { expect, test } from "bun:test";

for (const args of [["routing", "--help"], ["help", "routing"]]) {
  test(`${args.join(" ")} prints unified routing help`, () => {
    const result = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const text = result.stdout.toString();
    for (const command of ["Usage: keryx routing <subcommand>", "routing classes list", "routing settings set", "routing explain --request", "routing migrate", "--include-activated-user", "routing pilot", "routing stats"]) {
      expect(text).toContain(command);
    }
    expect(text).not.toContain("route-v2");
    expect(text).not.toContain("--rollback");
  });
}

