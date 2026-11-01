import { fail } from '../domain';
import type { WorkCommand, WorkRecord } from './model';
import { matchesWorkSchema } from './openapi';

export function validateWorkCommand(value: unknown): WorkCommand {
    if (!matchesWorkSchema(value, { $ref: '#/components/schemas/WorkCommand' }))
        fail(400, 'invalid-work-command', 'Command does not match the closed work protocol');
    return value as WorkCommand;
}

export function validateWorkRecord(value: unknown): WorkRecord {
    if (!matchesWorkSchema(value, { $ref: '#/components/schemas/WorkRecord' }))
        fail(500, 'invalid-work-record', 'Domain record violates the work protocol');
    return value as WorkRecord;
}
