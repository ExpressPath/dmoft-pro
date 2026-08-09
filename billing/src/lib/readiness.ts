import type { ServerEnv } from "./env";
import { CURRENT_TERMS_VERSION } from "./terms";

export const READINESS_REPORT_VERSION = 1;
export const EXPECTED_MIGRATION_HEAD = "0002_activation_subscription_terms.sql";
export const REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "entitlements.active_entitlement_summary.updated",
]);
export const REQUIRED_LAUNCH_FEATURES = Object.freeze([
  "dmoft_camera_live",
  "dmoft_adaptive_optics",
  "dmoft_devices_3",
  "dmoft_pro",
  "dmoft_offline_grace",
]);
export const FORBIDDEN_LAUNCH_FEATURES = Object.freeze([
  "dmoft_hybrid_transport",
  "dmoft_devices_1",
  "dmoft_devices_10",
  "dmoft_team",
  "dmoft_enterprise",
]);

export type ReadinessCategory =
  | "configuration"
  | "database"
  | "identity"
  | "policy"
  | "stripe";
export type ReadinessStatus = "pass" | "fail";

export interface ReadinessCheck {
  readonly id: string;
  readonly category: ReadinessCategory;
  readonly status: ReadinessStatus;
  readonly summary: string;
  readonly remediation: string;
}

export interface ReadinessReport {
  readonly version: typeof READINESS_REPORT_VERSION;
  readonly generated_at: string;
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
}

export interface StripePriceSnapshot {
  readonly active: boolean;
  readonly livemode: boolean;
  readonly currency: string;
  readonly unitAmount: number | null;
  readonly type: string;
  readonly interval: string | null;
  readonly intervalCount: number | null;
  readonly productId: string;
}

export interface StripeProductSnapshot {
  readonly active: boolean;
  readonly livemode: boolean;
  readonly featureAttachments: readonly {
    readonly lookupKey: string;
    readonly livemode: boolean;
  }[];
}

export interface StripeWebhookSnapshot {
  readonly livemode: boolean;
  readonly status: string;
  readonly url: string;
  readonly enabledEvents: readonly string[];
}

export interface StripePortalSnapshot {
  readonly active: boolean;
  readonly livemode: boolean;
  readonly termsUrl: string | null;
  readonly privacyUrl: string | null;
  readonly invoiceHistoryEnabled: boolean;
  readonly paymentMethodUpdateEnabled: boolean;
  readonly cancellationEnabled: boolean;
  readonly cancellationMode: string;
  readonly subscriptionUpdateEnabled: boolean;
  readonly subscriptionProducts: readonly {
    readonly productId: string;
    readonly priceIds: readonly string[];
  }[];
}

export interface StripeCanarySnapshot {
  readonly livemode: boolean;
  readonly paid: boolean;
  readonly refunded: boolean;
  readonly amount: number;
  readonly amountRefunded: number;
  readonly currency: string;
  readonly status: string;
}

export interface StripeReadinessSnapshot {
  readonly account: {
    readonly chargesEnabled: boolean;
    readonly payoutsEnabled: boolean;
    readonly detailsSubmitted: boolean;
  };
  readonly monthlyPrice: StripePriceSnapshot;
  readonly annualPrice: StripePriceSnapshot;
  readonly product: StripeProductSnapshot;
  readonly webhook: StripeWebhookSnapshot;
  readonly portal: StripePortalSnapshot;
  readonly canary: StripeCanarySnapshot;
}

export interface DatabaseReadinessSnapshot {
  readonly ssl: boolean;
  readonly serverVersionNumber: number;
  readonly appliedMigrations: readonly string[];
}

export interface HttpReadinessSnapshot {
  readonly discoveryIssuer: string;
  readonly discoveryJwksUri: string;
  readonly jwksKeyCount: number;
  readonly jwksContainsPrivateMaterial: boolean;
  readonly termsSha256: string;
  readonly privacyReachable: boolean;
  readonly supportReachable: boolean;
  readonly applicationHealthValid: boolean;
  readonly activeLicenseKeyPublished: boolean;
}

