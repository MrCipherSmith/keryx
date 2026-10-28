import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { withoutGitDiscoveryOverrides } from '../git-env';
import { parsePatchTargets } from '../patch-risk';
import { safeHubPath } from '../../hub/git-delivery';
import { canonicalDigest, type Control, type ProtocolResult } from '../../remote-control/protocol';
import { redactSensitiveText } from '../../security/redact';
import { captureBaseline, verifyBaseline, type WorkspaceBaseline } from './checkout-lease';
import { MachineError, machineFailure } from './errors';
import { isMetaprojectManagedPath } from '../metaproject-gitignore';
function safeEffectPath(cwd: string, relative: string): void {
    let current = realpathSync(cwd);
    const parts = relative.split('/');
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        try {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
                throw new MachineError('unsafe-workspace-path');
        }
        catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
                throw cause;
        }
    }
}
function visiblePatchPath(cwd: string, relative: string): void { if (isMetaprojectManagedPath(relative))
    throw new MachineError('unsupported-ignored-path'); const ignored = Bun.spawnSync(['git', '-C', cwd, 'check-ignore', '--quiet', '--', relative], { env: withoutGitDiscoveryOverrides(process.env) }); if (ignored.exitCode === 0)
    throw new MachineError('unsupported-ignored-path'); if (ignored.exitCode !== 1)
    throw new MachineError('invalid-checkout'); }
