import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnv, resetEnvCacheForTests } from "../src/lib/env";

function configure(overrides: Record<string, string> = {}): void {
  const pair = generateKeyPairSync("ed25519");
  const values = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://localhost/test",
    DATABASE_SSL: "false",
    STRIPE_SECRET_KEY: "sk_test_value",
    STRIPE_WEBHOOK_SECRET: "whsec_value",
    STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
    STRIPE_PRICE_PRO_ANNUAL: "price_annual",
    OIDC_ISSUER: "http://localhost:4000/",
    OIDC_AUDIENCE: "dmoft-test",
    OIDC_JWKS_URL: "http://localhost:4000/jwks",
    APP_BASE_URL: "http://localhost:3000",
    LICENSE_ISSUER: "http://127.0.0.1:3000",
    LICENSE_KEY_ID: "test-key",
    LICENSE_ED25519_PRIVATE_KEY_PEM: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    LICENSE_ED25519_PUBLIC_KEY_PEM: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  resetEnvCacheForTests();
}

describe.sequential("server environment policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  it("allows loopback HTTP only in development", () => {
    configure();
    expect(getEnv().APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("requires HTTPS in production", () => {
    configure({ NODE_ENV: "production" });
    expect(() => getEnv()).toThrow(/HTTPS/);
  });

  it("rejects non-loopback HTTP outside production too", () => {
    configure({ APP_BASE_URL: "http://billing.example.test" });
    expect(() => getEnv()).toThrow(/HTTPS/);
  });

  it("rejects a mismatched signing key pair", () => {
    configure();
    const other = generateKeyPairSync("ed25519");
    vi.stubEnv("LICENSE_ED25519_PUBLIC_KEY_PEM", other.publicKey.export({ format: "pem", type: "spki" }).toString());
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/do not match/);
  });

  it("rejects tier identifiers the client cannot parse", () => {
    configure({
      ENTITLEMENT_POLICY_JSON: JSON.stringify({
        lookupToEntitlement: { camera: "camera.live" },
        deviceLimitByLookup: { devices: 1 },
        tierByLookup: { tier: "1invalid" },
        offlineGraceLookupKeys: [],
      }),
    });
    expect(() => getEnv()).toThrow();
  });
});
