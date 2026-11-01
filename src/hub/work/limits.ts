import { fail } from '../domain';

export const MAX_COMMAND_BYTES = 65536;
export function pageLimit(url: URL, max = 200) {
    const raw = url.searchParams.get('limit');
    const value = raw === null ? 50 : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
        fail(400, 'invalid-limit', 'Page limit is out of range');
    return value;
}
