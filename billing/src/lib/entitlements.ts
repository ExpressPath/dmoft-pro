import { getEnv, type EntitlementPolicyConfig } from "./env";
import { HttpError } from "./errors";
import { getPool } from "./db";
import type { LicenseClaims } from "./license";
import type { PoolClient } from "pg";
import { CURRENT_TERMS_VERSION } from "./terms";

export type ProjectedEntitlements = {
  entitlements: LicenseClaims["entitlements"];
  deviceLimit: number;
  tier: string;
  offlineGracePermitted: boolean;
};

const tierPriority: Record<string, number> = { pro: 10, team: 20, enterprise: 30 };

export function projectEntitlements(
  lookupKeys: readonly string[],
  policy: EntitlementPolicyConfig = getEnv().entitlementPolicy,
): ProjectedEntitlements {
  const active = new Set(lookupKeys);
  const entitlements = [...new Set(
    Object.entries(policy.lookupToEntitlement)
      .filter(([lookup]) => active.has(lookup))
      .map(([, entitlement]) => entitlement),
  )].sort() as LicenseClaims["entitlements"];
  const deviceLimit = Math.max(
    0,
    ...Object.entries(policy.deviceLimitByLookup)
      .filter(([lookup]) => active.has(lookup))
      .map(([, value]) => value),
  );
  const tiers = Object.entries(policy.tierByLookup)
    .filter(([lookup]) => active.has(lookup))
    .map(([, tier]) => tier)
    .sort((left, right) => (tierPriority[right] ?? 0) - (tierPriority[left] ?? 0) || left.localeCompare(right));
  return {
    entitlements,
    deviceLimit,
    tier: tiers[0] ?? "none",
    offlineGracePermitted: policy.offlineGraceLookupKeys.some((lookup) => active.has(lookup)),
  };
}

export type LicenseContext = ProjectedEntitlements & {
  accountId: string;
  stripeCustomerId: string;
  subscriptionId: string;
  currentPeriodEnd: Date | null;
};

export async function getLicenseContext(
  stripeCustomerId: string,
  preferredSubscriptionId?: string,
  client?: Pick<PoolClient, "query">,
  policy?: EntitlementPolicyConfig,
): Promise<LicenseContext> {
  const database = client ?? getPool();
  const accountResult = await database.query<{ id: string }>(
    "SELECT id FROM accounts WHERE stripe_customer_id = $1",
    [stripeCustomerId],
  );
  const account = accountResult.rows[0];
  if (!account) throw new HttpError(403, "customer_not_linked", "Stripe customer is not linked to an account.");
  const entitlementResult = await database.query<{ lookup_key: string }>(
    "SELECT lookup_key FROM stripe_entitlements WHERE stripe_customer_id = $1 ORDER BY lookup_key",
    [stripeCustomerId],
  );
  const projected = projectEntitlements(
    entitlementResult.rows.map((row) => row.lookup_key),
    policy,
  );
  if (projected.deviceLimit < 1 || projected.entitlements.length === 0 || projected.tier === "none") {
    throw new HttpError(403, "entitlement_required", "No active DMOFT Pro entitlement is available.");
  }
  const subscriptionResult = await database.query<{
    stripe_subscription_id: string;
    current_period_end: Date | null;
  }>(
    `SELECT stripe_subscription_id, current_period_end
       FROM subscriptions
      WHERE account_id = $1
        AND status IN ('active', 'trialing', 'past_due')
        AND stripe_snapshot #>> '{metadata,dmoft_account_id}' = $1::text
        AND stripe_snapshot #>> '{metadata,dmoft_plan}' IN ('pro_monthly', 'pro_annual')
        AND stripe_snapshot #>> '{metadata,dmoft_terms_version}' = $3
      ORDER BY (stripe_subscription_id = $2) DESC,
               current_period_end DESC NULLS LAST,
               stripe_subscription_id
      LIMIT 1`,
    [account.id, preferredSubscriptionId ?? "", CURRENT_TERMS_VERSION],
  );
  const subscription = subscriptionResult.rows[0];
  if (!subscription) {
    throw new HttpError(403, "subscription_required", "No eligible DMOFT Pro subscription is available.");
  }
  return {
    ...projected,
    accountId: account.id,
    stripeCustomerId,
    subscriptionId: subscription.stripe_subscription_id,
    currentPeriodEnd: subscription.current_period_end,
  };
}
