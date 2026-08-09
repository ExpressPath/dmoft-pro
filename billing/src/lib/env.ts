import { z } from "zod";
import { createPrivateKey, createPublicKey } from "node:crypto";

const booleanFromString = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() === "true" : value),
  z.boolean(),
);

const entitlementPolicySchema = z.object({
  lookupToEntitlement: z.record(z.string().min(1), z.enum(["camera.live", "optics.adaptive", "transport.hybrid"])),
  deviceLimitByLookup: z.record(z.string().min(1), z.number().int().min(1).max(100)),
  tierByLookup: z.record(z.string().min(1), z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)),
  offlineGraceLookupKeys: z.array(z.string().min(1)),
}).strict();

export type EntitlementPolicyConfig = z.infer<typeof entitlementPolicySchema>;

const defaultEntitlementPolicy: EntitlementPolicyConfig = {
  lookupToEntitlement: {
    dmoft_camera_live: "camera.live",
    dmoft_adaptive_optics: "optics.adaptive",
    dmoft_hybrid_transport: "transport.hybrid",
  },
  deviceLimitByLookup: {
    dmoft_devices_1: 1,
    dmoft_devices_3: 3,
    dmoft_devices_10: 10,
  },
  tierByLookup: {
    dmoft_pro: "pro",
    dmoft_team: "team",
    dmoft_enterprise: "enterprise",
  },
  offlineGraceLookupKeys: ["dmoft_offline_grace"],
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanFromString.default(false),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_PRICE_PRO_MONTHLY: z.string().startsWith("price_"),
  STRIPE_PRICE_PRO_ANNUAL: z.string().startsWith("price_"),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URL: z.string().url(),
  APP_BASE_URL: z.string().url(),
  LICENSE_ISSUER: z.string().url().max(256),
  LICENSE_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  LICENSE_ED25519_PRIVATE_KEY_PEM: z.string().includes("PRIVATE KEY"),
  LICENSE_ED25519_PUBLIC_KEY_PEM: z.string().includes("PUBLIC KEY"),
  LICENSE_PUBLIC_KEYSET_JSON: z.string().optional(),
  LICENSE_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(30),
  LICENSE_REFRESH_AFTER_DAYS: z.coerce.number().int().min(1).max(29).default(7),
  OFFLINE_GRACE_DAYS: z.coerce.number().int().min(0).max(7).default(7),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  ENTITLEMENT_POLICY_JSON: z.string().optional(),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().min(1).max(10_000).default(60),
  WEBHOOK_MAX_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),
}).superRefine((value, context) => {
  for (const field of ["APP_BASE_URL", "OIDC_ISSUER", "OIDC_JWKS_URL", "LICENSE_ISSUER"] as const) {
    const url = new URL(value[field]);
    if (url.protocol === "https:") continue;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (value.NODE_ENV === "production" || url.protocol !== "http:" || !loopback) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Must use HTTPS; loopback HTTP is allowed only outside production",
      });
    }
  }
});

export type ServerEnv = z.infer<typeof envSchema> & { entitlementPolicy: EntitlementPolicyConfig };

let cached: ServerEnv | undefined;

function unescapePem(value: string): string {
  return value.replaceAll("\\n", "\n");
}

export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.parse(process.env);
  const privatePem = unescapePem(parsed.LICENSE_ED25519_PRIVATE_KEY_PEM);
  const publicPem = unescapePem(parsed.LICENSE_ED25519_PUBLIC_KEY_PEM);
  const derivedPublic = createPublicKey(createPrivateKey(privatePem)).export({ format: "der", type: "spki" });
  const configuredPublic = createPublicKey(publicPem).export({ format: "der", type: "spki" });
  if (!Buffer.from(derivedPublic).equals(Buffer.from(configuredPublic))) {
    throw new Error("Configured Ed25519 license private and public keys do not match");
  }
  const policy = parsed.ENTITLEMENT_POLICY_JSON
    ? entitlementPolicySchema.parse(JSON.parse(parsed.ENTITLEMENT_POLICY_JSON))
    : defaultEntitlementPolicy;
  cached = {
    ...parsed,
    LICENSE_ED25519_PRIVATE_KEY_PEM: privatePem,
    LICENSE_ED25519_PUBLIC_KEY_PEM: publicPem,
    entitlementPolicy: policy,
  };
  return cached;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
}
