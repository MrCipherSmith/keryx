/** `keryx serve` started from an isolated native candidate (scripts/smoke/package-native-candidate.ts), not from the checkout.
 * bun scripts/smoke/serve-candidate.ts --candidate /absolute/candidate/bin/keryx
 * Runs the deterministic two-machine serve trial with every machine's serve child being that compiled executable: both bridges
 * must connect and publish a ready production profile, and one real read turn must run in a candidate serve child. Loopback only;
 * the trial's synthetic HOME/XDG, scrubbed environment and loopback provider apply. Not a release check: the embedded native
 * coverage descriptor and the packaged Hub stay separate gates. */
import { readFileSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { startMachineTrial, trialTurn } from '../../src/lib/hub-machine/trial.test-support';
import type { Control } from '../../src/remote-control/protocol';

if (process.argv.length !== 4 || process.argv[2] !== '--candidate' || !isAbsolute(process.argv[3]!)) throw new Error('Usage: serve-candidate --candidate /absolute/candidate/bin/keryx');
const candidate = process.argv[3]!;
const trial = await startMachineTrial({ candidate });
let cookie = '';
async function call<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${trial.origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: trial.origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (route === '/hub/v1/session' && response.ok) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  if (!response.ok) throw new Error(`serve-candidate-http-${response.status}-${route.split('/').slice(0, 4).join('/')}`);
  return await response.json() as T;
}
async function wait<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (done(value)) return value; if (Date.now() > deadline) throw new Error('serve-candidate-timeout'); await Bun.sleep(50); }
}
type Machine = { connected: boolean; inventory: { inventoryVersion: number; checkouts: { checkoutId: string; headSha: string; agentProfiles: { profileId: string; readiness: string; reason: string; capabilityDigest: string; policyDigest: string }[] }[] } | null };
try {
  await call('/hub/v1/session', { token: readFileSync(trial.credentialsFile, 'utf8') });
  const machines = [];
  for (const target of trial.targets) {
    const machine = await wait(() => call<Machine>(`/hub/v2/machines/${target.machineId}`), v => v.connected && v.inventory?.checkouts[0]?.agentProfiles[0]?.readiness === 'ready');
    machines.push({ machine: target.machine, servePid: target.serve.pid, argv0: target.serve.argv[0], profile: machine.inventory!.checkouts[0]!.agentProfiles[0] });
    if (target.serve.argv[0] !== candidate) throw new Error('serve-candidate-not-used');
  }
  // One real native turn in the first candidate serve child: a read through the production runtime against the loopback provider.
  const target = trial.targets[0]!, machine = await call<Machine>(`/hub/v2/machines/${target.machineId}`), checkout = machine.inventory!.checkouts[0]!, profile = checkout.agentProfiles[0]!;
  const created = await call<Control['SessionOperationReceipt']>(`/hub/v2/projects/${trial.projectId}/sessions`, { machineId: target.machineId, checkoutId: checkout.checkoutId, agentProfileId: profile.profileId, expectedInventoryVersion: machine.inventory!.inventoryVersion, expectedHeadSha: checkout.headSha, capabilityDigest: profile.capabilityDigest, policyDigest: profile.policyDigest, title: 'Packaged serve read' });
  const base = `/hub/v2/projects/${trial.projectId}/sessions/${created.sessionId}`;
  const idle = await wait(() => call<Control['SessionRecord']>(base), s => s.state === 'idle');
  const claim = await call<Control['ControllerReceipt']>(`${base}/controller/claim`, { expectedSessionVersion: idle.version, expectedControllerVersion: 0, requestedLeaseSeconds: 60, mode: 'claim' });
  const held = await wait(() => call<Control['SessionRecord']>(base), s => s.controller?.controllerLeaseId === claim.lease.controllerLeaseId && s.state === 'idle');
  const turn = await call<Control['TurnReceipt']>(`${base}/messages`, { expectedSessionVersion: held.version, expectedConfigVersion: held.config.configVersion, controller: { controllerLeaseId: claim.lease.controllerLeaseId, expectedControllerVersion: claim.lease.version }, text: trialTurn(1, 'read seed.txt'), interpretation: 'literal-message', busyPolicy: 'reject', association: { mode: 'ad-hoc', profileConsentVersion: 1 } });
  const run = await wait(() => call<{ state: string }>(`/hub/v2/projects/${trial.projectId}/runs/${turn.runId}`), r => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(r.state));
  const calls = trial.provider.calls.filter(c => c.machine === target.machine).map(c => c.toolName ? `${c.reply}:${c.toolName}` : c.reply);
  const exits = await trial.stop();
  const notices = trial.targets.map(t => t.serve.stdout.filter(line => line.includes('Hub machine:')).map(line => line.trim()));
  const ok = run.state === 'succeeded' && calls.join() === 'tool:read_file,text' && exits.every(code => code === 0);
  console.log(JSON.stringify({ kind: 'serve-candidate', ok, candidate, machines, run: { runId: turn.runId, state: run.state }, providerCalls: calls, exits, notices }));
  if (!ok) process.exitCode = 1;
} finally {
  await trial.stop();
  rmSync(trial.root, { recursive: true, force: true });
}
