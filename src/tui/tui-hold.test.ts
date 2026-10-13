// Flow 275 (agent bus P4, T7; specification §4.3, §5.2, §7.2, AC4): the TUI's
// held-turns wiring — every entry point a `turns` pause lease must gate, the
// status-bar banner, the release-drains-the-queue path, and `/bus
// pause|resume|override`.
//
// `leaseView`/`held()`/`banner()` themselves are T5's (`../bus/pause.ts`,
// already covered by `pause.test.ts`), and the pure held→released edge
// detector is `createLeaseHoldController` (`./bus-wake.ts`, covered directly
// in `bus-wake.test.ts`). What is left here is proving `tui-shell.ts` actually
// wires those into every place specification §4.3's enforcement table lists —
// the OpenTUI REPL is not mountable under the unit harness (same limitation
// `tui-bus.test.ts`/`tui-shell.test.ts` document for the bus-wake/task-
// notification wiring), so this stays a source-text audit, same idiom.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(import.meta.dir, "tui-shell.ts"), "utf8");

describe("held turns: entry-point gates (specification §4.3, AC4)", () => {
  test("the idle-path operator line is gated right before appendUserEcho, and only an operator line is queued", () => {
    const echoIdx = source.indexOf("const userEcho = appendUserEcho(otui, r, transcript, {");
    expect(echoIdx).toBeGreaterThan(0);
    // The gate must appear textually BEFORE the echo/turn-start point, and
    // close enough that nothing else could start a turn in between.
    const gateIdx = source.lastIndexOf("leaseView()?.held() === true", echoIdx);
    expect(gateIdx).toBeGreaterThan(0);
    const between = source.slice(gateIdx, echoIdx);
    // Only origin "operator" pushes to the queue; every other origin (a
    // defensive no-op for task-notification/bus-message) just returns.
    expect(between).toContain('if (origin === "operator")');
    // Flow 376: a Telegram line keeps its `tg` label through the hold queue.
    // (`enqueue` repaints; the position it returns goes into the notice.)
    expect(between).toContain("const position = turnLoop.enqueue(line, displayLine, source);");
    expect(between).toContain("queued as q${position}.\\n");
    expect(between).toContain("return;");
    // And it must return BEFORE the echo ever runs — i.e. this whole gate
    // sits ahead of `appendUserEcho`, not the other way around.
    expect(source.indexOf(between)).toBeLessThan(echoIdx);
  });

  test("the busy-branch side-worker dispatch is gated before the Main-queue/Side-1 composer choice, with no choice offered while held", () => {
    const choiceIdx = source.indexOf('title: "Main agent is busy"');
    expect(choiceIdx).toBeGreaterThan(0);
    const pendingEditIdx = source.indexOf("if (remoteQueue.requeuePendingEdit(line, displayLine))");
    expect(pendingEditIdx).toBeGreaterThan(0);
    expect(pendingEditIdx).toBeLessThan(choiceIdx);
    const block = source.slice(pendingEditIdx, choiceIdx);
    expect(block).toContain("leaseView()?.held() === true");
    expect(block).toContain("const position = turnLoop.enqueue(line, displayLine, source);");
    expect(block).toContain("queued as q${position} (no side worker while held).\\n");
    // The held branch must return BEFORE the composer-choice IIFE below it.
    const heldIdx = block.indexOf("leaseView()?.held() === true");
    expect(block.indexOf("return;", heldIdx)).toBeGreaterThan(heldIdx);
  });

  test("forceMainQueue (used by /queue force, the queue-nav Enter shortcut, and the queue-dock force button) refuses while held", () => {
    const start = source.indexOf("const forceMainQueue = (index: number): void => {");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("\n    };", start);
    const body = source.slice(start, end);
    expect(body).toContain("leaseView()?.held() === true");
    expect(body).toContain("stays queued until the lease is released");
    // The held check must come before the item is actually removed from the
    // queue and handed to `forceForegroundQueueItem` — else it would already
    // be gone by the time the guard ran.
    const heldIdx = body.indexOf("leaseView()?.held() === true");
    const removeIdx = body.indexOf("removeMainQueueItem(turnLoop.queue, index)");
    expect(heldIdx).toBeGreaterThan(0);
    expect(removeIdx).toBeGreaterThan(heldIdx);
  });

  test("the task-notification wake's idle test includes \"not held\", alongside busy and the queue", () => {
    const idx = source.indexOf("const idle = !busy && turnLoop.queue.length === 0 && leaseView()?.held() !== true;");
    expect(idx).toBeGreaterThan(0);
  });
});

