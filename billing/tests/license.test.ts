import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64urlDecode } from "../src/lib/encoding";
import {
  buildPublicKeyset,
  issueLicenseToken,
  licenseClaimsSchema,
  verifyLicenseToken,
  type LicenseClaims,
} from "../src/lib/license";

function signingKeys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privatePem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function claims(now: number): Omit<LicenseClaims, "jti"> {
  return {
    v: 1 as const,
    iss: "https://licenses.example.test",
    aud: "dmoft-pro" as const,
    sub: "cus_test_123",
    iat: now,
    nbf: now - 5,
    exp: now + 30 * 86_400,
    grace_until: now + 37 * 86_400,
    tier: "pro",
    entitlements: ["camera.live", "optics.adaptive", "transport.hybrid"],
    device_id: "dmoft-device-v1-K7gNU3sdo-OL0wNhqa8wEZhe",
    device_key_sha256: "K7gNU3sdo-OL0wNhqa8wEZhe0i5OSXlVdJ6k0EbYQ2w",
    subscription_id: "sub_test_123",
  };
}

describe("compact offline license", () => {
  it("issues an unpadded compact EdDSA token with the strict contract", () => {
    const keys = signingKeys();
    const issued = issueLicenseToken({ privateKeyPem: keys.privatePem, keyId: "key-1", claims: claims(1_800_000_000) });
    const segments = issued.token.split(".");
    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => !segment.includes("="))).toBe(true);
    expect(JSON.parse(base64urlDecode(segments[0]).toString("utf8"))).toEqual({
      alg: "EdDSA",
      kid: "key-1",
      typ: "DMOFT-LICENSE",
      v: 1,
    });
    expect(verifyLicenseToken(issued.token, keys.publicPem)).toEqual(issued.claims);
  });

  it("rejects tampering and policy-overlong lifetimes", () => {
    const keys = signingKeys();
    const issued = issueLicenseToken({ privateKeyPem: keys.privatePem, keyId: "key-1", claims: claims(1_800_000_000) });
    const segments = issued.token.split(".");
    segments[1] = `${segments[1].slice(0, -1)}${segments[1].endsWith("A") ? "B" : "A"}`;
    expect(() => verifyLicenseToken(segments.join("."), keys.publicPem)).toThrow();
    expect(() => issueLicenseToken({
      privateKeyPem: keys.privatePem,
      keyId: "key-1",
      claims: { ...claims(1_800_000_000), exp: 1_800_000_000 + 30 * 86_400 + 1, grace_until: 1_800_000_000 + 37 * 86_400 },
    })).toThrow(/30 days/);
  });

  it("exports the strict rotating public keyset shape", () => {
    const keys = signingKeys();
    const keyset = buildPublicKeyset({ keyId: "key-1", publicKeyPem: keys.publicPem });
    expect(keyset).toEqual({
      v: 1,
      keys: [{ kid: "key-1", alg: "EdDSA", public_key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }],
    });
    expect(() => buildPublicKeyset({
      keyId: "key-1",
      publicKeyPem: keys.publicPem,
      configuredJson: JSON.stringify({
        v: 1,
        keys: [{ kid: "invalid:key", alg: "EdDSA", public_key: "A".repeat(43) }],
      }),
    })).toThrow();
  });
});

it("matches the client-consumed cross-language fixture byte for byte", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/license-v1.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
  const privateDer = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    base64urlDecode(String(fixture.issuer_private_key_seed)),
  ]);
  const privatePem = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8" }).toString();
  const keyset = fixture.issuer_keyset as { keys: Array<{ public_key: string }> };
  const publicDer = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    base64urlDecode(keyset.keys[0].public_key),
  ]);
  const publicPem = createPublicKey({ key: publicDer, format: "der", type: "spki" })
    .export({ format: "pem", type: "spki" }).toString();
  const parsedClaims = licenseClaimsSchema.parse(fixture.claims);
  expect(verifyLicenseToken(String(fixture.token), publicPem)).toEqual(parsedClaims);
  const { jti, ...claimsWithoutJti } = parsedClaims;
  const issued = issueLicenseToken({
    privateKeyPem: privatePem,
    keyId: "fixture-2026",
    claims: { ...claimsWithoutJti, jti },
  });
  expect(issued.token).toBe(fixture.token);
});
