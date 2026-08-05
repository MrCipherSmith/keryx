#!/usr/bin/env python3
"""Benchmark driver: run one case, one variant, capture the evidence bundle.

Every agent runs in its own TUI inside tmux, so the screenshots are comparable
and each is a real capture of the interface a user would see.

  drive.py <variant> <case-id> <prompt-file> [--timeout N] [--keep]

Writes bench/<target>/<case>/<variant>/{prompt.txt,transcript.txt,diff.patch,
frames/*.ansi,screens/*.png,meta.json}
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

BENCH = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(BENCH, "base")
TARGET_REPO = "/home/altsay/bots/helyx"
COMMIT = "bfad745ba59b1fb99e7edd2bf515f7c3d2b4c1ae"
TARGET = "helyx"

# `deepseek-chat` is an alias the API still answers on but does not list; the
# declared ids are deepseek-v4-flash and deepseek-v4-pro. Pinning the listed id
# so every leg names a model that exists.
VARIANTS = {
    "keryx-deepseek": ["keryx", "shell", "--provider", "deepseek", "--model", "deepseek-v4-flash"],
    "keryx-gemma": ["keryx", "shell", "--provider", "ollama", "--model", "gemma4-coder:latest"],
    # The cleanest control in the whole benchmark: the SAME model as the keryx
    # leg, driven by a different agent with no workspace query layer. A
    # difference between these two cannot be attributed to model quality.
    "opencode-deepseek": ["opencode", "-m", "deepseek/deepseek-v4-flash"],
    "baseline-claude": ["claude"],
    "baseline-grok": ["grok"],
    # The clean control. Same agent, same commit, but the workspace and the
    # routing block are removed, because the first A1 run showed that both
    # baselines were SHELLING OUT to `keryx gdgraph affected` -- the project's
    # own CLAUDE.md tells every agent to. Without this leg the benchmark
    # compares keryx-as-a-shell against keryx-as-a-CLI, not against its absence.
    "naked-claude": ["claude"],
    "naked-grok": ["grok"],
}

# Variants that must not see the metaproject at all.
NAKED = {"naked-claude", "naked-grok"}
# Sentinels the routing block is wrapped in, plus the files that carry it.
ROUTING_FILES = ("CLAUDE.md", "AGENTS.md")

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def plain(s: str) -> str:
    return ANSI.sub("", s)


def strip_metaproject(wt: str) -> list[str]:
    """Remove the workspace and the routing that points at it.

    Returns what was removed, so the run record can state it rather than leave a
    reader to assume the control leg was identical to the baseline.
    """
    removed = []
    mp = os.path.join(wt, ".metaproject")
    if os.path.isdir(mp):
        shutil.rmtree(mp, ignore_errors=True)
        removed.append(".metaproject/")
    for name in ROUTING_FILES:
        path = os.path.join(wt, name)
        if not os.path.exists(path):
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        # The block is delimited by the `<!-- keryx:index -->` sentinel and runs
        # to the next top-level heading. Cutting to the sentinel alone would
        # leave the routing table behind.
        start = text.find("<!-- keryx:index -->")
        if start == -1:
            continue
        rest = text[start:]
        nxt = re.search(r"\n# (?!# )", rest[1:])
        end = start + 1 + nxt.start() if nxt else len(text)
        open(path, "w", encoding="utf-8").write(text[:start] + text[end:])
        removed.append(f"{name}:keryx-routing-block")
    return removed


def make_worktree(case: str, variant: str) -> str:
    wt = os.path.join(BENCH, "wt", f"{case}-{variant}")
    if os.path.exists(wt):
        sh(["git", "-C", TARGET_REPO, "worktree", "remove", "--force", wt])
        shutil.rmtree(wt, ignore_errors=True)
    os.makedirs(os.path.dirname(wt), exist_ok=True)
    r = sh(["git", "-C", TARGET_REPO, "worktree", "add", "--detach", wt, COMMIT])
    if r.returncode != 0:
        raise SystemExit(f"worktree add failed: {r.stderr}")
    # The prepared workspace: graph, health, testing, memory index. Only 9 files
    # under data/ are tracked, so a bare worktree would have no graph at all and
    # keryx would fail group A for a reason unrelated to the capability.
    src = os.path.join(BASE, ".metaproject", "data")
    dst = os.path.join(wt, ".metaproject", "data")
    if os.path.isdir(src):
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst)
    # Toolchain, so "run the tests" is answerable. Symlinked: 500MB per run
    # would be absurd, and no case mutates it.
    nm = os.path.join(BASE, "node_modules")
    if os.path.isdir(nm) and not os.path.exists(os.path.join(wt, "node_modules")):
        os.symlink(nm, os.path.join(wt, "node_modules"))
    if variant in NAKED:
        stripped = strip_metaproject(wt)
        open(os.path.join(wt, ".bench-stripped"), "w").write("\n".join(stripped))
    return wt


def run(variant: str, case: str, prompt: str, timeout: int, keep: bool) -> dict:
    out_dir = os.path.join(BENCH, "runs", TARGET, case, variant)
    os.makedirs(os.path.join(out_dir, "frames"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "screens"), exist_ok=True)
    open(os.path.join(out_dir, "prompt.txt"), "w").write(prompt)

    wt = make_worktree(case, variant)
    # Unique per process: two batches overlapping on one session name is how
    # the first A1 keryx leg died -- the second run's send-keys went to a
    # session the first was tearing down, so the prompt never landed.
    session = f"bench-{case}-{variant}-{os.getpid()}".replace(".", "-")
    sh(["tmux", "kill-session", "-t", session])

    cmd = VARIANTS[variant]
    started = time.time()
    sh(["tmux", "new-session", "-d", "-s", session, "-x", "150", "-y", "40",
        "-c", wt] + cmd)

    frames = []

    def snap(label: str) -> str:
        r = sh(["tmux", "capture-pane", "-t", session, "-p", "-e"])
        path = os.path.join(out_dir, "frames", f"{len(frames):03d}-{label}.ansi")
        open(path, "w").write(r.stdout)
        frames.append((label, path))
        return r.stdout

    time.sleep(10)         # let the TUI paint and finish its startup writes
    snap("start-empty")

    # Type the prompt and CONFIRM it landed before submitting. A TUI still
    # painting its banner swallows keystrokes, and an empty submit would be
    # recorded as "the agent did nothing" — a fabricated result. The probe is a
    # distinctive slice of the prompt, checked against the visible pane.
    # Whitespace-insensitive, because a composer WRAPS a long prompt and a
    # contiguous match then fails on a prompt that is plainly on screen. The
    # first A1 run died exactly there, and the guard was right to refuse rather
    # than record it.
    # Head OR tail: a single-line composer scrolls HORIZONTALLY once the text is
    # wider than the box, so for a long prompt only the tail is on screen and a
    # head-only probe fails on a prompt that is plainly there. That is what
    # killed A1 three times -- and worse, the retry then pressed C-u and wiped
    # the text that had actually landed.
    squash = lambda s: re.sub(r"\s+", "", s)
    flat = squash(plain(prompt))
    # The composer box is ONE visual row: before Enter it shows only the last
    # wrapped line, so for a 125-char prompt the pane holds just the final
    # word. Verified directly -- after Enter the full text appears, so the
    # buffer was complete all along and only the probe was wrong.
    head, tail = flat[:32], flat[-12:]
    for attempt in range(6):
        sh(["tmux", "send-keys", "-t", session, "-l", prompt])
        time.sleep(2.5)
        pane = squash(plain(sh(["tmux", "capture-pane", "-t", session, "-p"]).stdout))
        if head in pane or tail in pane:
            break
        # Clear whatever partially landed, then retry.
        sh(["tmux", "send-keys", "-t", session, "C-u"])
        time.sleep(1.5)
    else:
        snap("prompt-never-landed")
        raise SystemExit(
            f"prompt never appeared in the {variant} pane after 6 attempts — "
            "not recording a result for a prompt that was never submitted"
        )
    snap("start")
    sh(["tmux", "send-keys", "-t", session, "Enter"])

    stable_since = None
    last = ""
    tool_frames = 0
    deadline = started + timeout
    while time.time() < deadline:
        time.sleep(4)
        cur = sh(["tmux", "capture-pane", "-t", session, "-p", "-e"]).stdout
        if plain(cur) != plain(last):
            stable_since = None
            last = cur
            if tool_frames < 6:
                snap(f"step-{tool_frames}")
                tool_frames += 1
        else:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since > 12:
                break

    snap("final")
    finished = time.time()

    full = sh(["tmux", "capture-pane", "-t", session, "-p", "-e", "-S", "-2000"]).stdout
    open(os.path.join(out_dir, "transcript.txt"), "w").write(plain(full))
    open(os.path.join(out_dir, "transcript.ansi"), "w").write(full)

    sh(["tmux", "kill-session", "-t", session])

    diff = sh(["git", "-C", wt, "diff"]).stdout
    untracked = sh(["git", "-C", wt, "status", "--porcelain"]).stdout
    open(os.path.join(out_dir, "diff.patch"), "w").write(diff)
    open(os.path.join(out_dir, "status.txt"), "w").write(untracked)

    # Render the frames that matter into real images.
    shots = []
    for label, path in frames:
        if label in ("start", "final") or label.startswith("step-"):
            html = path.replace(".ansi", ".html")
            png = os.path.join(out_dir, "screens", os.path.basename(path).replace(".ansi", ".png"))
            sh(["python3", os.path.join(BENCH, "shot.py"), path, html,
                f"{variant} · {case} · {label}"])
            r = sh(["playwright", "screenshot", "--browser", "chromium",
                    "--viewport-size", "1400,860", "--full-page",
                    "--wait-for-timeout", "300", f"file://{html}", png])
            if os.path.exists(png):
                shots.append(png)

    meta = {
        "schemaVersion": 1,
        "catalogVersion": "0.1.0",
        "caseId": case,
        "target": TARGET,
        "variantId": variant,
        "commit": COMMIT[:12],
        "worktree": wt,
        "mode": "interactive",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "wallTimeSeconds": round(finished - started, 1),
        "prompt": prompt,
        "evidenceDir": out_dir,
        "screens": shots,
        "dirty": bool(untracked.strip()),
    }
    open(os.path.join(out_dir, "meta.json"), "w").write(json.dumps(meta, indent=2))

    if not keep:
        sh(["git", "-C", TARGET_REPO, "worktree", "remove", "--force", wt])
    print(json.dumps(meta, indent=2))
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("variant", choices=sorted(VARIANTS))
    ap.add_argument("case")
    ap.add_argument("prompt_file")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    prompt = open(a.prompt_file).read().strip()
    run(a.variant, a.case, prompt, a.timeout, a.keep)


if __name__ == "__main__":
    main()
