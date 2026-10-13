"""Flow411 kernel PTY smoke; Python3 + Bun + built OpenTUI required. No live APIs.
Run: python3 scripts/smoke-flow411.py. Captures retained under a printed temp root.
"""
import fcntl, json, os, pathlib, pty, select, shutil, signal, struct, tempfile, termios, time
REPO = pathlib.Path(__file__).resolve().parents[1]
ROOT = pathlib.Path(tempfile.mkdtemp(prefix="keryx-flow411-pty-"))
BUN = shutil.which("bun")
assert BUN, "bun not found"

def run(scenario):
    root = ROOT / scenario
    (root / "home").mkdir(parents=True)
    (root / "cwd").mkdir()
    log = root / "events.jsonl"
    env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "XDG_DATA_HOME": str(root / "data"), "TERM": "xterm-256color", "FLOW411_SCENARIO": scenario, "FLOW411_LOG": str(log), "KERYX_ALLOW_REAL_SUBPROCESS": "1"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(root / "cwd")
        os.execve(BUN, [BUN, "--use-system-ca", "--dns-result-order=ipv4first", str(REPO / "fixtures/routing-shell-pty.ts")], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
    raw = bytearray()
    status = None
    def pump(seconds=0.1):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([fd], [], [], min(0.05, max(0, until-time.monotonic())))[0]:
                try: raw.extend(os.read(fd, 65536))
                except OSError: break
    def events():
        return [json.loads(s) for s in log.read_text().splitlines()] if log.exists() else []
    def wait(pred, label, seconds=15):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            pump()
            if pred(): return
        raise AssertionError("timeout: " + label)
    def send(text): os.write(fd, text.encode())
    def has(event): return any(e["event"] == event for e in events())
    try:
        wait(lambda: b"Ready" in raw, "real renderer ready", 30)
        assert next(e["detail"] for e in events() if e["event"] == "tty") == {"stdin": True, "stdout": True}
        assert b"\x1b[?1049h" in raw, "no alternate screen: not a real TUI"
        def switch_model(down, target):
            previous = len([e for e in events() if e["event"] == "prepare"])
            send("/model\r")
            pump(0.8)
            if down:
                send("\x1b[B")
                pump(0.2)
            send("\r")
            wait(lambda: len([e for e in events() if e["event"] == "prepare"]) > previous and
                 [e for e in events() if e["event"] == "prepare"][-1]["detail"]["model"] == target, "baseline " + target)
            pump(0.4)
        def request(text, target):
            count = len([e for e in events() if e["event"] == "dispatch"])
            send(text + "\r")
            wait(lambda: len([e for e in events() if e["event"] == "dispatch"]) > count, "dispatch " + target)
            pump(0.8)
            assert [e for e in events() if e["event"] == "dispatch"][-1]["detail"]["selected"] == target
        if scenario == "success":
            # Two categories before/after TWO real picker switches, plus latest baseline off.
            for phase in range(3):
                request("please review this PR", "executor")
                request("hi", "quick-executor")
                if phase < 2: switch_model(phase == 0, "base-b" if phase == 0 else "base-a")
            classified = len([e for e in events() if e["event"] == "classify-start"])
            send("/route off\r")
            pump(0.6)
            request("please review this PR", "base-a")
            assert len([e for e in events() if e["event"] == "classify-start"]) == classified
            assert b"pty-test/executor" in raw and b"pty-test/quick-executor" in raw
        elif scenario in ["jev-success", "jev-fallback"]:
            switch_model(True, "base-b")
            request("implement a retry loop", "executor")
            assert has("jev-start")
            calls = [e["detail"] for e in events() if e["event"] == "fallback-classifier"]
            assert calls == ([{"providerId": "anthropic", "modelId": "claude-sonnet-5"}] if scenario == "jev-fallback" else [])
            assert b"main-model" in raw if scenario == "jev-fallback" else b"jev" in raw
        else:
            switch_model(True, "base-b")
            send(("an ambiguous operator request" if scenario == "jev-cancel" else "please review this PR") + "\r")
            wait(lambda: has("jev-start") if scenario == "jev-cancel" else any(e["event"] == "prepare" and e["detail"]["model"] == "executor" for e in events()), "cancellation window")
            send("/interrupt\r")
            wait(lambda: b"main turn interrupted" in raw, "interrupt acknowledged")
            wait(lambda: has("jev-late") if scenario == "jev-cancel" else has("prepare-late"), "late settlement")
            pump(1)
            assert not has("dispatch"), "executor dispatched after cancellation"
            assert b"last: review" not in raw, "cancelled route counted as successful"
            assert b"[review ->" not in raw, "cancelled route advertised"
            assert b"route fallback:" not in raw, "cancelled turn advertised fallback"
            if scenario == "jev-cancel":
                assert has("jev-abort"), "JEV transport was not aborted"
                assert next(e["detail"] for e in events() if e["event"] == "classify-end")["aborted"]
        send("/exit\r")
        until = time.monotonic() + 8
        while time.monotonic() < until:
            pump()
            found, child_status = os.waitpid(pid, os.WNOHANG)
            if found:
                status = child_status
                break
        else: raise AssertionError("shell did not exit")
        assert os.waitstatus_to_exitcode(status) == 0, f"child exit {status}"
        assert next(e["detail"] for e in events() if e["event"] == "config-preserved")["same"]
        assert b"\x1b[?1049l" in raw, "terminal not restored"
        print("PASS", scenario, "events=" + str(len(events())), flush=True)
    finally:
        (root / "pty.raw").write_bytes(raw)
        if status is None:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            os.waitpid(pid, 0)
        os.close(fd)

print("Evidence:", ROOT, flush=True)
for scenario in ["success", "jev-success", "jev-fallback", "prep-cancel", "prep-fail-cancel", "jev-cancel"]:
    run(scenario)
