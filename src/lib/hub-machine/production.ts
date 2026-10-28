import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveRemoteProfile } from '../../harness/policy/profiles';
import { detectSandboxLauncher } from '../../harness/process/sandbox/detect';
import { loadShellConfig } from '../shell-config';
import { canonicalDigest, type Control } from '../../remote-control/protocol';
import { createCommandCatalogue } from '../../session/commands/catalogue';
import { lifecycleCommands } from '../../session/host-lifecycle';
import type { NativeCommandContribution } from '../../session/commands/handlers';
import { wireModelIdentity } from '../../session/model-identity';
import { assembleNativeSessionRuntime } from '../../session/native-runtime-production';
import type { NativeSessionRuntime } from '../../session/native-runtime';
import type { CheckoutMapping } from './config';
import { MachineError, type MachineResult } from './errors';
export interface MachineProfile {
    profileId: string;
    policyDigest: string;
    capabilityDigest: string;
    catalogue: Control['CommandCatalogue'];
    routing: Control['RoutingAvailability'];
    createRuntime(sessionId: string): Promise<MachineResult<NativeSessionRuntime>>;
}
/** The readiness gate: any shipped command whose required owner is not implemented keeps every production profile `adapter-unsupported`. */
export function catalogueImplementationGaps(catalogue: Control['CommandCatalogue']): string[] {
    return catalogue.entries.filter(entry => entry.availability === 'implementation-gap').map(entry => entry.commandName);
}
/** This local composition never accepts provider/executable/env arguments from wire data. */
export async function resolveProductionMachineProfile(mapping: CheckoutMapping, options: {
    configDir: string;
    allowedCandidateIds: readonly string[];
}): Promise<MachineResult<MachineProfile>> {
    const fail = (code: string): MachineResult<never> => ({ ok: false, error: new MachineError(code) });
    if (!existsSync(path.join(mapping.cwd, '.metaproject', 'index.md')))
        return fail('local-policy');
    const policy = resolveRemoteProfile(mapping.profileId);
    if (!policy)
        return fail('local-policy');
    if (policy.requiredControls.isolation === 'required-fail-closed' && !detectSandboxLauncher().available)
        return fail('containment-missing');
    const saved = loadShellConfig(options.configDir);
    if (!saved.provider || saved.provider === 'fake' || !saved.model)
        return fail('provider-setup');
    const candidateId = canonicalDigest([saved.provider, saved.model]);
    if (!options.allowedCandidateIds.includes(candidateId))
        return fail('local-policy');
    const policyDigest = canonicalDigest(policy);
    const capabilityDigest = canonicalDigest({ adapter: 'keryx-native-v1', profileId: mapping.profileId, candidateId, tools: ['read_file', 'search_code', 'list_dir', 'hub_context', 'hub_flows', 'hub_flow', 'apply_patch', 'shell_exec'], maxToolCalls: 64, maxRounds: 16 });
    const catalogue = createMachineCommandCatalogue(capabilityDigest);
    // A partial registry must remain visible as a release/setup gap, never silently executable.
    if (catalogueImplementationGaps(catalogue).length > 0)
        return fail('adapter-unsupported');
    const routing = createLocalMachineRouting(saved.provider, saved.model, policyDigest, capabilityDigest);
    const providerId = saved.provider, modelId = saved.model;
    return { ok: true, value: { profileId: mapping.profileId, policyDigest, capabilityDigest, catalogue, routing,
            async createRuntime(sessionId) {
                const result = await assembleNativeSessionRuntime({ cwd: mapping.cwd, configDir: options.configDir, sessionId, profile: policy, providerId, modelId,
                    allowedTools: ['read_file', 'search_code', 'list_dir', 'hub_context', 'hub_flows', 'hub_flow', 'apply_patch', 'shell_exec', 'shell_task_output', 'shell_task_wait', 'shell_task_kill'], maxToolCalls: 64, maxRounds: 16, availability: routing });
                return result.ok ? result : { ok: false, error: new MachineError(result.error.code) };
            }
        } };
}
export function createLocalMachineRouting(providerId: string, modelId: string, policyDigest: string, capabilityDigest: string): Control['RoutingAvailability'] {
    const wire = wireModelIdentity(providerId, modelId);
    return { version: 1, policyDigest, capabilityDigest, profileIds: ['local'], candidates: [{ candidateId: canonicalDigest([providerId, modelId]), ...wire, reasoningEfforts: ['none', 'low', 'medium', 'high'], available: true, reason: 'none', privacyClass: 'approved-egress', costClass: 'metered' }] };
}
export function createMachineCommandCatalogue(capabilityDigest: string, contributions: readonly NativeCommandContribution[] = []): Control['CommandCatalogue'] { return createCommandCatalogue(capabilityDigest, [...lifecycleCommands(true), ...contributions]); }
