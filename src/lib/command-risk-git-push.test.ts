import { describe, expect, test } from "bun:test";
import { isDestructiveCommand } from "./command-risk";

// Block 1 round 2 (review-logic-w5:F-001, review-security-code-w4:F-001, review-regression-w4:F-002): every spelling
// below was run against real git 2.51 by the verifier and overwrote or deleted a protected remote branch.
const DESTRUCTIVE: Array<[string, string]> = [
  // matching refspecs
  ["git push origin +:", "forced matching push"],
  ["git push -f origin :", "matching push under --force"],
  ["git push --force origin :", "matching push under long --force"],
  // glob refspecs
  ["git push -f origin 'refs/heads/*:refs/heads/*'", "glob refspec under --force"],
  ["git push origin '+refs/heads/*:refs/heads/*'", "forced glob refspec"],
  ["git push origin '+refs/heads/*'", "forced glob without a destination"],
  ["git push --prune origin 'refs/heads/*:refs/heads/*'", "prune deletes every remote branch the glob reaches"],
  ["git push --prune origin", "prune with the configured refspec"],
  ["git push --all --prune origin", "prune of all branches"],
  // refspec or mirror from config
  ["git -c remote.origin.push=+HEAD:refs/heads/main push origin", "forced refspec from -c"],
  ["git -c remote.origin.push=+refs/heads/*:refs/heads/* push origin", "forced glob refspec from -c"],
  ["git -c remote.origin.mirror=true push origin", "mirror from -c"],
  ["git -c remote.origin.mirror push origin", "a -c key without a value is true"],
  ["git --config-env remote.origin.push=SPEC push origin", "refspec from --config-env, value unseen"],
  ["git -c alias.p='push --force' p origin main", "a -c alias that forces"],
  ["git -c alias.p='!git push -f origin main' p", "a -c shell alias that forces"],
  ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push origin", "config from the environment"],
  // value-taking options before the remote
  ["git push --force -o ci.skip origin", "-o value before the remote"],
  ["git push --force --push-option ci.skip origin", "--push-option value before the remote"],
  ["git push -fo ci.skip origin", "-o at the end of a cluster takes the next word"],
  ["git push --force --receive-pack git-receive-pack origin", "--receive-pack value"],
  ["git push --force --exec git-receive-pack origin", "--exec value"],
  ["git push --force --repo origin origin", "--repo value"],
  ["git push --force --recurse-submodules no origin", "--recurse-submodules value"],
  // abbreviations
  ["git push --del origin main", "--del is --delete"],
  ["git push --dele origin develop", "--dele is --delete"],
  ["git push --mirr origin", "--mirr is --mirror"],
  ["git push --mi origin", "--mi is --mirror"],
  ["git push --forc origin feature/x", "--forc is ambiguous: not classified, fail closed"],
  ["git push --force-w origin main", "--force-w is --force-with-lease"],
  ["git push --bra --force origin", "--bra is --branches (alias of --all)"],
  ["git push --frobnicate origin feature/x", "an option git does not list"],
  // options anywhere, words the shell still expands
  ["git push origin main --force", "options after the refspec"],
  ["git push origin $BRANCH -f", "a forced push to a branch the shell names"],
  ["git push origin $SPEC", "a refspec the shell names may be +main"],
  ["git $SUB -f origin main", "a subcommand the shell names"],
  ["git --no-pager push -f origin main", "a global flag before push"],
  ["git -C ../repo push -f origin main", "-C before push"],
  ["git --frob push -f origin feature/x", "an unknown global option before push"],
  // the config that arms a later plain push
  ["git config remote.origin.mirror true", "persistent mirror"],
  ["git config --add remote.origin.push '+refs/heads/*:refs/heads/*'", "persistent forced glob refspec"],
  ["git config set remote.origin.push +HEAD:main", "git config set"],
  ["git remote add --mirror=push backup ../remote.git", "a mirror remote"],
  ["git remote add --mirror backup ../remote.git", "a mirror remote, bare flag"],
];

const SAFE: Array<[string, string]> = [
  ["git push origin :", "unforced matching push is fast-forward only"],
  ["git push origin 'refs/heads/*:refs/heads/*'", "unforced glob push"],
  ["git push -o ci.skip origin feature/x", "-o value, unforced, unprotected"],
  ["git push --force -o ci.skip origin feature/x", "-o value, forced, unprotected branch"],
  ["git push --dry-run origin main", "--dry-run is not --delete"],
  ["git push --no-verify origin main", "negated option"],
  ["git push --set-upstream origin feature/x", "set-upstream"],
  ["git push -u origin HEAD", "plain push of HEAD"],
  ["git push --delete origin feature/x", "deleting an unprotected branch"],
  ["git push --prune origin 'refs/heads/feature/x:refs/heads/feature/x'", "prune with a plain refspec"],
  ["git -c remote.origin.push=HEAD:refs/heads/feature push origin", "an unforced refspec from -c"],
  ["git -c remote.origin.mirror=false push origin feature/x", "mirror switched off"],
  ["git -c user.name=x push origin feature/x", "an unrelated -c"],
  ["git -c alias.p=push p origin feature/x", "an alias of plain push"],
  ["git config remote.origin.push", "reading the refspec"],
  ["git config remote.origin.push HEAD:refs/heads/feature", "an unforced refspec"],
  ["git config remote.origin.mirror false", "mirror switched off"],
  ["git remote add --mirror=fetch backup ../remote.git", "a fetch mirror does not push"],
  ["git remote add backup ../remote.git", "a plain remote"],
  ["git log --oneline -n 5", "not a push"],
  ["git commit -m push", "push as a message word"],
];

