import { expect, test } from "bun:test";
import { workOpenApi, matchesWorkSchema } from "./openapi";

test("published OpenAPI is the exact generated closed HTTP contract", async () => {
    const published = await Bun.file(new URL("../../../docs/requirements/hub-work-management/openapi.json", import.meta.url)).json();
    expect(published).toEqual(workOpenApi);
    expect(workOpenApi.openapi).toBe("3.1.0");
    expect(Object.keys(workOpenApi.paths)).toHaveLength(22);
});

test("responses reject unknown fields, invalid records, and unsupported actions", () => {
    expect(matchesWorkSchema({ records: [], nextCursor: null, eventCursor: "opaque-cursor" }, { $ref: "#/components/schemas/Page" })).toBe(true);
    expect(matchesWorkSchema({ records: [], nextCursor: null, eventCursor: "opaque-cursor", secret: "bad" }, { $ref: "#/components/schemas/Page" })).toBe(false);
    expect(matchesWorkSchema({ records: [], actions: [{ command: "trust.me", allowed: true, reasonCode: "ok" }], eventCursor: "opaque-cursor" }, { $ref: "#/components/schemas/Aggregate" })).toBe(false);
});
