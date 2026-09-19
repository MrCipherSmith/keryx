import { describe, expect, test } from "bun:test";
import { detectStall, parseEpollFdinfo, ttyReaderArmed, type WatchSample } from "./debug-watcher";

// Real fdinfo captured from two keryx 0.2.121 shells on the same machine: one
// healthy, one whose input had stopped (session 603f3171). fd 11/12/13 are the
// process's /dev/pts handles; 13 is the non-blocking reader.
const HEALTHY = `pos:\t0
flags:\t02
mnt_id:\t16
ino:\t1057
tfd:        7 events:       19 data:                7  pos:0 ino:1057 sdev:f
tfd:        6 events: 80000019 data:                6  pos:0 ino:1057 sdev:f
tfd:       13 events: 40000019 data:               13  pos:0 ino:5 sdev:1a
tfd:       11 events: 40000000 data:               11  pos:0 ino:5 sdev:1a
tfd:       12 events: 40000000 data:               12  pos:0 ino:5 sdev:1a
`;
const HUNG = `pos:\t0
flags:\t02
tfd:       29 events: 40000019 data:               29  pos:0 ino:1057 sdev:f
tfd:        6 events: 80000019 data:                6  pos:0 ino:1057 sdev:f
tfd:       11 events: 40000000 data:               11  pos:0 ino:5 sdev:1a
tfd:       12 events: 40000000 data:               12  pos:0 ino:5 sdev:1a
`;

describe("parseEpollFdinfo", () => {
  test("reads every tfd line with its hex event mask", () => {
    expect(parseEpollFdinfo(HEALTHY)).toEqual([
      { tfd: 7, events: 0x19 },
      { tfd: 6, events: 0x80000019 },
      { tfd: 13, events: 0x40000019 },
      { tfd: 11, events: 0x40000000 },
      { tfd: 12, events: 0x40000000 },
    ]);
  });
});

describe("ttyReaderArmed", () => {
  const ttyFds = [0, 1, 2, 11, 12, 13];
  test("healthy shell: the tty reader is polled for input", () => {
    expect(ttyReaderArmed(ttyFds, parseEpollFdinfo(HEALTHY))).toBe(true);
  });
  test("hung shell: tty fds registered only disarmed (oneshot, no EPOLLIN) → not armed", () => {
    expect(ttyReaderArmed(ttyFds, parseEpollFdinfo(HUNG))).toBe(false);
  });
  test("no terminal fds → no verdict", () => {
    expect(ttyReaderArmed([], parseEpollFdinfo(HEALTHY))).toBeUndefined();
  });
});

describe("detectStall", () => {
  const ok: WatchSample = { alive: true, readerArmed: true, pending: 0, heartbeatAgeMs: 300 };
  test("needs the condition on three consecutive samples", () => {
    const dead: WatchSample = { ...ok, readerArmed: false };
    expect(detectStall([ok, dead, dead])).toBeUndefined();
    expect(detectStall([dead, dead, dead])).toBe("reader-not-polled");
  });
  test("unread input that never drains", () => {
    const s = (pending: number): WatchSample => ({ ...ok, pending });
    expect(detectStall([s(3), s(40), s(4095)])).toBe("input-not-drained");
    expect(detectStall([s(3), s(40), s(0)])).toBeUndefined();
    // Draining (decreasing) is a working reader catching up, not a stall.
    expect(detectStall([s(400), s(40), s(3)])).toBeUndefined();
  });
  test("a silent event loop", () => {
    const quiet: WatchSample = { ...ok, heartbeatAgeMs: 9000 };
    expect(detectStall([quiet, quiet, quiet])).toBe("event-loop-silent");
  });
  test("a dead target is not a stall", () => {
    const gone: WatchSample = { alive: false, readerArmed: false };
    expect(detectStall([gone, gone, gone])).toBeUndefined();
  });
});