describe("git push is parsed the way git parses it", () => {
  for (const [command, why] of DESTRUCTIVE) {
    test(`destructive: ${command} (${why})`, () => expect(isDestructiveCommand(command)).toBe(true));
  }
  for (const [command, why] of SAFE) {
    test(`not destructive: ${command} (${why})`, () => expect(isDestructiveCommand(command)).toBe(false));
  }
});

// Block 1 round 4 (review-security-code-w1:F-001, review-logic-w1:F-001): git runs its own command before it looks at an
// alias, so an `alias.<builtin>` is ignored and the builtin runs. The verifier's real-git probe overwrote or deleted main
// with the first two.
describe("an alias that shadows a git command is not expanded", () => {
  for (const command of [
    "git -c alias.push=status push --force origin main",
    "git -c alias.push=log push origin :main",
    "git -c alias.push=status push origin --delete main",
    "git -c alias.push=log push --delete origin main",
    "git -c alias.push='!true' push -f origin main",
    "git -c alias.push=status PUSH --force origin main",
    "git -c alias.config=status config remote.origin.push +refs/heads/*:refs/heads/*",
    "git -c alias.config=status config remote.origin.mirror true",
    "git -c alias.remote=status remote add --mirror=push backup ../remote.git",
  ]) {
    test(`destructive: ${command}`, () => expect(isDestructiveCommand(command)).toBe(true));
  }
  test("an alias of a name git does not own is still expanded", () => {
    expect(isDestructiveCommand("git -c alias.p=status p --force origin main")).toBe(false);
    expect(isDestructiveCommand("git -c alias.p='push --force' p origin main")).toBe(true);
    expect(isDestructiveCommand("git -c alias.st=push st origin feature/x")).toBe(false);
  });
});

// Block 1 round 4 (review-security-code-w1:F-002): config a `git push` reads from a source the line does not show. The
// verifier's real-git probe force-overwrote main with an include, HOME, XDG_CONFIG_HOME, --git-dir, a persistent alias
// and a persistent include.
describe("a push whose config comes from somewhere the classifier cannot read fails closed", () => {
  for (const command of [
    "git -c include.path=/tmp/x.cfg push origin",
    "git -c include.path=/tmp/x.cfg push origin feature/x",
    "git -c includeIf.gitdir:/.path=/tmp/x.cfg push origin",
    "git -c includeif.onbranch:main.path=/tmp/x.cfg push origin",
    "git --config-env include.path=CFG push origin",
    "git --git-dir=/tmp/g push origin",
    "git --git-dir /tmp/g push origin",
    "git --work-tree=/tmp/w push origin",
    "GIT_DIR=/tmp/g git push origin",
    "GIT_COMMON_DIR=/tmp/g git push origin",
    "HOME=/tmp/h git push origin",
    "XDG_CONFIG_HOME=/tmp/h git push origin",
    "GIT_CONFIG_GLOBAL=/tmp/x.cfg git push origin",
    "GIT_CONFIG_SYSTEM=/tmp/x.cfg git push origin",
    "env HOME=/tmp/h git push origin",
    "env -u GIT_CONFIG_GLOBAL HOME=/tmp/h git push origin",
    "HOME=/tmp/h; git push origin",
    "export XDG_CONFIG_HOME=/tmp/h && git push origin",
    "(HOME=/tmp/h; git push origin)",
    "env git push --force origin main",
    "nohup git push -f origin main",
  ]) {
    test(`destructive: ${command}`, () => expect(isDestructiveCommand(command)).toBe(true));
  }
  test("the same sources without a push, and a push without them, do not escalate", () => {
    for (const command of [
      "HOME=/tmp/h git status",
      "git --git-dir=/tmp/g log -n 1",
      "git -c include.path=/tmp/x.cfg log -n 1",
      "git commit -m 'HOME=/tmp/h' && git push origin feature/x",
      "git push origin feature/x",
      "env git push origin feature/x",
    ]) {
      expect(isDestructiveCommand(command), command).toBe(false);
    }
  });
});

describe("config writes that arm a later plain push are destructive (review-security-code-w1:F-002)", () => {
  for (const command of [
    "git config alias.x 'push -f origin main'",
    "git config --global alias.x 'push -f origin main'",
    "git config alias.x '!git push -f origin main'",
    "git config alias.x '!rm -rf /'",
    "git config set alias.x push",
    "git config include.path /tmp/x.cfg",
    "git config --global include.path /tmp/x.cfg",
    "git config --add includeIf.gitdir:~/.path /tmp/x.cfg",
    "git config alias.x \"$CMD\"",
  ]) {
    test(`destructive: ${command}`, () => expect(isDestructiveCommand(command)).toBe(true));
  }
  test("unrelated aliases and reads do not escalate", () => {
    for (const command of ["git config alias.st status", "git config alias.lg 'log --oneline --graph'", "git config --get alias.x", "git config include.path"]) {
      expect(isDestructiveCommand(command), command).toBe(false);
    }
  });
});
