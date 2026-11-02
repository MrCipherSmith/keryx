import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetClient } from "../src/api/client";
import type { HubContextValue } from "../src/app/hub-context";
import i18n from "../src/i18n";
import { RevisionsView, DeliveryView } from "../src/features/context";
import { useRevisionPages } from "../src/features/revisions-query";
import { renderHub } from "./hub-render";
const context:HubContextValue={projectId:"p",scopeKey:79,principal:{id:"human:test",kind:"human",role:"operator"},location:{projectId:"p",tab:"code",revisionId:"r0"},navigate:()=>undefined,refresh:async()=>undefined};
const revisions=Array.from({length:57},(_,index)=>({id:"r"+index,projectId:"p",baseRevisionId:null,gitBaseSha:"a".repeat(40),message:"Revision "+index,fileCount:0,createdBy:"human:test",createdAt:"2026-11-02T00:00:00Z",treeDigest:"digest",purpose:"snapshot"}));
let paths:string[];
beforeEach(async()=>{resetClient();await i18n.changeLanguage("en");paths=[];vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{const path=String(input);paths.push(path);if(path.includes("/revisions/")){const revision=revisions.find(row=>path.includes("/revisions/"+row.id+"?")||path.endsWith("/revisions/"+row.id));return Response.json(path.includes("summary=1")?revision:{...revision,files:[]});}if(path.includes("/revisions?"))return Response.json(path.includes("afterId=r7")?{revisions:revisions.slice(0,7).reverse()}:{revisions:revisions.slice(7).reverse(),nextCursor:"r7"});if(path.endsWith("/deliveries"))return Response.json({deliveries:[]});return Response.json({id:"p",name:"Project",lineRevisionId:"r0",lineVersion:1});});});
test("revision browser follows opaque continuation and opens an exact deep link outside the first fifty",async()=>{renderHub(<RevisionsView/>,context);expect(await screen.findByText("Revision 0")).toBeInTheDocument();fireEvent.click(await screen.findByRole("button",{name:"Load more revisions"}));await waitFor(()=>expect(paths.some(path=>path.includes("afterId=r7"))).toBe(true));expect((await screen.findByText("Revision 1",{selector:"span"})).closest("button")).toBeInTheDocument();expect(paths.some(path=>path.includes("/revisions/r0?summary=1"))).toBe(true);});
test("delivery resolves its selected immutable line exactly instead of assuming first-page membership",async()=>{renderHub(<DeliveryView/>,context);expect(await screen.findByRole("textbox",{name:"Remote URL"})).toBeInTheDocument();expect(paths.some(path=>path.includes("/revisions/r0?summary=1"))).toBe(true);expect(paths.filter(path=>path.includes("/revisions?"))).toHaveLength(0);});

test("a listed revision loads its detail without a redundant exact-summary request", async () => {
  renderHub(<RevisionsView />, { ...context, location: { ...context.location, revisionId: "r56" } });
  await waitFor(() => expect(paths).toContain("/hub/v1/projects/p/revisions/r56"));
  expect(paths.filter(path => path.includes("/revisions/r56?summary=1"))).toEqual([]);
});

test("an exact revision lookup failure remains visible when list and project reads succeed", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes("/revisions/r0?summary=1")
    ? Response.json({ error: { code: "unavailable", message: "Exact summary unavailable" } }, { status: 503 })
    : original(input, init));
  renderHub(<RevisionsView />, context);
  expect(await screen.findByText(/\(unavailable\)/)).toBeVisible();
  expect(paths.some(path => path.includes("/revisions?"))).toBe(true);
});

function OverridePages() {
  const query = useRevisionPages("other");
  return <>{query.data?.revisions.map(revision => <p key={revision.id}>{revision.message}</p>)}</>;
}

test("revision pages use the explicit project even when another Hub project is selected", async () => {
  vi.mocked(fetch).mockImplementation(async input => {
    const path = String(input); paths.push(path);
    return Response.json({ revisions: [{ ...revisions[56], projectId: "other" }] });
  });
  renderHub(<OverridePages />, context);
  expect(await screen.findByText("Revision 56")).toBeVisible();
  expect(paths).toEqual(["/hub/v1/projects/other/revisions?summary=1"]);
});
