import {
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { base64urlDecode, base64urlEncode, sha256 } from "./encoding";
import { HttpError } from "./errors";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type DeviceIdentity = {
  rawPublicKey: Buffer;
  publicKeySha256: string;
  deviceId: string;
};

export function parseDevicePublicKey(encoded: string): DeviceIdentity {
  let rawPublicKey: Buffer;
  try {
    rawPublicKey = base64urlDecode(encoded);
  } catch {
    throw new HttpError(400, "invalid_device_public_key", "Device public key must be unpadded base64url.");
  }
  if (rawPublicKey.length !== 32) {
    throw new HttpError(400, "invalid_device_public_key", "Device public key must be a raw 32-byte Ed25519 key.");
  }
  const digest = sha256(rawPublicKey);
  return {
    rawPublicKey,
    publicKeySha256: base64urlEncode(digest),
    deviceId: `dmoft-device-v1-${base64urlEncode(digest.subarray(0, 18))}`,
  };
}

function toEd25519PublicKey(rawPublicKey: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]),
    format: "der",
    type: "spki",
  });
}

export function verifyDeviceSignature(
  rawPublicKey: Uint8Array,
  challenge: string,
  encodedSignature: string,
): boolean {
  let signature: Buffer;
  try {
    signature = base64urlDecode(encodedSignature);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  return verifySignature(null, Buffer.from(challenge, "utf8"), toEd25519PublicKey(rawPublicKey), signature);
}

export type ChallengePurpose = "activate" | "enroll" | "refresh";

export function createChallengeText(input: {
  purpose: ChallengePurpose;
  challengeId?: string;
  deviceId: string;
  deviceKeySha256: string;
  checkoutSessionId?: string;
  expiresAt: number;
  nonce?: string;
}): { challengeId: string; challenge: string } {
  const challengeId = input.challengeId ?? randomUUID();
  const nonce = input.nonce ?? base64urlEncode(randomBytes(32));
  const challenge = [
    "DMOFT-LICENSE-CHALLENGE/1",
    `purpose=${input.purpose}`,
    `challenge_id=${challengeId}`,
    `device_id=${input.deviceId}`,
    `device_key_sha256=${input.deviceKeySha256}`,
    `checkout_session_id=${input.checkoutSessionId ?? "-"}`,
    `nonce=${nonce}`,
    `expires_at=${input.expiresAt}`,
  ].join("\n");
  return { challengeId, challenge };
}
