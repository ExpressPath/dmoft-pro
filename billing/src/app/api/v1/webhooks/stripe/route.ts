import { getEnv } from "@/lib/env";
import { errorResponse, HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { processStripeEvent } from "@/lib/webhook";

export async function POST(request: Request): Promise<Response> {
  try {
    const env = getEnv();
    const signature = request.headers.get("stripe-signature");
    if (!signature) throw new HttpError(400, "missing_stripe_signature", "Stripe-Signature header is required.");
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > env.WEBHOOK_MAX_BYTES) {
      throw new HttpError(413, "webhook_too_large", "Webhook payload exceeds the configured limit.");
    }
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > env.WEBHOOK_MAX_BYTES) {
      throw new HttpError(413, "webhook_too_large", "Webhook payload exceeds the configured limit.");
    }
    let event;
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new HttpError(400, "invalid_stripe_signature", "Webhook signature verification failed.");
    }
    if (env.NODE_ENV === "production" && !event.livemode) {
      throw new HttpError(400, "stripe_mode_mismatch", "A test-mode event cannot update production state.");
    }
    await processStripeEvent(event);
    return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