describe("held turns: banner (specification §4.3, AC4)", () => {
  test("a dedicated sidebar row exists beside the mode row and is painted from leaseView().banner()", () => {
    const modeIdx = source.indexOf('id: "sb-mode-v"');
    expect(modeIdx).toBeGreaterThan(0);
    const holdIdx = source.indexOf('id: "sb-hold-v"', modeIdx);
    expect(holdIdx).toBeGreaterThan(modeIdx);
    const paintIdx = source.indexOf("const paintHoldBanner = (): void => {", holdIdx);
    expect(paintIdx).toBeGreaterThan(holdIdx);
    const body = source.slice(paintIdx, source.indexOf("};", paintIdx));
    expect(body).toContain("leaseView()?.banner()");
    // Empty (nothing painted) when not held — the banner must disappear on release.
    expect(body).toContain('banner === undefined ? "" :');
  });

  // Flow 277 (P2): `onPeers`'s body (which used to be inline here) moved to
  // `buildBusJoinCallbacks` (`./bus-join.ts`) — this exact ordering
  // (paintHoldBanner, then the lease-hold controller's own poll check, before
  // the bus-wake decision; specification §5.2 step 5) is now proven directly
  // against the real function in `bus-join.test.ts` ("onPeers: paints the
  // fleet BEFORE reporting delivery to the wake controller..."), which
  // exercises `onLeaseHoldPoll`/`paintHoldBanner` in that same call-order
  // assertion. `tui-shell.ts` only wires `paintHoldBanner`/
  // `leaseHoldController?.onPoll()` as deps now; there is no inline body left
  // for a text audit to anchor on.

  test("the banner repaints immediately after a local /bus pause|resume|override, not just on the next poll", () => {
    for (const marker of ['if (parsed.kind === "pause") {', 'if (parsed.kind === "resume") {', 'if (parsed.kind === "override") {']) {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      const block = source.slice(start, start + 700);
      expect(block).toContain("paintHoldBanner();");
      expect(block).toContain("leaseHoldController?.onPoll();");
    }
  });
});

describe("held turns: release drains the queue (specification §5.2 step 5, AC4)", () => {
  test("leaseHoldController is built from leaseView().held() and drains through the shared sites on release (behaviour: main-queue-drain.test.ts)", () => {
    const start = source.indexOf("leaseHoldController = createLeaseHoldController({");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("\n    });", start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toContain("isHeld: () => leaseView()?.held() === true");
    expect(block).toContain("onRelease: () => drainSites.onLeaseRelease()");
  });

  // Flow 441 (AC1): the shell builds `createTurnLoop` from the real objects. The inputs
  // turn-loop.test.ts cannot reach (it models them) are pinned here, whitespace-normalised and
  // comment-free, so a reformat is not a failure and a commented-out field is not a pass.
  test("the shell builds the turn loop with every real input in place (behaviour: turn-loop.test.ts)", () => {
    const flat = (text: string): string => text.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
    const loop = source.indexOf("const turnLoop = createTurnLoop({");
    expect(loop).toBeGreaterThan(0);
    const loopEnd = source.indexOf("\n    });", loop);
    expect(loopEnd).toBeGreaterThan(loop);
    const loopBody = flat(source.slice(loop, loopEnd));
    for (const field of [
      "forced: forceHandoff,",
      "paint: () => paintMainQueue(),",
      "turnWorkInFlight: () => chrome.isBusy() || foregroundOperation.isActive || forceHandoff.isAwaitingSettlement,",
      "onSettle: () => busWakeController?.onSettle(),",
      // The reply path to the topic, the label of a queued line, the composer, the transcript line,
      // the Telegram source on a drained line and the report of a failed detached command.
      "getBridge: () => remoteBridge,",
      "summarize: summarizeSubmittedLine,",
      "setText: (text) => { input.value = text; },",
      "focus: () => input.focus(),",
      "say: (text) => io.onSystem?.(text),",
      "runLine: (line, origin, source) => runLine(line, origin, source),",
      "onDetachedFailure: (error) => { const reason = error instanceof Error ? error.message : String(error); io.onSystem?.(`◇ a slash command failed: ${terminalSafe(reason).text}\\n`); },",
    ]) {
      expect(loopBody).toContain(field);
    }
    expect(source).toContain("const drainSites = turnLoop.drain;");
    // The one turn-loop.ts internal worth a source pin: a getter, because the loop replaces its queue
    // array, so a reference taken once drains a dead queue (F-016). Every other field of the drain is
    // killed by a behaviour test in turn-loop.test.ts.
    const moduleSource = readFileSync(path.join(import.meta.dir, "turn-loop.ts"), "utf8");
    const factory = moduleSource.indexOf("const drain = createMainQueueDrain({");
    expect(factory).toBeGreaterThan(0);
    const factoryEnd = moduleSource.indexOf("\n  });", factory);
    expect(factoryEnd).toBeGreaterThan(factory);
    const body = flat(moduleSource.slice(factory, factoryEnd));
    expect(body).toContain("queue: () => queue,");
    expect(body).not.toContain("queue: queue,");
  });

  test("the sidebar's session state reads the live queue length from the turn loop", () => {
    expect(source).toContain("sessionState: () => ({ queued: turnLoop.queue.length, mode: formatModeInForce(modeForTurn(true)) }),");
  });

  test("the bus wake is idle only when the shared in-flight predicate is clear (flow 441 F-019)", () => {
    const start = source.indexOf("busWakeController = createBusWakeController({");
    expect(start).toBeGreaterThan(0);
    const isIdle = source.slice(start, source.indexOf("inbox: busInbox,", start));
    expect(isIdle).toContain("!drainSites.workInFlight() &&");
    expect(isIdle).toContain("turnLoop.queue.length === 0 &&");
    expect(isIdle).toContain("leaseView()?.held() !== true");
  });

  test("every slash command whose work outlives its handler is held in the queue (flow 441 F-001)", () => {
    const detaching = ["/schedule", "/goal", "/search-provider", "/search-connect", "/model", "/connect"];
    for (const name of detaching) {
      const at = source.indexOf(`if (command.name === "${name}"`);
      expect(at).toBeGreaterThan(0);
      expect(source.slice(at, at + 400)).toContain("detachSlashWork(");
    }
    expect(source.match(/detachSlashWork\(/g)?.length).toBe(detaching.length);
    // the counter and the end-of-work drain live in the factory (behaviour: main-queue-drain.test.ts)
    expect(source).toContain("const detachSlashWork = (work: Promise<unknown>): void => drainSites.detach(work);");
    expect(source).not.toContain("detachedSlashWork");
  });

  test("a finished foreground operation drains the queue (flow 441)", () => {
    expect(source.match(/drainSites\.onForegroundOperationComplete\(\);/g)?.length).toBe(1);
  });
});

describe("/bus pause|resume|override (specification §4.3, §7.2)", () => {
  test("pause creates a lease through client.pause with origin operator", () => {
    const start = source.indexOf('if (parsed.kind === "pause") {');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 500);
    expect(block).toContain('.pause(parsed.toLabel, parsed.scope, parsed.reason, parsed.ttlMs, "operator")');
  });

  test("resume defaults to this instance's own lease (myLeases()[0]) and ends it through client.resume with origin operator", () => {
    const start = source.indexOf('if (parsed.kind === "resume") {');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 700);
    expect(block).toContain("client.leaseView().myLeases()[0]?.leaseId");
    expect(block).toContain('.resume(leaseId, "operator")');
    expect(block).toContain("no active lease held by this instance");
  });

  test("override defaults to the lease holding this instance (heldBy()) and releases it through client.override", () => {
    const start = source.indexOf('if (parsed.kind === "override") {');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 700);
    expect(block).toContain("client.leaseView().heldBy()?.leaseId");
    expect(block).toContain(".override(leaseId)");
    expect(block).toContain("no lease is currently held against this instance");
  });

  test("showBus passes selfInstanceId so the Leases tab can mark which leases apply to this instance", () => {
    const start = source.indexOf("const showBus = (): void => {");
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, source.indexOf("const runBusCommand", start));
    expect(block).toContain("selfInstanceId: client.instanceId,");
  });
});

