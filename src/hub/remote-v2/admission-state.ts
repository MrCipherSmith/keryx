import type { HubState } from '../store';

/** Admission checks may inspect lazy legacy projections, but never mutate them. */
export function readOnlyAdmissionState(state: HubState): HubState {
    const seen = new WeakMap<object, object>();
    const reject = (): never => { throw new TypeError('Admission may not mutate legacy HubState'); };
    const view = <T extends object>(value: T): T => {
        const existing = seen.get(value);
        if (existing) return existing as T;
        const proxy = new Proxy(value, {
            get(target, key, receiver) {
                const result: unknown = Reflect.get(target, key, receiver);
                return result !== null && typeof result === 'object' ? view(result) : result;
            },
            set: reject,
            deleteProperty: reject,
            defineProperty: reject,
            setPrototypeOf: reject,
            preventExtensions: reject,
        });
        seen.set(value, proxy);
        return proxy;
    };
    return view(state);
}
