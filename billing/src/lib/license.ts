import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";
import { base64urlDecode, base64urlEncode, canonicalJson } from "./encoding";

export const canonicalEntitlementSchema = z.enum([
  "camera.live",
  "optics.adaptive",
  "transport.hybrid",
]);

const licenseKeyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const licenseHeaderSchema = z.object({
  alg: z.literal("EdDSA"),
  kid: licenseKeyIdSchema,
  typ: z.literal("DMOFT-LICENSE"),
  v: z.literal(1),
}).strict();

export const licenseClaimsSchema = z.object({
  v: z.literal(1),
  iss: z.string().url().max(256),
  aud: z.literal("dmoft-pro"),
  sub: z.string().startsWith("cus_"),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  grace_until: z.number().int().positive(),
  tier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  entitlements: z.array(canonicalEntitlementSchema).max(3).refine(
    (items) => items.every((item, index) => index === 0 || items[index - 1] < item),
    "Entitlements must be sorted and unique",
  ),
  device_id: z.string().startsWith("dmoft-device-v1-"),
  device_key_sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  subscription_id: z.string().startsWith("sub_"),
}).strict().superRefine((claims, context) => {
  if (claims.nbf > claims.iat) {
    context.addIssue({ code: "custom", path: ["nbf"], message: "nbf must not exceed iat" });
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 30 * 86_400) {
    context.addIssue({ code: "custom", path: ["exp"], message: "exp must be after iat and within 30 days" });
  }
  if (claims.grace_until < claims.exp || claims.grace_until - claims.exp > 7 * 86_400) {
    context.addIssue({ code: "custom", path: ["grace_until"], message: "grace must be between zero and seven days" });
  }
});

export type LicenseClaims = z.infer<typeof licenseClaimsSchema>;
export type LicenseHeader = z.infer<typeof licenseHeaderSchema>;

export function issueLicenseToken(input: {
  privateKeyPem: string;
  keyId: string;
  claims: Omit<LicenseClaims, "jti"> & { jti?: string };
}): { token: string; claims: LicenseClaims } {
  const header = licenseHeaderSchema.parse({ alg: "EdDSA", kid: input.keyId, typ: "DMOFT-LICENSE", v: 1 });
  const claims = licenseClaimsSchema.parse({ ...input.claims, jti: input.claims.jti ?? randomUUID() });
  if (claims.exp - claims.iat > 30 * 86_400) throw new Error("License lifetime exceeds 30 days");
  if (claims.grace_until < claims.exp || claims.grace_until - claims.exp > 7 * 86_400) {
    throw new Error("License grace period is outside policy bounds");
  }
  const encodedHeader = base64urlEncode(canonicalJson(header));
  const encodedClaims = base64urlEncode(canonicalJson(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), createPrivateKey(input.privateKeyPem));
  return { token: `${signingInput}.${base64urlEncode(signature)}`, claims };
}

export function verifyLicenseToken(token: string, publicKeyPem: string): LicenseClaims {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Malformed compact license token");
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  const header = licenseHeaderSchema.parse(JSON.parse(base64urlDecode(encodedHeader).toString("utf8")));
  const claims = licenseClaimsSchema.parse(JSON.parse(base64urlDecode(encodedClaims).toString("utf8")));
  if (base64urlEncode(canonicalJson(header)) !== encodedHeader || base64urlEncode(canonicalJson(claims)) !== encodedClaims) {
    throw new Error("License token JSON is not canonical");
  }
  const signature = base64urlDecode(encodedSignature);
  if (signature.length !== 64 || !verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
    createPublicKey(publicKeyPem),
    signature,
  )) {
    throw new Error("Invalid license signature");
  }
  if (header.alg !== "EdDSA") throw new Error("Unexpected license algorithm");
  return claims;
}

const keysetSchema = z.object({
  v: z.literal(1),
  keys: z.array(z.object({
    kid: licenseKeyIdSchema,
    alg: z.literal("EdDSA"),
    public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict()).min(1),
}).strict().refine(
  (keyset) => new Set(keyset.keys.map((key) => key.kid)).size === keyset.keys.length,
  "License key IDs must be unique",
);

export type PublicLicenseKeyset = z.infer<typeof keysetSchema>;

function rawEd25519PublicKey(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  if (der.length !== 44 || der.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") {
    throw new Error("License public key is not Ed25519 SubjectPublicKeyInfo");
  }
  return base64urlEncode(der.subarray(12));
}

export function buildPublicKeyset(input: {
  keyId: string;
  publicKeyPem: string;
  configuredJson?: string;
}): PublicLicenseKeyset {
  const current = {
    kid: input.keyId,
    alg: "EdDSA" as const,
    public_key: rawEd25519PublicKey(input.publicKeyPem),
  };
  if (!input.configuredJson) return { v: 1, keys: [current] };
  const parsed = keysetSchema.parse(JSON.parse(input.configuredJson));
  const configuredCurrent = parsed.keys.find((key) => key.kid === current.kid);
  if (!configuredCurrent || configuredCurrent.public_key !== current.public_key) {
    throw new Error("Configured license keyset does not contain the active signing key");
  }
  return parsed;
}
