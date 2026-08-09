import { randomUUID } from "node:crypto";
import { authenticate } from "@/lib/auth";
import { ensureStripeCustomer, getOrCreateAccount } from "@/lib/accounts";
import { getEnv } from "@/lib/env";
import { errorResponse, HttpError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { checkoutSchema, parseJson } from "@/lib/schemas";
import { getStripe } from "@/lib/stripe";
import { CURRENT_TERMS_VERSION } from "@/lib/terms";

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "checkout", principal.subject, 10);
    const input = await parseJson(request, checkoutSchema);
    const idempotencyKey = request.headers.get("idempotency-key") ?? randomUUID();
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey)) {
      throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-128 safe ASCII characters.");
    }
    const env = getEnv();
    const account = await getOrCreateAccount(principal.subject);
    const customerId = await ensureStripeCustomer(account);
    const priceId = input.plan === "pro_monthly"
      ? env.STRIPE_PRICE_PRO_MONTHLY
      : env.STRIPE_PRICE_PRO_ANNUAL;
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: account.id,
      line_items: [{ price: priceId, quantity: 1 }],
      consent_collection: { terms_of_service: "required" },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      success_url: `${env.APP_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_BASE_URL}/pricing`,
      metadata: {
        dmoft_account_id: account.id,
        dmoft_plan: input.plan,
        dmoft_terms_version: CURRENT_TERMS_VERSION,
      },
      subscription_data: {
        metadata: {
          dmoft_account_id: account.id,
          dmoft_plan: input.plan,
          dmoft_terms_version: CURRENT_TERMS_VERSION,
        },
      },
    }, { idempotencyKey: `checkout:${account.id}:${idempotencyKey}` });
    if (!session.url) throw new Error("Stripe Checkout Session did not include a URL");
    return Response.json({ checkout_session_id: session.id, url: session.url }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
