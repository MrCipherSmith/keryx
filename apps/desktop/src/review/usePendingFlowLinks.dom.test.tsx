import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { SessionInfo } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let usePendingFlowLinks: typeof import("./usePendingFlowLinks").usePendingFlowLinks;
let FLOW_LINK_WINDOW_MS: number;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ usePendingFlowLinks } = await import("./usePendingFlowLinks"));
  ({ FLOW_LINK_WINDOW_MS } = await import("./prWork"));
  root = (await import("react-dom/client")).createRoot(document.body.appendChild(document.createElement("div")));
});
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

const flow = (dir: string): FlowCard => ({
  id: dir.slice(0, 3), dir, idValid: true, commandRef: null, title: dir, status: "initializing", previousStatus: null, blocked: false,
  owner: null, prUrl: null, baseBranch: null, tasksDone: 0, tasksTotal: 0, acTotal: 0, acConfirmed: 0, updatedAt: null,
  completionExceptions: false, error: null,
});

type Api = ReturnType<typeof usePendingFlowLinks>;
function harness() {
  const links: string[] = [];
  const apis: Api[] = [];
  const clock = { now: 0 };
  function Probe({ flows, loaded, sessions }: { flows: FlowCard[]; loaded: boolean; sessions: SessionInfo[] }) {
    apis.push(usePendingFlowLinks(flows, loaded, sessions, (id, dir) => links.push(`${id} ${dir}`), () => clock.now));
    return null;
  }
  const render = (flows: FlowCard[], loaded = true, sessions: SessionInfo[] = []) =>
    act(async () => { root.render(createElement(Probe, { flows, loaded, sessions })); });
  return { links, clock, apis, render, api: () => apis.at(-1)! };
}
// Each test starts from a fresh hook: the previous test's Probe is unmounted first.
beforeEach(async () => { await act(async () => root.render(null)); });

test("the first new flow package after Create Flow is linked to the session, once", async () => {
  const h = harness();
  await h.render([flow("100-old")]);
  const known = h.api().known();
  await act(async () => h.api().expect("s1", known));
  await h.render([flow("100-old")]);
  expect(h.links).toEqual([]);
  await h.render([flow("100-old"), flow("101-new")]);
  expect(h.links).toEqual(["s1 101-new"]);
  await h.render([flow("100-old"), flow("101-new"), flow("102-later")]);
  expect(h.links).toEqual(["s1 101-new"]);
});

test("several new packages link none, and nothing is linked before the first flow list or to a session with a Flow", async () => {
  const h = harness();
  await h.render([flow("100-old")]);
  await act(async () => h.api().expect("s1", h.api().known()));
  await h.render([flow("100-old"), flow("101-a"), flow("102-b")]);
  await h.render([flow("100-old"), flow("101-a"), flow("102-b"), flow("103-c")]);
  expect(h.links).toEqual([]);

  await h.render([], false);
  await act(async () => h.api().expect("s2", h.api().known()));
  await h.render([flow("100-old")]);
  expect(h.links).toEqual([]);

  await h.render([flow("100-old")]);
  await act(async () => h.api().expect("s3", h.api().known()));
  const linked: SessionInfo = { sessionId: "s3", cwd: "/p", _meta: { keryx: { flow: "099-earlier" } } };
  await h.render([flow("100-old"), flow("104-d")], true, [linked]);
  expect(h.links).toEqual([]);
});

test("two pending Create Flow requests and one new package: none is linked, and a later package is not linked either", async () => {
  const h = harness();
  await h.render([flow("100-old")]);
  await act(async () => h.api().expect("s1", h.api().known()));
  await act(async () => h.api().expect("s2", h.api().known()));
  await h.render([flow("100-old"), flow("101-new")]);
  expect(h.links).toEqual([]);
  await h.render([flow("100-old"), flow("101-new"), flow("102-later")]);
  expect(h.links).toEqual([]);
});

test("a request expires: a package from elsewhere after its window is not linked", async () => {
  const h = harness();
  await h.render([flow("100-old")]);
  await act(async () => h.api().expect("s1", h.api().known()));
  h.clock.now = FLOW_LINK_WINDOW_MS + 1;
  await h.render([flow("100-old"), flow("101-foreign")]);
  expect(h.links).toEqual([]);
});

test("a package linked to one request is not linked to a request recorded before it appeared", async () => {
  const h = harness();
  await h.render([flow("100-old")]);
  await act(async () => h.api().expect("s1", h.api().known()));
  // s2 took its known packages before s1's package appeared, and records the request after it was linked.
  const before = h.api().known();
  await h.render([flow("100-old"), flow("101-s1")]);
  expect(h.links).toEqual(["s1 101-s1"]);
  await act(async () => h.api().expect("s2", before));
  await h.render([flow("100-old"), flow("101-s1")]);
  expect(h.links).toEqual(["s1 101-s1"]);
});

test("the hook's api keeps its identity across renders, so callbacks built on it can be memoised", async () => {
  const h = harness();
  await h.render([flow("100-old")]);
  await h.render([flow("100-old"), flow("101-new")]);
  await h.render([flow("100-old"), flow("101-new")], true, []);
  expect(new Set(h.apis).size).toBe(1);
});
