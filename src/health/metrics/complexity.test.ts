import { test, expect } from "bun:test";
import { computeComplexity } from "./complexity";

test("detects a function with a TS return-type annotation", () => {
  const c = computeComplexity(
    `export function foo(a: number): Promise<number> { if (a) return 1; return 2; }`,
  );
  expect(c.functions.length).toBe(1);
  expect(c.max).toBe(2); // 1 base + one `if`
});

test("detects a generic function", () => {
  const c = computeComplexity(`function g<T>(x: T): T { return x; }`);
  expect(c.functions).toEqual([1]);
});

test("detects an arrow with a block body", () => {
  const c = computeComplexity(
    `const f = (x: number): void => { for (let i = 0; i < x; i++) {} };`,
  );
  expect(c.functions.length).toBe(1);
  expect(c.max).toBe(2); // 1 base + one `for`
});

test("detects a method with a return type", () => {
  const c = computeComplexity(`const o = { run(ctx: any): void { while (ctx) {} } };`);
  expect(c.functions.length).toBe(1);
  expect(c.max).toBe(2);
});

test("control statements are not treated as functions", () => {
  const c = computeComplexity(`if (a) { while (b) {} }`);
  expect(c.functions).toEqual([]);
  expect(c.max).toBe(0);
});

test("decisions inside strings and comments are ignored", () => {
  const c = computeComplexity(
    `function h() { const s = "if && || ? case"; /* if for while */ return s; }`,
  );
  expect(c.functions).toEqual([1]);
});

test("counts logical operators, nullish, and ternary", () => {
  const c = computeComplexity(`function k(a: any, b: any) { return a && b || (a ?? b) ? 1 : 2; }`);
  // && , || , ?? , ? -> 4 decisions + 1 base
  expect(c.max).toBe(5);
});

test("counts nested functions separately instead of adding them to the parent", () => {
  const c = computeComplexity(`
    function outer(items: number[]) {
      if (items.length === 0) return [];
      return items.map((item) => {
        if (item > 0) return item;
        return 0;
      });
    }
  `);
  expect(c.functions).toEqual([2, 2]);
  expect(c.max).toBe(2);
});

test("counts nested function declarations separately", () => {
  const c = computeComplexity(`
    function outer(flag: boolean) {
      if (flag) return inner(flag);
      function inner(value: boolean) {
        return value ? 1 : 0;
      }
      return 0;
    }
  `);
  expect(c.functions).toEqual([2, 2]);
});
