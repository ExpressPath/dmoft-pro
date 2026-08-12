import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { ServerEnv } from "./env";
import { buildPublicKeyset } from "./license";
import {
  assessDatabaseReadiness,
  assessHttpReadiness,
  assessStaticProductionReadiness,
  assessStripeReadiness,
  createReadinessReport,
  failedProbeCheck,
  type DatabaseReadinessSnapshot,
  type HttpReadinessSnapshot,
  type ReadinessCheck,
  type ReadinessReport,
  type StripePriceSnapshot,
  type StripeReadinessSnapshot,
} from "./readiness";

const MAXIMUM_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_JSON_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MILLISECONDS = 10_000;

export type ReadinessQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<{ rows: readonly Record<string, unknown>[] }>;

export interface ProductionReadinessDependencies {
  readonly stripe: Stripe;
  readonly query: ReadinessQuery;
  readonly fetcher?: typeof fetch;
}

function objectId(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

function priceSnapshot(price: Stripe.Price): StripePriceSnapshot {
  return {
    active: price.active,
    livemode: price.livemode,
    currency: price.currency,
    unitAmount: price.unit_amount,
    type: price.type,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    productId: objectId(price.product),
  };
}

export async function collectStripeReadinessSnapshot(
  env: ServerEnv,
  stripe: Stripe,
): Promise<StripeReadinessSnapshot> {
  if (
    !env.STRIPE_WEBHOOK_ENDPOINT_ID
    || !env.STRIPE_PORTAL_CONFIGURATION_ID
    || !env.STRIPE_LIVE_CANARY_CHARGE_ID
  ) {
    throw new Error("Required live Stripe object identifiers are not configured");
  }
  const [account, monthlyPrice, annualPrice, webhook, portal, canary] = await Promise.all([
    stripe.accounts.retrieve(null),
    stripe.prices.retrieve(env.STRIPE_PRICE_PRO_MONTHLY),
    stripe.prices.retrieve(env.STRIPE_PRICE_PRO_ANNUAL),
    stripe.webhookEndpoints.retrieve(env.STRIPE_WEBHOOK_ENDPOINT_ID),
    stripe.billingPortal.configurations.retrieve(env.STRIPE_PORTAL_CONFIGURATION_ID),
    stripe.charges.retrieve(env.STRIPE_LIVE_CANARY_CHARGE_ID),
  ]);
  const monthlyProductId = objectId(monthlyPrice.product);
  const [product, featurePage] = await Promise.all([
    stripe.products.retrieve(monthlyProductId),
    stripe.products.listFeatures(monthlyProductId, { limit: 100 }),
  ]);
  if (featurePage.has_more) {
    throw new Error("Launch Product has more than 100 entitlement feature attachments");
  }

  return {
    account: {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    },
    monthlyPrice: priceSnapshot(monthlyPrice),
    annualPrice: priceSnapshot(annualPrice),
    product: {
      active: product.active,
      livemode: product.livemode,
      featureAttachments: featurePage.data.map((attachment) => ({
        lookupKey: attachment.entitlement_feature.lookup_key,
        livemode: attachment.livemode,
      })),
    },
    webhook: {
      livemode: webhook.livemode,
      status: webhook.status,
      url: webhook.url,
      enabledEvents: webhook.enabled_events,
    },
    portal: {
      active: portal.active,
      livemode: portal.livemode,
      termsUrl: portal.business_profile.terms_of_service_url,
      privacyUrl: portal.business_profile.privacy_policy_url,
      invoiceHistoryEnabled: portal.features.invoice_history.enabled,
      paymentMethodUpdateEnabled: portal.features.payment_method_update.enabled,
      cancellationEnabled: portal.features.subscription_cancel.enabled,
      cancellationMode: portal.features.subscription_cancel.mode,
      subscriptionUpdateEnabled: portal.features.subscription_update.enabled,
      subscriptionProducts: (portal.features.subscription_update.products ?? []).map((item) => ({
        productId: item.product,
        priceIds: item.prices,
      })),
    },
    canary: {
      livemode: canary.livemode,
      paid: canary.paid,
      refunded: canary.refunded,
      amount: canary.amount,
      amountRefunded: canary.amount_refunded,
      currency: canary.currency,
      status: canary.status,
    },
  };
}

export async function collectDatabaseReadinessSnapshot(
  query: ReadinessQuery,
): Promise<DatabaseReadinessSnapshot> {
  const connection = await query(`SELECT
    current_setting('server_version_num')::integer AS server_version_number,
    COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl`);
  const migrations = await query("SELECT name FROM schema_migrations ORDER BY name");
  const row = connection.rows[0];
  if (!row || typeof row.server_version_number !== "number" || typeof row.ssl !== "boolean") {
    throw new Error("PostgreSQL readiness query returned an invalid shape");
  }
  const appliedMigrations = migrations.rows.map((migration) => {
    if (typeof migration.name !== "string") {
      throw new Error("PostgreSQL migration query returned an invalid shape");
    }
    return migration.name;
  });
  return {
    ssl: row.ssl,
    serverVersionNumber: row.server_version_number,
    appliedMigrations,
  };
}

async function fetchBytes(
  fetcher: typeof fetch,
  url: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
    redirect: "error",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) throw new Error(`Readiness endpoint returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumBytes) throw new Error("Readiness endpoint body is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("Readiness endpoint body is too large");
  return bytes;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Readiness JSON endpoint did not return an object");
  }
  return parsed as Record<string, unknown>;
}

export async function collectHttpReadinessSnapshot(
  env: ServerEnv,
  fetcher: typeof fetch = fetch,
): Promise<HttpReadinessSnapshot> {
  if (
    !env.OIDC_DISCOVERY_URL
    || !env.PRODUCTION_TERMS_URL
    || !env.PRODUCTION_PRIVACY_URL
    || !env.PRODUCTION_SUPPORT_URL
  ) {
    throw new Error("Required identity or policy endpoint is not configured");
  }
  const responses = await Promise.all([
    fetchBytes(fetcher, env.OIDC_DISCOVERY_URL, MAXIMUM_JSON_BYTES),
    fetchBytes(fetcher, env.OIDC_JWKS_URL, MAXIMUM_JSON_BYTES),
    fetchBytes(fetcher, env.PRODUCTION_TERMS_URL, MAXIMUM_DOCUMENT_BYTES),
    fetchBytes(fetcher, env.PRODUCTION_PRIVACY_URL, MAXIMUM_DOCUMENT_BYTES),
    fetchBytes(fetcher, env.PRODUCTION_SUPPORT_URL, MAXIMUM_DOCUMENT_BYTES),
    fetchBytes(fetcher, `${env.APP_BASE_URL}/api/health`, MAXIMUM_JSON_BYTES),
    fetchBytes(
      fetcher,
      `${env.APP_BASE_URL}/api/v1/licenses/keyset`,
      MAXIMUM_JSON_BYTES,
    ),
  ]);
  const [discoveryBytes, jwksBytes, termsBytes, , , healthBytes, keysetBytes] = responses;
  const discovery = parseJsonObject(discoveryBytes);
  const jwks = parseJsonObject(jwksBytes);
  const health = parseJsonObject(healthBytes);
  const publishedKeyset = parseJsonObject(keysetBytes);
  const keys = jwks.keys;
  if (!Array.isArray(keys)) throw new Error("OIDC JWKS does not contain a keys array");
  const privateMembers = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);
  const containsPrivateMaterial = keys.some(
    (key) => key
      && typeof key === "object"
      && !Array.isArray(key)
      && Object.keys(key).some((member) => privateMembers.has(member)),
  );
  if (typeof discovery.issuer !== "string" || typeof discovery.jwks_uri !== "string") {
    throw new Error("OIDC discovery document is missing issuer or jwks_uri");
  }
  const expectedKeyset = buildPublicKeyset({
    keyId: env.LICENSE_KEY_ID,
    publicKeyPem: env.LICENSE_ED25519_PUBLIC_KEY_PEM,
    configuredJson: env.LICENSE_PUBLIC_KEYSET_JSON,
  });
  const publishedKeys = Array.isArray(publishedKeyset.keys) ? publishedKeyset.keys : [];
  const expectedActiveKey = expectedKeyset.keys.find((key) => key.kid === env.LICENSE_KEY_ID);
  const activeLicenseKeyPublished = Boolean(expectedActiveKey) && publishedKeys.some(
    (key) => key
      && typeof key === "object"
      && !Array.isArray(key)
      && (key as Record<string, unknown>).kid === expectedActiveKey?.kid
      && (key as Record<string, unknown>).alg === expectedActiveKey?.alg
      && (key as Record<string, unknown>).public_key === expectedActiveKey?.public_key,
  );
  return {
    discoveryIssuer: discovery.issuer,
    discoveryJwksUri: discovery.jwks_uri,
    jwksKeyCount: keys.length,
    jwksContainsPrivateMaterial: containsPrivateMaterial,
    termsSha256: createHash("sha256").update(termsBytes).digest("hex"),
    privacyReachable: true,
    supportReachable: true,
    applicationHealthValid: health.status === "ok"
      && health.service === "dmoft-pro-billing"
      && health.version === "0.2.0",
    activeLicenseKeyPublished,
  };
}

export async function runProductionReadiness(
  env: ServerEnv,
  dependencies: ProductionReadinessDependencies,
  now: Date = new Date(),
): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [...assessStaticProductionReadiness(env, now)];
  const [stripeResult, databaseResult, httpResult] = await Promise.allSettled([
    collectStripeReadinessSnapshot(env, dependencies.stripe),
    collectDatabaseReadinessSnapshot(dependencies.query),
    collectHttpReadinessSnapshot(env, dependencies.fetcher),
  ]);

  if (stripeResult.status === "fulfilled") {
    checks.push(...assessStripeReadiness(env, stripeResult.value));
  } else {
    checks.push(failedProbeCheck(
      "stripe",
      "stripe.remote_probe",
      "The read-only Stripe production probe completed.",
      "Verify live credentials, object identifiers, API access, and Stripe availability, then rerun.",
    ));
  }
  if (databaseResult.status === "fulfilled") {
    checks.push(...assessDatabaseReadiness(databaseResult.value));
  } else {
    checks.push(failedProbeCheck(
      "database",
      "database.remote_probe",
      "The read-only PostgreSQL production probe completed.",
      "Verify the TLS database connection and migrations, then rerun.",
    ));
  }
  if (httpResult.status === "fulfilled") {
    checks.push(...assessHttpReadiness(env, httpResult.value));
  } else {
    checks.push(failedProbeCheck(
      "identity",
      "identity_and_policy.remote_probe",
      "OIDC and public policy endpoints were retrieved and validated.",
      "Verify direct HTTPS reachability, response limits, discovery/JWKS, and policy URLs.",
    ));
  }
  return createReadinessReport(checks, now);
}
