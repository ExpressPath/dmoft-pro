import type Stripe from "stripe";
import { query, transaction } from "./db";
import { stripeId, syncEntitlementsForCustomer, syncSubscription } from "./stripe-sync";
import { getStripe } from "./stripe";

type ClaimResult = "claimed" | "already_processing" | "processed";

export async function claimStripeEvent(event: Stripe.Event): Promise<ClaimResult> {
  await query(
    `INSERT INTO stripe_events
       (event_id, event_type, event_created_at, livemode, payload, status)
     VALUES ($1, $2, to_timestamp($3), $4, $5::jsonb, 'received')
     ON CONFLICT (event_id) DO NOTHING`,
    [event.id, event.type, event.created, event.livemode, JSON.stringify(event)],
  );
  return transaction(async (client) => {
    const result = await client.query<{
      status: "received" | "processing" | "processed" | "failed";
      processing_started_at: Date | null;
    }>("SELECT status, processing_started_at FROM stripe_events WHERE event_id = $1 FOR UPDATE", [event.id]);
    const row = result.rows[0];
    if (!row) throw new Error("Persisted Stripe event disappeared");
    if (row.status === "processed") return "processed";
    const processingIsFresh = row.status === "processing"
      && row.processing_started_at
      && Date.now() - row.processing_started_at.getTime() < 5 * 60_000;
    if (processingIsFresh) return "already_processing";
    await client.query(
      `UPDATE stripe_events
          SET status = 'processing', processing_started_at = now(), attempts = attempts + 1, last_error = NULL
        WHERE event_id = $1`,
      [event.id],
    );
    return "claimed";
  });
}

function customerFromEvent(event: Stripe.Event): string | null {
  const object = event.data.object as unknown as Record<string, unknown>;
  const candidate = object.customer;
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object" && "id" in candidate) {
    const id = (candidate as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  const claim = await claimStripeEvent(event);
  if (claim === "processed") return;
  if (claim === "already_processing") {
    // A non-2xx response preserves Stripe's retry path if the in-flight worker dies.
    throw new Error(`Stripe event ${event.id} is already being processed`);
  }
  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const delivered = event.data.object as Stripe.Subscription;
        // Stripe does not guarantee event delivery order. Retrieve the current
        // canonical object so an older event cannot overwrite a newer state.
        const subscription = await getStripe().subscriptions.retrieve(delivered.id);
        await syncSubscription(subscription);
        const customerId = stripeId(subscription.customer);
        if (customerId) await syncEntitlementsForCustomer(customerId);
        break;
      }
      case "checkout.session.completed": {
        const customerId = customerFromEvent(event);
        if (customerId) await syncEntitlementsForCustomer(customerId);
        break;
      }
      case "entitlements.active_entitlement_summary.updated": {
        const customerId = customerFromEvent(event);
        if (customerId) await syncEntitlementsForCustomer(customerId);
        break;
      }
      default:
        break;
    }
    await query(
      "UPDATE stripe_events SET status = 'processed', processed_at = now(), last_error = NULL WHERE event_id = $1",
      [event.id],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Unknown processing failure";
    await query("UPDATE stripe_events SET status = 'failed', last_error = $2 WHERE event_id = $1", [event.id, message]);
    throw error;
  }
}
