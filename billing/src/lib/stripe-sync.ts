import type Stripe from "stripe";
import { transaction } from "./db";
import { getStripe } from "./stripe";
import { findAccountByCustomer } from "./accounts";

export function stripeId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

export async function syncEntitlementsForCustomer(stripeCustomerId: string): Promise<void> {
  const entitlements: Array<{
    id: string;
    featureId: string;
    lookupKey: string;
    livemode: boolean;
  }> = [];
  for await (const entitlement of getStripe().entitlements.activeEntitlements.list({
    customer: stripeCustomerId,
    limit: 100,
  })) {
    entitlements.push({
      id: entitlement.id,
      featureId: stripeId(entitlement.feature) ?? "",
      lookupKey: entitlement.lookup_key,
      livemode: entitlement.livemode,
    });
  }
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`entitlements:${stripeCustomerId}`]);
    await client.query("DELETE FROM stripe_entitlements WHERE stripe_customer_id = $1", [stripeCustomerId]);
    for (const entitlement of entitlements) {
      await client.query(
        `INSERT INTO stripe_entitlements
           (stripe_customer_id, stripe_entitlement_id, feature_id, lookup_key, livemode, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [stripeCustomerId, entitlement.id, entitlement.featureId, entitlement.lookupKey, entitlement.livemode],
      );
    }
  });
}

function subscriptionCurrentPeriodEnd(subscription: Stripe.Subscription): number | null {
  const ends = subscription.items.data.map((item) => item.current_period_end).filter(Number.isFinite);
  // A multi-item subscription may have mixed billing periods. Cap offline access
  // at the earliest boundary; Entitlements will be synchronized again on refresh.
  return ends.length > 0 ? Math.min(...ends) : null;
}

export async function syncSubscription(subscription: Stripe.Subscription): Promise<void> {
  const customerId = stripeId(subscription.customer);
  if (!customerId) return;
  await transaction(async (client) => {
    const account = await findAccountByCustomer(client, customerId);
    if (!account) return;
    const periodEnd = subscriptionCurrentPeriodEnd(subscription);
    await client.query(
      `INSERT INTO subscriptions
         (stripe_subscription_id, account_id, stripe_customer_id, status,
          current_period_end, cancel_at_period_end, stripe_snapshot, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5) END,
               $6, $7::jsonb, now())
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         stripe_snapshot = EXCLUDED.stripe_snapshot,
         updated_at = now()`,
      [
        subscription.id,
        account.id,
        customerId,
        subscription.status,
        periodEnd,
        subscription.cancel_at_period_end,
        JSON.stringify({
          id: subscription.id,
          status: subscription.status,
          livemode: subscription.livemode,
          metadata: {
            dmoft_account_id: subscription.metadata.dmoft_account_id ?? null,
            dmoft_plan: subscription.metadata.dmoft_plan ?? null,
            dmoft_terms_version: subscription.metadata.dmoft_terms_version ?? null,
          },
        }),
      ],
    );
  });
}

export async function refreshCustomerBillingProjection(
  stripeCustomerId: string,
  subscription?: Stripe.Subscription,
): Promise<void> {
  if (subscription) {
    await syncSubscription(subscription);
  } else {
    for await (const current of getStripe().subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 100,
    })) {
      await syncSubscription(current);
    }
  }
  await syncEntitlementsForCustomer(stripeCustomerId);
}
