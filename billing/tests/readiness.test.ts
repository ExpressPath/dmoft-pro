import { createHash, generateKeyPairSync } from "node:crypto";
import type Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnv, resetEnvCacheForTests, type ServerEnv } from "../src/lib/env";
import { buildPublicKeyset } from "../src/lib/license";
import {
  assessDatabaseReadiness,
  assessHttpReadiness,
  assessStaticProductionReadiness,
  assessStripeReadiness,
  createReadinessReport,
  REQUIRED_LAUNCH_FEATURES,
  REQUIRED_WEBHOOK_EVENTS,
  type StripeReadinessSnapshot,
} from "../src/lib/readiness";
import {
  collectHttpReadinessSnapshot,
  runProductionReadiness,
} from "../src/lib/readiness-probes";
import { CURRENT_TERMS_VERSION } from "../src/lib/terms";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function productionEnv(): ServerEnv {
  const pair = generateKeyPairSync("ed25519");
  const values: Record<string, string> = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://billing.example.test/dmoft",
    DATABASE_SSL: "true",
    STRIPE_SECRET_KEY: "sk_live_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PRICE_PRO_MONTHLY: "price_live_monthly",
    STRIPE_PRICE_PRO_ANNUAL: "price_live_annual",
    STRIPE_WEBHOOK_ENDPOINT_ID: "we_live_fixture",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_live_fixture",
    STRIPE_LIVE_CANARY_CHARGE_ID: "ch_live_fixture",
    OIDC_ISSUER: "https://identity.example.test/",
    OIDC_AUDIENCE: "dmoft-production",
    OIDC_JWKS_URL: "https://identity.example.test/jwks",
    OIDC_DISCOVERY_URL: "https://identity.example.test/.well-known/openid-configuration",
    APP_BASE_URL: "https://billing.example.test",
    LICENSE_ISSUER: "https://licenses.example.test",
    LICENSE_KEY_ID: "dmoft-production-2026-01",
    LICENSE_ED25519_PRIVATE_KEY_PEM: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    LICENSE_ED25519_PUBLIC_KEY_PEM: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    PRODUCTION_TERMS_URL: "https://www.example.test/legal/terms/2026-08-09",
    PRODUCTION_PRIVACY_URL: "https://www.example.test/legal/privacy",
    PRODUCTION_SUPPORT_URL: "https://www.example.test/support",
    PRODUCTION_TERMS_VERSION: CURRENT_TERMS_VERSION,
    PRODUCTION_TERMS_SHA256: "ab".repeat(32),
    LEGAL_APPROVAL_REFERENCE: "legal-approval-2026-08-09",
    PRODUCTION_E2E_REFERENCE: "release-evidence-2026-08-09",
    PRODUCTION_E2E_COMPLETED_AT: NOW.toISOString(),
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  resetEnvCacheForTests();
  return getEnv();
}

function stripeSnapshot(env: ServerEnv): StripeReadinessSnapshot {
  const productId = "prod_live_fixture";
  return {
    account: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    monthlyPrice: {
      active: true,
      livemode: true,
      currency: "jpy",
      unitAmount: 1_980,
      type: "recurring",
      interval: "month",
      intervalCount: 1,
      productId,
    },
    annualPrice: {
      active: true,
      livemode: true,
      currency: "jpy",
      unitAmount: 19_800,
      type: "recurring",
      interval: "year",
      intervalCount: 1,
      productId,
    },
    product: {
      active: true,
      livemode: true,
      featureAttachments: REQUIRED_LAUNCH_FEATURES.map((lookupKey) => ({
        lookupKey,
        livemode: true,
      })),
    },
    webhook: {
      livemode: true,
      status: "enabled",
      url: `${env.APP_BASE_URL}/api/v1/webhooks/stripe`,
      enabledEvents: REQUIRED_WEBHOOK_EVENTS,
    },
    portal: {
      active: true,
      livemode: true,
      termsUrl: env.PRODUCTION_TERMS_URL ?? null,
      privacyUrl: env.PRODUCTION_PRIVACY_URL ?? null,
      invoiceHistoryEnabled: true,
      paymentMethodUpdateEnabled: true,
      cancellationEnabled: true,
      cancellationMode: "at_period_end",
      subscriptionUpdateEnabled: true,
      subscriptionProducts: [{
        productId,
        priceIds: [env.STRIPE_PRICE_PRO_MONTHLY, env.STRIPE_PRICE_PRO_ANNUAL],
      }],
    },
    canary: {
      livemode: true,
      paid: true,
      refunded: true,
      amount: 100,
      amountRefunded: 100,
      currency: "jpy",
      status: "succeeded",
    },
  };
}

