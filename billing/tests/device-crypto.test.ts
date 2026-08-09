import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64urlEncode } from "../src/lib/encoding";
import {
  createChallengeText,
  parseDevicePublicKey,
  verifyDeviceSignature,
} from "../src/lib/device-crypto";

function deviceKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  return { privateKey: pair.privateKey, rawPublicKey: spki.subarray(12) };
}

describe("device identity and proof of possession", () => {
  it("derives the interoperable deterministic device identifier", () => {
    const raw = Buffer.alloc(32, 0x42);
    const identity = parseDevicePublicKey(base64urlEncode(raw));
    expect(identity.deviceId).toBe("dmoft-device-v1-Ql7U5KNrMOohuQ4hxxLGSegh");
    expect(identity.publicKeySha256).toHaveLength(43);
  });

  it("verifies Ed25519 over the exact UTF-8 challenge", () => {
    const { privateKey, rawPublicKey } = deviceKeyPair();
    const identity = parseDevicePublicKey(base64urlEncode(rawPublicKey));
    const generated = createChallengeText({
      purpose: "refresh",
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deviceId: identity.deviceId,
      deviceKeySha256: identity.publicKeySha256,
      expiresAt: 2_000_000_000,
      nonce: "fixed-nonce",
    });
    const signature = sign(null, Buffer.from(generated.challenge, "utf8"), privateKey);
    expect(verifyDeviceSignature(rawPublicKey, generated.challenge, base64urlEncode(signature))).toBe(true);
    expect(verifyDeviceSignature(rawPublicKey, `${generated.challenge}\n`, base64urlEncode(signature))).toBe(false);
  });

  it("rejects non-raw public key encodings", () => {
    expect(() => parseDevicePublicKey(base64urlEncode(Buffer.alloc(31)))).toThrow(/32-byte/);
    expect(() => parseDevicePublicKey("AA==")).toThrow(/unpadded/);
  });
});
