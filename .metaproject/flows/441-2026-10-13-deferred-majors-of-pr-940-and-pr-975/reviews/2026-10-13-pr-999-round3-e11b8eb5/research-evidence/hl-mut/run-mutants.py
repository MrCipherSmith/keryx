import os, shutil, subprocess, re
here = os.path.dirname(os.path.abspath(__file__))
src = "/home/altsay/keryx-fdm-t3/src/tui/main-queue.ts"
test = "/home/altsay/keryx-fdm-t3/src/tui/main-queue-drain.test.ts"
base = open(src).read()
muts = {
  "base": (None, None),
  "A_queue_captured_once": ("  let detached = 0;", "  const captured = deps.queue(); deps = { ...deps, queue: () => captured }; let detached = 0;"),
  "B_finally_instead_of_then": ("work.then(end, end);", "void work.finally(end);"),
  "C_workInFlight_ignores_detached": ("deps.workInFlight() || detached > 0", "deps.workInFlight()"),
  "D_no_onSettle_in_drain": ('if (outcome === "empty") deps.onSettle();', ""),
  "E_end_drains_unconditionally": ("        drainWhenIdle();\n      };", "        drain();\n      };"),
  "F_turnSettle_ignores_handoff": ("    onTurnSettle() {\n      if (deps.forced.isAwaitingSettlement) return;", "    onTurnSettle() {"),
  "G_isBusy_ignores_detached": ("isBusy: workInFlight,", "isBusy: deps.workInFlight,"),
}
for name, (old, new) in muts.items():
    d = os.path.join(here, "m-" + name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    s = base
    if old is not None:
        assert old in s, name
        s = s.replace(old, new, 1)
    open(os.path.join(d, "main-queue.ts"), "w").write(s)
    shutil.copy(test, os.path.join(d, "main-queue-drain.test.ts"))
    out = subprocess.run(["bun", "test", "main-queue-drain.test.ts"], cwd=d, capture_output=True, text=True)
    txt = out.stdout + out.stderr
    pf = re.findall(r"^\s*(\d+) (pass|fail)", txt, re.M)
    unh = len(re.findall(r"nhandled", txt))
    print(f"{name}: {pf} unhandled-mentions={unh} exit={out.returncode}")
