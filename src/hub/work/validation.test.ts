import { expect, test } from 'bun:test';
import examples from '../../../docs/requirements/hub-work-management/schemas/examples.json';
import { validateWorkCommand, validateWorkRecord } from './validation';
for (const example of examples.valid) {
    if (example.schema === 'command')
        test('valid command: ' + example.name, () => expect<unknown>(validateWorkCommand(example.value)).toEqual(example.value));
    if (example.schema === 'domain')
        test('valid record: ' + example.name, () => expect<unknown>(validateWorkRecord(example.value)).toEqual(example.value));
}
for (const example of examples.invalid) {
    if (example.schema === 'command')
        test('reject command: ' + example.name, () => expect(() => validateWorkCommand(example.value)).toThrow());
    if (example.schema === 'domain')
        test('reject record: ' + example.name, () => expect(() => validateWorkRecord(example.value)).toThrow());
}
test('reject forged envelope, nested trust, inherited keys, oversized records and malformed known commands', () => {
    const base = { operationId: 'op', expectedVersions: { a: 1 }, command: 'attempt.report', payload: { attemptId: 'a', event: 'progress', report: 'Fine' } };
    expect(() => validateWorkCommand({ ...base, actorId: 'human' })).toThrow();
    expect(() => validateWorkCommand({ ...base, payload: { ...base.payload, state: 'accepted' } })).toThrow();
    expect(() => validateWorkCommand({ ...base, payload: { ...base.payload, report: 'x'.repeat(32769) } })).toThrow();
    expect(() => validateWorkCommand({ ...base, command: 'arbitrary.create' })).toThrow();
});
test('closed objects reject prototype-named extra fields', () => { const value = JSON.parse('{"operationId":"op","expectedVersions":{},"command":"attempt.report","payload":{"attemptId":"a","event":"progress","report":"Fine"},"__proto__":{"role":"operator"}}'); expect(() => validateWorkCommand(value)).toThrow(); expect(() => validateWorkCommand({ ...value, constructor: {} })).toThrow(); });