function result(
  condition: boolean,
  id: string,
  category: ReadinessCategory,
  summary: string,
  remediation: string,
): ReadinessCheck {
  return { id, category, status: condition ? "pass" : "fail", summary, remediation };
}

function isHttps(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value) => expected.includes(value));
}

export function assessStaticProductionReadiness(
  env: ServerEnv,
  now: Date = new Date(),
): readonly ReadinessCheck[] {
  const e2eCompletedAt = env.PRODUCTION_E2E_COMPLETED_AT
    ? Date.parse(env.PRODUCTION_E2E_COMPLETED_AT)
    : Number.NaN;
  const e2eAge = now.getTime() - e2eCompletedAt;
  const e2eIsRecent = Number.isFinite(e2eCompletedAt)
    && e2eCompletedAt <= now.getTime() + 5 * 60_000
    && e2eAge <= 30 * 24 * 60 * 60_000;
  const policyUrls = [
    env.PRODUCTION_TERMS_URL,
    env.PRODUCTION_PRIVACY_URL,
    env.PRODUCTION_SUPPORT_URL,
  ];

  return [
    result(
      env.NODE_ENV === "production",
      "configuration.production_mode",
      "configuration",
      "The service runs with NODE_ENV=production.",
      "Set NODE_ENV=production only in the protected production environment.",
    ),
    result(
      env.DATABASE_SSL,
      "configuration.database_tls",
      "configuration",
      "The PostgreSQL client requires certificate-validated TLS.",
      "Set DATABASE_SSL=true and provision a trusted database certificate chain.",
    ),
    result(
      env.STRIPE_SECRET_KEY.startsWith("sk_live_"),
      "configuration.stripe_live_key",
      "configuration",
      "A Stripe live-mode server key is configured.",
      "Inject a restricted live server key through the production secret store.",
    ),
    result(
      env.STRIPE_PRICE_PRO_MONTHLY !== env.STRIPE_PRICE_PRO_ANNUAL,
      "configuration.distinct_prices",
      "configuration",
      "Monthly and annual plans use distinct Price IDs.",
      "Configure the two live recurring Price IDs separately.",
    ),
    result(
      Boolean(
        env.STRIPE_WEBHOOK_ENDPOINT_ID
        && env.STRIPE_PORTAL_CONFIGURATION_ID
        && env.STRIPE_LIVE_CANARY_CHARGE_ID,
      ),
      "configuration.stripe_objects",
      "configuration",
      "Webhook, Portal configuration, and refunded canary identifiers are present.",
      "Record the three live Stripe object IDs after configuring and exercising them.",
    ),
    result(
      Boolean(env.OIDC_DISCOVERY_URL)
        && isHttps(env.OIDC_DISCOVERY_URL)
        && isHttps(env.OIDC_ISSUER)
        && isHttps(env.OIDC_JWKS_URL),
      "configuration.oidc_https",
      "configuration",
      "OIDC issuer, discovery, and JWKS endpoints use HTTPS.",
      "Configure the canonical production OIDC discovery, issuer, and JWKS URLs.",
    ),
    result(
      isHttps(env.APP_BASE_URL) && isHttps(env.LICENSE_ISSUER),
      "configuration.canonical_origins",
      "configuration",
      "Application and license issuer origins use canonical HTTPS URLs.",
      "Set APP_BASE_URL and LICENSE_ISSUER to the deployed HTTPS origins.",
    ),
    result(
      policyUrls.every(isHttps)
        && env.PRODUCTION_TERMS_VERSION === CURRENT_TERMS_VERSION
        && Boolean(env.PRODUCTION_TERMS_SHA256)
        && Boolean(env.LEGAL_APPROVAL_REFERENCE),
      "policy.approval_evidence",
      "policy",
      "Published policy URLs, Terms version/digest, and approval reference are configured.",
      "Publish approved policies, hash the exact Terms response, and record the approval reference.",
    ),
    result(
      Boolean(env.PRODUCTION_E2E_REFERENCE) && e2eIsRecent,
      "configuration.production_e2e_evidence",
      "configuration",
      "A production end-to-end evidence reference was completed within 30 days.",
      "Run the full production canary flow and record its reference and UTC completion time.",
    ),
  ];
}

