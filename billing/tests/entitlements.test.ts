import { describe, expect, it } from "vitest";
import { projectEntitlements } from "../src/lib/entitlements";
import type { EntitlementPolicyConfig } from "../src/lib/env";

const policy: EntitlementPolicyConfig = {
  lookupToEntitlement: {
    camera: "camera.live",
    optics: "optics.adaptive",
    hybrid: "transport.hybrid",
  },
  deviceLimitByLookup: { one_device: 1, ten_devices: 10 },
  tierByLookup: { paid: "pro", larger: "enterprise" },
  offlineGraceLookupKeys: ["offline"],
};

describe("Stripe Entitlements projection", () => {
  it("maps only allowlisted lookup keys and selects strongest limits", () => {
    expect(projectEntitlements(
      ["camera", "hybrid", "unknown", "one_device", "ten_devices", "paid", "larger", "offline"],
      policy,
    )).toEqual({
      entitlements: ["camera.live", "transport.hybrid"],
      deviceLimit: 10,
      tier: "enterprise",
      offlineGracePermitted: true,
    });
  });

  it("fails closed to no access for unknown lookup keys", () => {
    expect(projectEntitlements(["invented"], policy)).toEqual({
      entitlements: [],
      deviceLimit: 0,
      tier: "none",
      offlineGracePermitted: false,
    });
  });
});
