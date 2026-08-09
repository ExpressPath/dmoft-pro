import { authenticate } from "@/lib/auth";
import { getOrCreateAccount } from "@/lib/accounts";
import { getEnv } from "@/lib/env";
import { errorResponse, HttpError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "portal", principal.subject, 10);
    const account = await getOrCreateAccount(principal.subject);
    if (!account.stripe_customer_id) {
      throw new HttpError(404, "billing_customer_not_found", "No billing profile exists for this account.");
    }
    const session = await getStripe().billingPortal.sessions.create({
      customer: account.stripe_customer_id,
      return_url: `${getEnv().APP_BASE_URL}/account`,
    });
    return Response.json({ url: session.url }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