function validPrice(
  price: StripePriceSnapshot,
  expectedAmount: number,
  expectedInterval: "month" | "year",
): boolean {
  return price.active
    && price.livemode
    && price.currency === "jpy"
    && price.unitAmount === expectedAmount
    && price.type === "recurring"
    && price.interval === expectedInterval
    && price.intervalCount === 1;
}

export function assessStripeReadiness(
  env: ServerEnv,
  snapshot: StripeReadinessSnapshot,
): readonly ReadinessCheck[] {
  const attachedKeys = snapshot.product.featureAttachments.map((item) => item.lookupKey);
  const featuresValid = snapshot.product.featureAttachments.every((item) => item.livemode)
    && REQUIRED_LAUNCH_FEATURES.every((key) => attachedKeys.includes(key))
    && FORBIDDEN_LAUNCH_FEATURES.every((key) => !attachedKeys.includes(key));
  const webhookEventsValid = REQUIRED_WEBHOOK_EVENTS.every(
    (event) => snapshot.webhook.enabledEvents.includes(event)
      || snapshot.webhook.enabledEvents.includes("*"),
  );
  const portalProducts = snapshot.portal.subscriptionProducts;
  const expectedPrices = [env.STRIPE_PRICE_PRO_MONTHLY, env.STRIPE_PRICE_PRO_ANNUAL];
  const portalCatalogValid = portalProducts.length === 1
    && portalProducts[0]?.productId === snapshot.monthlyPrice.productId
    && exactSet(portalProducts[0]?.priceIds ?? [], expectedPrices);

  return [
    result(
      snapshot.account.chargesEnabled
        && snapshot.account.payoutsEnabled
        && snapshot.account.detailsSubmitted,
      "stripe.account_enabled",
      "stripe",
      "The Stripe account is fully submitted and enabled for charges and payouts.",
      "Complete Stripe account verification, capability, and payout setup.",
    ),
    result(
      validPrice(snapshot.monthlyPrice, 1_980, "month")
        && validPrice(snapshot.annualPrice, 19_800, "year")
        && snapshot.monthlyPrice.productId === snapshot.annualPrice.productId,
      "stripe.launch_prices",
      "stripe",
      "The live monthly and annual JPY Prices match the launch contract.",
      "Use active recurring JPY 1,980/month and JPY 19,800/year Prices on one Product.",
    ),
    result(
      snapshot.product.active && snapshot.product.livemode && featuresValid,
      "stripe.product_entitlements",
      "stripe",
      "The live Product carries required launch features and no roadmap features.",
      "Correct the Product's Entitlements feature attachments before selling it.",
    ),
    result(
      snapshot.webhook.livemode
        && snapshot.webhook.status === "enabled"
        && snapshot.webhook.url === `${env.APP_BASE_URL}/api/v1/webhooks/stripe`
        && webhookEventsValid,
      "stripe.webhook",
      "stripe",
      "The live webhook endpoint, URL, status, and event set are correct.",
      "Enable the configured live endpoint at the canonical URL with every required event.",
    ),
    result(
      snapshot.portal.active
        && snapshot.portal.livemode
        && snapshot.portal.termsUrl === env.PRODUCTION_TERMS_URL
        && snapshot.portal.privacyUrl === env.PRODUCTION_PRIVACY_URL
        && snapshot.portal.invoiceHistoryEnabled
        && snapshot.portal.paymentMethodUpdateEnabled
        && snapshot.portal.cancellationEnabled
        && snapshot.portal.cancellationMode === "at_period_end"
        && snapshot.portal.subscriptionUpdateEnabled
        && portalCatalogValid,
      "stripe.customer_portal",
      "stripe",
      "The live Portal exposes policy links, billing controls, and only launch Prices.",
      "Activate the configured Portal and restrict subscription updates to the launch Product/Prices.",
    ),
    result(
      snapshot.canary.livemode
        && snapshot.canary.paid
        && snapshot.canary.status === "succeeded"
        && snapshot.canary.currency === "jpy"
        && snapshot.canary.amount > 0
        && snapshot.canary.refunded
        && snapshot.canary.amountRefunded === snapshot.canary.amount,
      "stripe.refunded_live_canary",
      "stripe",
      "The named live canary charge succeeded and was fully refunded.",
      "Complete and fully refund one low-value live canary through the real product flow.",
    ),
  ];
}