/** Shared contained nonignored regular-file scope for native rewind preflight and its owned effect. */
export function validateOwnedEffectPaths(cwd: string, paths: readonly string[]): void {
    if (paths.length > 5000 || new Set(paths).size !== paths.length) throw new MachineError('invalid-rewind-preview');
    for (const candidate of paths) {
        if (!/^[A-Za-z0-9_./-]+$/.test(candidate)) throw new MachineError('unsafe-workspace-path');
        safeHubPath(candidate); safeEffectPath(cwd, candidate); visiblePatchPath(cwd, candidate);
    }
}
export function createOwnedWorkspace(cwd: string, assertOwnership: () => void = () => { }, initial?: WorkspaceBaseline) {
    let owned = initial ?? captureBaseline(cwd, { requireClean: true }), start = owned, conflict = false;
    const aliases = new Set([owned.digest]);
    if (initial && !verifyBaseline(cwd, initial))
        throw new MachineError('workspace-conflict');
    const effects = new Map<string, {
        before: WorkspaceBaseline;
        paths: Set<string>;
        toolName: string;
    }>();
    const failed = (cause: unknown): ProtocolResult<never> => { conflict = true; const error = machineFailure(cause, 'workspace-conflict'); return { ok: false, error: { code: error.code, message: error.code } }; };
    const live = () => { assertOwnership(); if (conflict || !verifyBaseline(cwd, owned))
        throw new MachineError('workspace-conflict'); };
    return {
        baseline: () => owned,
        beginTurn() { live(); start = owned; },
        async verify(expected: string): Promise<ProtocolResult<{
            baseline: string;
        }>> { try {
            live();
            if (!aliases.has(expected))
                throw new MachineError('workspace-conflict');
            return { ok: true, value: { baseline: owned.digest } };
        }
        catch (cause) {
            return failed(cause);
        } },
        async checkpoint(): Promise<ProtocolResult<{
            baseline: string;
        }>> { try {
            live();
            return { ok: true, value: { baseline: owned.digest } };
        }
        catch (cause) {
            return failed(cause);
        } },
        async beforeEffect(toolName: string, input: Record<string, unknown>): Promise<ProtocolResult<{
            effectId: string;
        }>> {
            try {
                live();
                if (effects.size)
                    throw new MachineError('workspace-conflict');
                const paths = new Set<string>();
                if (toolName === 'apply_patch') {
                    if (typeof input.patch !== 'string')
                        throw new MachineError('invalid-arguments');
                    for (const target of parsePatchTargets(input.patch)) {
                        safeHubPath(target.path);
                        if (!/^[A-Za-z0-9_./-]+$/.test(target.path))
                            throw new MachineError('workspace-conflict');
                        safeEffectPath(cwd, target.path);
                        visiblePatchPath(cwd, target.path);
                        paths.add(target.path);
                    }
                    if (!paths.size)
                        throw new MachineError('invalid-arguments');
                }
                if (toolName === 'rewind_restore') {
                    if (input.workspaceBaseline !== owned.digest || typeof input.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewDigest) || !Number.isSafeInteger(input.snapshotSeq) || Number(input.snapshotSeq) < 0 || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 5000)
                        throw new MachineError('invalid-rewind-preview');
                    if (!input.paths.every((candidate): candidate is string => typeof candidate === 'string')) throw new MachineError('unsafe-workspace-path');
                    validateOwnedEffectPaths(cwd, input.paths);
                    for (const candidate of input.paths) paths.add(candidate);
                    if (paths.size !== input.paths.length)
                        throw new MachineError('invalid-rewind-preview');
                }
                if (toolName === 'analysis_cache_write') {
                    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 16)
                        throw new MachineError('invalid-arguments');
                    for (const candidate of input.paths) {
                        if (typeof candidate !== 'string' || !/^\.metaproject\/data\/(?:review-jev-rules\/(?:clause-tags|violation-cache)\.json|review-conform\/(?:clause-tags|recent-docs)\.json|review-jev-comments\/labels__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+__[1-9][0-9]*\.json)$/.test(candidate))
                            throw new MachineError('workspace-conflict');
                        safeEffectPath(cwd, candidate);
                        paths.add(candidate);
                    }
                }
                const effectId = randomUUID();
                effects.set(effectId, { before: owned, paths, toolName });
                return { ok: true, value: { effectId } };
            }
            catch (cause) {
                return failed(cause);
            }
        },
        async afterEffect(effectId: string, result: {
            isError: boolean;
        }): Promise<ProtocolResult<{
            baseline: string;
        }>> {
            try {
                assertOwnership();
                const effect = effects.get(effectId);
                effects.delete(effectId);
                if (!effect || conflict)
                    throw new MachineError('workspace-conflict');
                for (const relative of effect.paths) {
                    safeEffectPath(cwd, relative);
                    if (effect.toolName === 'apply_patch' || effect.toolName === 'rewind_restore')
                        visiblePatchPath(cwd, relative);
                }
                const after = captureBaseline(cwd, { requireClean: false });
                if (after.head !== effect.before.head || after.indexDigest !== effect.before.indexDigest)
                    throw new MachineError('workspace-conflict');
                const changed = [...new Set([...Object.keys(effect.before.files), ...Object.keys(after.files)])].filter(file => canonicalDigest(effect.before.files[file] ?? null) !== canonicalDigest(after.files[file] ?? null));
                if (changed.some(file => !effect.paths.has(file)) || (result.isError && changed.length))
                    throw new MachineError('workspace-conflict');
                owned = after;
                aliases.add(owned.digest);
                return { ok: true, value: { baseline: owned.digest } };
            }
            catch (cause) {
                return failed(cause);
            }
        },
        resultChanges(): Control['ResultUpload']['changes'] {
            live();
            const changes: Control['ResultUpload']['changes'] = [];
            let bytes = 0;
            for (const file of [...new Set([...Object.keys(start.files), ...Object.keys(owned.files)])].sort()) {
                if (canonicalDigest(start.files[file] ?? null) === canonicalDigest(owned.files[file] ?? null))
                    continue;
                safeHubPath(file);
                const entry = owned.files[file];
                if (!entry) {
                    changes.push({ path: file, deleted: true });
                    continue;
                }
                const absolute = path.join(cwd, file);
                const stat = lstatSync(absolute);
                if (entry.symlink !== undefined || stat.isSymbolicLink() || !stat.isFile() || !realpathSync(absolute).startsWith(realpathSync(cwd) + path.sep))
                    throw new MachineError('unsafe-workspace-path');
                const content = readFileSync(absolute);
                bytes += content.length;
                if (bytes > 20 * 1024 * 1024 || changes.length >= 5000)
                    throw new MachineError('quota-exceeded');
                if (content.includes(0) || redactSensitiveText(content.toString('utf8')) !== content.toString('utf8') || /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b)/.test(content.toString('utf8')))
                    throw new MachineError('secret-screening');
                changes.push({ path: file, contentBase64: content.toString('base64'), mode: (entry.mode & 0o111) ? '100755' : '100644' });
            }
            return changes;
        },
    };
}
export type OwnedWorkspace = ReturnType<typeof createOwnedWorkspace>;
