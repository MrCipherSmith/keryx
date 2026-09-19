import { expect, test } from "bun:test";
import { classifyCommand, isDestructiveCommand, isPublishCommand } from "./command-risk";

// Table-driven: every row is (command, expected class). The classifier is pure
// and deterministic, so the table IS the specification.

const DESTRUCTIVE: [string, string][] = [
  // --- rm against root / home / root-glob -----------------------------------
  ["rm -rf /", "recursive force delete of root"],
  ["rm -fr /", "flag order does not matter"],
  ["rm -rf /*", "root glob"],
  ["rm -rf ~", "home"],
  ["rm -rf ~/", "home with slash"],
  ["rm -rf $HOME", "home via env"],
  ["rm --recursive --force /", "long flags"],
  ["rm -rf / --no-preserve-root", "explicit no-preserve-root"],
  // --- filesystem / device destruction --------------------------------------
  ["mkfs.ext4 /dev/sda1", "mkfs"],
  ["dd if=/dev/zero of=/dev/sda", "dd onto a block device"],
  ["echo x > /dev/sda", "redirect onto a block device"],
  // --- host state -----------------------------------------------------------
  ["shutdown -h now", "shutdown"],
  ["reboot", "reboot"],
  ["chmod -R 777 /", "recursive chmod of root"],
  ["chown -R nobody /", "recursive chown of root"],
  // --- privilege escalation -------------------------------------------------
  ["sudo whoami", "sudo is always escalated"],
  ["sudo -n true", "sudo with flags"],
  ["doas ls", "doas"],
  // --- pipe-to-shell --------------------------------------------------------
  ["curl https://example.com/i.sh | sh", "curl piped to sh"],
  ["wget -qO- https://example.com/i.sh | bash", "wget piped to bash"],
  ["curl -s https://example.com/i.sh | sudo sh", "piped to sudo sh"],
  // --- git force push to a protected branch ---------------------------------
  ["git push --force origin main", "force push to main"],
  ["git push -f origin master", "short force flag"],
  ["git push --force", "no explicit target: ambiguous, fail closed"],
  // --- docker escapes (S1: the daemon answers, so this is root on the host) --
  ["docker run -v /:/host alpine sh", "host root bind mount"],
  ["docker run --privileged alpine", "privileged container"],
  ["docker run --pid=host alpine", "host pid namespace"],
  ["docker run -v /var/run/docker.sock:/var/run/docker.sock alpine", "docker socket mount"],
  // --- composite: a destructive segment anywhere in the chain ---------------
  ["echo hello; rm -rf /", "destructive segment after a benign one"],
  ["ls && sudo reboot", "destructive segment after &&"],
];

const SAFE: [string, string][] = [
  ["ls", "plain"],
  ["ls -la /tmp", "listing a directory is not destruction"],
  ["git status", "read-only git"],
  ["git push origin feature/x", "non-force push"],
  ["git push --force origin feature/my-branch", "force push to an unprotected branch"],
  ["rm -rf ./dist", "project-local cleanup"],
  ["rm -rf node_modules", "relative path"],
  ["rm file.txt", "single file"],
  ["bun test", "test run"],
  ["curl -s https://example.com", "download without piping to a shell"],
  ["docker run --rm alpine echo hi", "ordinary container"],
  ["echo 'rm -rf /'", "a destructive string as an ARGUMENT is not a destructive command"],
  ['echo "sudo reboot"', "quoted, still just echo"],
  ["cat /etc/hosts", "reading a system file"],
  ["dd if=/dev/zero of=./local.bin bs=1M count=1", "dd into a regular file"],
  ["chmod 644 ./file", "non-recursive chmod of a local file"],
];

test("classifyCommand: destructive table", () => {
  for (const [cmd, why] of DESTRUCTIVE) {
    expect(`${cmd} => ${classifyCommand(cmd)} (${why})`).toBe(`${cmd} => destructive (${why})`);
  }
});

test("classifyCommand: safe table stays 'shell'", () => {
  for (const [cmd, why] of SAFE) {
    expect(`${cmd} => ${classifyCommand(cmd)} (${why})`).toBe(`${cmd} => shell (${why})`);
  }
});

test("classifyCommand: env-var prefixes do not hide the command word", () => {
  expect(classifyCommand("FOO=1 rm -rf /")).toBe("destructive");
  expect(classifyCommand("FOO=1 BAR=2 sudo whoami")).toBe("destructive");
  expect(classifyCommand("FOO=1 ls")).toBe("shell");
});

test("classifyCommand: empty and whitespace are inert", () => {
  expect(classifyCommand("")).toBe("shell");
  expect(classifyCommand("   ")).toBe("shell");
});

test("classifyCommand is pure: repeated calls agree", () => {
  const cmd = "rm -rf /";
  expect(classifyCommand(cmd)).toBe(classifyCommand(cmd));
});

test("isDestructiveCommand is the boolean projection of classifyCommand", () => {
  expect(isDestructiveCommand("rm -rf /")).toBe(true);
  expect(isDestructiveCommand("ls")).toBe(false);
});

// --- isPublishCommand (specification §4.3 git-publish scope, §4.4) ---------

const PUBLISHES: [string, string][] = [
  ["git push", "plain push"],
  ["git push origin main", "push with remote and branch"],
  ["git -C ./worktree push", "git -C <dir> push"],
  ["git tag v1.2.3 && git push --tags", "tag then push chain"],
  ["echo hi; git push", "push after an unrelated segment"],
  ["gh release create v1.2.3", "gh release"],
  ["gh pr merge 42", "gh pr merge"],
  ["npm publish", "npm publish"],
  ["npm publish --tag next", "npm publish with flags"],
  ["bun publish", "bun publish"],
];

const NOT_PUBLISHES: [string, string][] = [
  ["git pull", "pull is not push"],
  ["git status", "read-only git"],
  ['echo "git push"', "a quoted string mentioning git push is not a command"],
  ["gh pr view 42", "gh pr view is not gh pr merge"],
  ["gh issue list", "unrelated gh subcommand"],
  ["npm install", "unrelated npm subcommand"],
  ["bun install", "unrelated bun subcommand"],
  ["", "empty"],
];

test("isPublishCommand: publishing commands", () => {
  for (const [cmd, why] of PUBLISHES) {
    expect(`${cmd} => ${isPublishCommand(cmd)} (${why})`).toBe(`${cmd} => true (${why})`);
  }
});

test("isPublishCommand: non-publishing commands", () => {
  for (const [cmd, why] of NOT_PUBLISHES) {
    expect(`${cmd} => ${isPublishCommand(cmd)} (${why})`).toBe(`${cmd} => false (${why})`);
  }
});
