import { describe, expect, test } from "bun:test";
import type { UpdateCheck } from "../platform/commands";
import { bannerModel, type BannerModel } from "./UpdateBanner";

const flags = (m: BannerModel | null) => (m ? { canUpdate: m.canUpdate, required: m.required } : null);

const check = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  current: "0.1.0",
  latest: "0.2.0",
  releaseUrl: null,
  available: true,
  required: false,
  keryxVersion: "0.4.36",
  minDesktopVersion: "0.1.0",
  ...over,
});

describe("bannerModel", () => {
  test("no check, or nothing newer: no banner", () => {
    expect(bannerModel(null, null)).toBeNull();
    expect(bannerModel(check({ available: false, latest: "0.1.0" }), null)).toBeNull();
    expect(bannerModel(check({ available: false, latest: null }), null)).toBeNull();
  });

  test("a newer release offers the update until that version is skipped", () => {
    expect(bannerModel(check(), null)?.title).toBe("Keryx 0.2.0 is available");
    expect(flags(bannerModel(check(), null))).toEqual({ canUpdate: true, required: false });
    expect(bannerModel(check(), "0.2.0")).toBeNull();
    // Skipping 0.2.0 does not hide 0.3.0.
    expect(bannerModel(check({ latest: "0.3.0" }), "0.2.0")?.title).toBe("Keryx 0.3.0 is available");
  });

  test("a keryx that needs a newer app is shown even when skipped, and says when there is nothing to install", () => {
    const required = bannerModel(check({ required: true, minDesktopVersion: "0.2.0" }), "0.2.0");
    expect(flags(required)).toEqual({ canUpdate: true, required: true });
    expect(required?.body).toContain("Keryx 0.2.0 or newer");
    const stuck = bannerModel(check({ required: true, available: false, latest: null, minDesktopVersion: "0.2.0" }), null);
    expect(flags(stuck)).toEqual({ canUpdate: false, required: true });
    expect(stuck?.body).toContain("no newer release was found");
  });
});
