import { createHash } from "node:crypto";

export function base64urlEncode(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

export function base64urlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.includes("=")) {
    throw new Error("Expected unpadded base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Expected canonical unpadded base64url");
  }
  return decoded;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON cannot encode non-finite numbers");
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: Uint8Array | string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = sha256(left);
  const rightDigest = sha256(right);
  return leftDigest.equals(rightDigest);
}
