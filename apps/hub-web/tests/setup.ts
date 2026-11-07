import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
afterEach(cleanup);

beforeEach(() => sessionStorage.clear());

// jsdom does not calculate layout. assistant-ui observes the viewport in real browsers.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
