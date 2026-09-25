// Keeps `command-registry.ts`'s `ROUTING_CATEGORIES_LITERAL` (a restated
// literal, not an import — core never imports client, see that file's own
// comment) in sync with the real `ROUTING_CATEGORIES`
// (`src/harness/routing/table.ts`). This test file itself is fine to import
// both: it is a test, not part of the shipped core graph.

import { expect, test } from "bun:test";
import { COMMAND_DESCRIPTORS } from "./command-registry";
import { ROUTING_CATEGORIES } from "../harness/routing/table";

test("command-registry's routing-category enum values match ROUTING_CATEGORIES exactly", () => {
  const descriptors = COMMAND_DESCRIPTORS.filter((d) => d.command === "routing set" || d.command === "routing unset");
  expect(descriptors.length).toBe(2);
  for (const descriptor of descriptors) {
    const arg = descriptor.args.find((a) => a.name === "<category>");
    expect(arg?.values).toEqual([...ROUTING_CATEGORIES]);
  }
});
