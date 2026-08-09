import { describe, expect, it } from "vitest";
import { activateSchema, challengeSchema, enrollDeviceSchema, parseJson } from "../src/lib/schemas";

const key = "A".repeat(43);

describe("public API schemas", () => {
  it("accepts the two challenge request variants", () => {
    expect(challengeSchema.parse({ purpose: "activate", checkout_session_id: "cs_test_1", device_public_key: key }).purpose).toBe("activate");
    expect(challengeSchema.parse({ purpose: "refresh", device_id: "dmoft-device-v1-test", device_public_key: key }).purpose).toBe("refresh");
  });

  it("rejects unknown properties and email-style identity fields", () => {
    expect(() => activateSchema.parse({
      challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkout_session_id: "cs_test_1",
      device_public_key: key,
      device_name: "Laptop",
      signature: "A".repeat(86),
      email: "not-auth@example.test",
    })).toThrow();
  });

  it("requires proof-of-possession fields for additional-device enrollment", () => {
    expect(enrollDeviceSchema.parse({
      challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      device_public_key: key,
      device_name: "Phone",
      signature: "A".repeat(86),
    }).device_name).toBe("Phone");
  });

  it("rejects JSON bodies above 64 KiB before parsing", async () => {
    const request = new Request("https://billing.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "65537" },
      body: "x".repeat(65_537),
    });
    await expect(parseJson(request, activateSchema)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
  });
});