describe.sequential("production readiness gates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  it("passes complete static production evidence", () => {
    const checks = assessStaticProductionReadiness(productionEnv(), NOW);
    expect(checks.every((check) => check.status === "pass")).toBe(true);
    expect(createReadinessReport(checks, NOW).ready).toBe(true);
  });

  it("fails closed for test keys, missing policy evidence, and stale E2E evidence", () => {
    const env = {
      ...productionEnv(),
      STRIPE_SECRET_KEY: "sk_test_fixture",
      PRODUCTION_TERMS_URL: undefined,
      LEGAL_APPROVAL_REFERENCE: undefined,
      PRODUCTION_E2E_COMPLETED_AT: "2026-01-01T00:00:00.000Z",
    };
    const failedIds = assessStaticProductionReadiness(env, NOW)
      .filter((check) => check.status === "fail")
      .map((check) => check.id);
    expect(failedIds).toContain("configuration.stripe_live_key");
    expect(failedIds).toContain("policy.approval_evidence");
    expect(failedIds).toContain("configuration.production_e2e_evidence");
  });

  it("validates the exact live Stripe launch catalog and rejects a roadmap feature", () => {
    const env = productionEnv();
    const passing = stripeSnapshot(env);
    expect(assessStripeReadiness(env, passing).every((check) => check.status === "pass")).toBe(true);

    const invalid = {
      ...passing,
      product: {
        ...passing.product,
        featureAttachments: [
          ...passing.product.featureAttachments,
          { lookupKey: "dmoft_hybrid_transport", livemode: true },
        ],
      },
    };
    expect(assessStripeReadiness(env, invalid).find(
      (check) => check.id === "stripe.product_entitlements",
    )?.status).toBe("fail");
  });

  it("validates database, OIDC, and policy snapshots independently", () => {
    const env = productionEnv();
    const database = assessDatabaseReadiness({
      ssl: true,
      serverVersionNumber: 150_005,
      appliedMigrations: ["0001_initial.sql", "0002_activation_subscription_terms.sql"],
    });
    const http = assessHttpReadiness(env, {
      discoveryIssuer: env.OIDC_ISSUER,
      discoveryJwksUri: env.OIDC_JWKS_URL,
      jwksKeyCount: 1,
      jwksContainsPrivateMaterial: false,
      termsSha256: env.PRODUCTION_TERMS_SHA256 ?? "",
      privacyReachable: true,
      supportReachable: true,
      applicationHealthValid: true,
      activeLicenseKeyPublished: true,
    });
    expect([...database, ...http].every((check) => check.status === "pass")).toBe(true);
  });

  it("collects the deployed origin, public keyset, identity, and policy without redirects", async () => {
    const base = productionEnv();
    const terms = "approved production terms";
    const env = {
      ...base,
      PRODUCTION_TERMS_SHA256: createHash("sha256").update(terms).digest("hex"),
    };
    const keyset = buildPublicKeyset({
      keyId: env.LICENSE_KEY_ID,
      publicKeyPem: env.LICENSE_ED25519_PUBLIC_KEY_PEM,
    });
    const documents = new Map<string, string>([
      [env.OIDC_DISCOVERY_URL ?? "", JSON.stringify({
        issuer: env.OIDC_ISSUER,
        jwks_uri: env.OIDC_JWKS_URL,
      })],
      [env.OIDC_JWKS_URL, JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "x" }] })],
      [env.PRODUCTION_TERMS_URL ?? "", terms],
      [env.PRODUCTION_PRIVACY_URL ?? "", "privacy"],
      [env.PRODUCTION_SUPPORT_URL ?? "", "support"],
      [`${env.APP_BASE_URL}/api/health`, JSON.stringify({
        status: "ok",
        service: "dmoft-pro-billing",
        version: "0.2.0",
      })],
      [`${env.APP_BASE_URL}/api/v1/licenses/keyset`, JSON.stringify(keyset)],
    ]);
    const fetcher: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      const body = documents.get(url);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { status: 200 });
    };

    const snapshot = await collectHttpReadinessSnapshot(env, fetcher);
    expect(assessHttpReadiness(env, snapshot).every((check) => check.status === "pass")).toBe(true);
  });

  it("turns unavailable external probes into non-secret failures", async () => {
    const env = productionEnv();
    const stripe = new Proxy({}, {
      get() {
        throw new Error(`must not leak ${env.STRIPE_SECRET_KEY}`);
      },
    }) as Stripe;
    const report = await runProductionReadiness(env, {
      stripe,
      query: async () => {
        throw new Error(`must not leak ${env.DATABASE_URL}`);
      },
      fetcher: async () => {
        throw new Error(`must not leak ${env.OIDC_JWKS_URL}`);
      },
    }, NOW);
    const encoded = JSON.stringify(report);
    expect(report.ready).toBe(false);
    expect(report.checks.filter((check) => check.id.endsWith("remote_probe"))).toHaveLength(3);
    expect(encoded).not.toContain(env.STRIPE_SECRET_KEY);
    expect(encoded).not.toContain(env.DATABASE_URL);
  });
});
