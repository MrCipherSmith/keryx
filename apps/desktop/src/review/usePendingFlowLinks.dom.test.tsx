import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { SessionInfo } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let usePendingFlowLinks: typeof import("./usePendingFlowLinks").usePendingFlowLinks;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ usePendingFlowLinks } = await import("./usePendingFlowLinks"));
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
  let api: Api | undefined;
  function Probe({ flows, loaded, sessions }: { flows: FlowCard[]; loaded: boolean; sessions: SessionInfo[] }) {
    api = usePendingFlowLinks(flows, loaded, sessions, (id, dir) => links.push(`${id} ${dir}`));
    return null;
  }
  const render = (flows: FlowCard[], loaded = true, sessions: SessionInfo[] = []) =>
    act(async () => { root.render(createElement(Probe, { flows, loaded, sessions })); });
  return { links, render, api: () => api! };
}

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
