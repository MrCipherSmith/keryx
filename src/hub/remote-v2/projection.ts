import {PROFILE_STAGING_BYTES} from './budgets';
import { catalogueDigest, canonicalDigest, type Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { MachineRecord, Projection } from "./model";
import { projectionKey } from "./guards";
export function ingestCapabilities(repo: RemoteRepository, machine: MachineRecord, page: Control["CapabilityPage"]): void {
  if (!machine.projectIds.includes(page.projectId)) fail(403, "scope-denied", "Capability project denied");
  const inventory = repo.get<{ inventoryVersion: number; checkouts: { projectId: string; checkoutId: string; agentProfiles: { profileId: string; policyDigest: string; capabilityDigest: string }[] }[] }>("remote_inventory", machine.machineId);
  const checkout = inventory?.checkouts.find((c) => c.projectId === page.projectId && c.checkoutId === page.checkoutId);
  const profile = checkout?.agentProfiles.find((p) => p.profileId === page.agentProfileId);
  if (!profile || inventory?.inventoryVersion !== page.inventoryVersion || profile.policyDigest !== page.policyDigest || profile.capabilityDigest !== page.capabilityDigest) fail(409, "stale-reference", "Capability projection does not match inventory");
  const base = projectionKey(machine.machineId, page.projectId, page.checkoutId, page.agentProfileId);
  const end=page.cursor+page.entries.length;
  if(end>page.totalEntries || (page.nextCursor===null ? end!==page.totalEntries : page.entries.length===0 || page.nextCursor!==end || end>=page.totalEntries)) fail(400,"invalid-cursor","Capability page cursor must describe its exact bounded entry range");
  const staged=repo.projectionPages<Control["CapabilityPage"]>(base);
  const key = `${base}:${page.projectionVersion}:${page.kind}:${page.cursor}`;
  const old = repo.get<Control["CapabilityPage"]>("remote_capability_page", key);
  if (old && canonicalDigest(old) !== canonicalDigest(page)) fail(409, "payload-conflict", "Capability page changed on replay");
  const published = repo.get<Projection>("remote_projection", base);
  if(published?.projectionVersion===page.projectionVersion&&published.connectionEpoch===machine.epoch&&published.pageDigests){
    if(published.pageDigests[`${page.kind}:${page.cursor}`]!==canonicalDigest(page))fail(409,'payload-conflict','Published capability page changed on replay');
    return;
  }
  if ((published && published.projectionVersion > page.projectionVersion) || staged.some(p=>p.projectionVersion>page.projectionVersion)) fail(409, "stale-reference", "Capability projection regressed");
  // Keep one in-progress generation per explicitly mapped profile. A new
  // generation does not erase the last complete published projection.
  for(const prior of staged) if(prior.projectionVersion<page.projectionVersion) repo.delete("remote_capability_page",`${base}:${prior.projectionVersion}:${prior.kind}:${prior.cursor}`);
  if (page.kind === "catalogue") for (const entry of page.entries) {
    for (const schema of [entry.inputSchema, entry.resultSchema]) {
      // Compiling catches malformed required/property bindings independent of sample arguments.
      if (!schemaShape(schema, 0)) fail(400, "invalid-frame", "Unbounded or malformed command schema");
    }
  }
  repo.put("remote_capability_page", key, page, { projectId: page.projectId, machineId: machine.machineId, seq: page.cursor });
  const pages = repo.projectionPages<Control["CapabilityPage"]>(base).filter((p)=>p.projectionVersion===page.projectionVersion);
  function complete(kind: "catalogue" | "routing") {
    const set = pages.filter((p) => p.kind === kind).sort((a, b) => a.cursor - b.cursor);
    if (!set.length || set[0]!.cursor !== 0) return undefined;
    let count = 0;
    for (let i = 0; i < set.length; i++) { const current = set[i]!; if (current.catalogueDigest !== page.catalogueDigest || current.inventoryVersion !== page.inventoryVersion || current.policyDigest !== page.policyDigest || current.capabilityDigest !== page.capabilityDigest || current.catalogueVersion !== page.catalogueVersion || current.totalEntries !== set[0]!.totalEntries) fail(409, "payload-conflict", "Projection pages disagree"); count += current.entries.length; if (i + 1 < set.length && current.nextCursor !== set[i + 1]!.cursor) return undefined; }
    if (set.at(-1)!.nextCursor !== null || count !== set[0]!.totalEntries) return undefined;
    return set;
  }
  const cataloguePages = complete("catalogue"), routingPages = complete("routing");
  if (!cataloguePages || !routingPages) {
    if(repo.stagingBytes()>repo.budgets.stagingBytes||repo.stagingBytes(base)>PROFILE_STAGING_BYTES)fail(413,'quota-exceeded','Capability staging byte budget exhausted');
    return;
  }
  const catalogue = cataloguePages.flatMap((p) => p.kind === "catalogue" ? p.entries : []);
  const candidates = routingPages.flatMap((p) => p.kind === "routing" ? p.entries : []);
  if (new Set(catalogue.map((c) => c.commandName)).size !== catalogue.length || new Set(candidates.map((c) => c.candidateId)).size !== candidates.length || catalogueDigest(catalogue) !== page.catalogueDigest) fail(409, "payload-conflict", "Catalogue digest or identities disagree");
  const routingFirst = routingPages[0]!;
  if (routingFirst.kind !== "routing") return;
  repo.put("remote_projection", base, { projectId: page.projectId, checkoutId: page.checkoutId, agentProfileId: page.agentProfileId, projectionVersion: page.projectionVersion, inventoryVersion: page.inventoryVersion, policyDigest: page.policyDigest, capabilityDigest: page.capabilityDigest, catalogueVersion: page.catalogueVersion, catalogueDigest: page.catalogueDigest, catalogue, candidates, profileIds: routingFirst.profileIds, connectionEpoch: machine.epoch, pageDigests:Object.fromEntries(pages.map(p=>[`${p.kind}:${p.cursor}`,canonicalDigest(p)])) } satisfies Projection, { projectId: page.projectId, machineId: machine.machineId });
  for(const stagedPage of repo.projectionPages<Control["CapabilityPage"]>(base))repo.delete("remote_capability_page",`${base}:${stagedPage.projectionVersion}:${stagedPage.kind}:${stagedPage.cursor}`);
}
function schemaShape(schema: Control["ArgumentSchema"], depth: number): boolean {
  if (depth > 8) return false;
  if (schema.type === "object") return schema.required.every((key) => Object.hasOwn(schema.properties, key)) && Object.values(schema.properties).every((s) => schemaShape(s, depth + 1));
  if (schema.type === "array") return schemaShape(schema.items, depth + 1);
  if (schema.type === "number" || schema.type === "integer") return schema.minimum <= schema.maximum;
  return true;
}
