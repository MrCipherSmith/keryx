// The slice of `bun:test` the desktop unit tests use. The app's tsconfig loads only the vite client
// types, so `tsc --noEmit` needs this to type-check the *.test.ts files; bun runs the real module.
declare module "bun:test" {
  type TestFn = () => void | Promise<void>;
  interface Matchers {
    not: Matchers;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeTrue(): void;
    toBeFalse(): void;
    toContain(expected: unknown): void;
    toMatch(expected: RegExp | string): void;
    toHaveLength(n: number): void;
    toBeGreaterThan(n: number): void;
    toThrow(expected?: unknown): void;
  }
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: TestFn): void;
  export function beforeAll(fn: TestFn): void;
  export function afterAll(fn: TestFn): void;
  export function expect(actual: unknown): Matchers;
}