export function assessDatabaseReadiness(
  snapshot: DatabaseReadinessSnapshot,
): readonly ReadinessCheck[] {
  return [
    result(
      snapshot.ssl,
      "database.tls_connection",
      "database",
      "The active PostgreSQL connection uses TLS.",
      "Require TLS on the database service and application connection.",
    ),
    result(
      snapshot.serverVersionNumber >= 150_000,
      "database.supported_version",
      "database",
      "PostgreSQL is version 15 or newer.",
      "Upgrade the production database to PostgreSQL 15 or newer.",
    ),
    result(
      snapshot.appliedMigrations.includes(EXPECTED_MIGRATION_HEAD),
      "database.migration_head",
      "database",
      "The expected schema migration head is recorded.",
      `Run immutable migrations through ${EXPECTED_MIGRATION_HEAD} before serving traffic.`,
    ),
  ];
}

export function assessHttpReadiness(
  env: ServerEnv,
  snapshot: HttpReadinessSnapshot,
): readonly ReadinessCheck[] {
  return [
    result(
      snapshot.applicationHealthValid && snapshot.activeLicenseKeyPublished,
      "configuration.deployed_origin",
      "configuration",
      "The canonical application origin is healthy and publishes the active license key.",
      "Deploy the release at APP_BASE_URL and publish the matching active verification key.",
    ),
    result(
      snapshot.discoveryIssuer === env.OIDC_ISSUER
        && snapshot.discoveryJwksUri === env.OIDC_JWKS_URL
        && snapshot.jwksKeyCount > 0
        && !snapshot.jwksContainsPrivateMaterial,
      "identity.discovery_and_jwks",
      "identity",
      "OIDC discovery binds the exact issuer/JWKS and exposes public keys only.",
      "Correct the discovery document/JWKS and rotate any endpoint exposing private key material.",
    ),
    result(
      snapshot.termsSha256 === env.PRODUCTION_TERMS_SHA256,
      "policy.published_terms_digest",
      "policy",
      "Published Terms bytes match the approved SHA-256.",
      "Publish the approved immutable Terms or update evidence through the approval process.",
    ),
    result(
      snapshot.privacyReachable && snapshot.supportReachable,
      "policy.public_endpoints",
      "policy",
      "Privacy and support pages are directly reachable over HTTPS.",
      "Publish stable, redirect-free privacy and support pages before launch.",
    ),
  ];
}

export function failedProbeCheck(
  category: ReadinessCategory,
  id: string,
  summary: string,
  remediation: string,
): ReadinessCheck {
  return result(false, id, category, summary, remediation);
}

export function createReadinessReport(
  checks: readonly ReadinessCheck[],
  generatedAt: Date = new Date(),
): ReadinessReport {
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error(`Duplicate readiness check ID: ${check.id}`);
    ids.add(check.id);
  }
  return {
    version: READINESS_REPORT_VERSION,
    generated_at: generatedAt.toISOString(),
    ready: checks.length > 0 && checks.every((check) => check.status === "pass"),
    checks: [...checks],
  };
}
