import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetClient } from "../src/api/client";
import type { HubContextValue } from "../src/app/hub-context";
import i18n from "../src/i18n";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { liveWorkAdapter } from "../src/features/managed-work/adapter";
import { WorkAttention } from "../src/features/managed-work/updates";
import { ManagedAttentionOverview } from "../src/features/managed-work/overview-attention";
import { recordOf } from "../src/features/managed-work/model";
import type { WorkRecord } from "../src/features/managed-work/types";
import { renderHub } from "./hub-render";

const navigate=vi.fn();
const context:HubContextValue={projectId:"p",scopeKey:77,principal:{id:"human:test",kind:"human",role:"operator"},location:{projectId:"p",tab:"work"},navigate,refresh:async()=>undefined};
const adapter=liveWorkAdapter("p");
let records:WorkRecord[];
let requests:string[];
beforeEach(async()=>{resetClient();navigate.mockClear();requests=[];await i18n.changeLanguage("en");records=(await demoWorkAdapter("p").snapshot()).records;const evidence=recordOf(records,"evidence","ev-agent")!;evidence.result="fail";evidence.report="Late verification failed";vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{const path=String(input);requests.push(path);if(path.includes("/capabilities"))return Response.json({protocolVersion:1,enabled:true,allowedCommands:[],limits:{},features:{managedExecution:false,gitObserver:false,legacyConversion:false}});if(path.includes("/records/"))return Response.json({record:recordOf(records,"attempt","a-agent"),eventCursor:"next"});return Response.json({records:[evidence],nextCursor:null});});});

test("live attention accepts and opens late Evidence with its cached Attempt without parent requests",async()=>{const select=vi.fn();renderHub(<WorkAttention adapter={adapter} records={records} onSelect={select}/>,context);fireEvent.click(await screen.findByRole("button",{name:/Late verification failed/}));await waitFor(()=>expect(select).toHaveBeenCalledWith("flow-demo","i1","a-agent"));expect(requests.filter(path=>path.includes("/records/"))).toHaveLength(0);});

test("live Overview renders Evidence roots and resolves their Attempt only when opened",async()=>{renderHub(<ManagedAttentionOverview projects={[{id:"p",name:"Project"}]}/>,context);const button=await screen.findByRole("button",{name:/Late verification failed/});expect(requests.filter(path=>path.includes("/records/"))).toHaveLength(0);fireEvent.click(button);await waitFor(()=>expect(navigate).toHaveBeenCalledWith({projectId:"p",tab:"work",flowId:"flow-demo",intentId:"i1",attemptId:"a-agent"}));expect(requests.filter(path=>path.includes("/records/"))).toHaveLength(1);});

test("live Evidence parent lookup failure remains visible and never navigates",async()=>{vi.mocked(fetch).mockImplementation(async input=>String(input).includes("/capabilities")?Response.json({protocolVersion:1,enabled:true,allowedCommands:[],limits:{},features:{managedExecution:false,gitObserver:false,legacyConversion:false}}):String(input).includes("/records/")?Response.json({error:{code:"not-found",message:"Attempt unavailable"}},{status:404}):Response.json({records:[recordOf(records,"evidence","ev-agent")],nextCursor:null}));renderHub(<ManagedAttentionOverview projects={[{id:"p",name:"Project"}]}/>,context);fireEvent.click(await screen.findByRole("button",{name:/Late verification failed/}));expect(await screen.findByRole("alert")).toHaveTextContent("Attention items could not be loaded");expect(navigate).not.toHaveBeenCalled();});