describe("busLeases threaded into AgentDeps (flow 275 T6/T8 contract, specification §4.4)", () => {
  test("busLeasesFromClient adapts BusClient.leaseView() to {appliesToMe, heldBy}, mirroring commands/shell.ts's own adapter", () => {
    const start = source.indexOf("const busLeasesFromClient = (bus: BusClient)");
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 550);
    expect(block).toContain("appliesToMe: (scope) => bus.leaseView().appliesToMe(scope)");
    // Flow 275 F2: scope-aware — reads the SAME scope just passed to
    // `appliesToMe`, never the `turns`-only `heldBy()` accessor, so a
    // `git-publish` floor never gets back an unrelated `turns` lease.
    expect(block).toContain("heldBy: (scope) => {");
    expect(block).toContain("bus.leaseView().appliesToMeLease(scope)");
    expect(block).toContain("{ name: lease.holder.name, reason: lease.reason }");
  });

  test("both makeAgentDeps fold-in sites (join-success, /model /connect rebuild) attach busLeases", () => {
    const assignIdx = source.indexOf("liveBus = joined;");
    expect(assignIdx).toBeGreaterThan(0);
    // End-anchored on the rebuild's own close (`liveDeps = deps;`), not a byte
    // count — see the same change in tui-bus.test.ts.
    const joinEnd = source.indexOf("liveDeps = deps;", assignIdx);
    expect(joinEnd).toBeGreaterThan(assignIdx);
    const joinBlock = source.slice(assignIdx, joinEnd);
    expect(joinBlock).toContain("busLeases: busLeasesFromClient(joined),");

    const switchIdx = source.indexOf("const switchTo = async (ns: TuiSelection): Promise<void> => {");
    expect(switchIdx).toBeGreaterThan(0);
    const switchBlock = source.slice(switchIdx, switchIdx + 1100);
    expect(switchBlock).toContain("deps.busLeases !== undefined ? { busLeases: deps.busLeases } : {}");
  });

  test("the side-worker deps rebuild still passes no bus getter at all (review r1 F9 must not regress)", () => {
    const baseIdx = source.indexOf("const base = await opts.makeAgentDeps(");
    expect(baseIdx).toBeGreaterThan(0);
    const block = source.slice(baseIdx, baseIdx + 200);
    expect(block).toContain("opts.makeAgentDeps(currentSel, liveSlateSession, undefined)");
  });
});
