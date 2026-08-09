import { getOrCreateAccount } from "@/lib/accounts";
import { authenticate } from "@/lib/auth";
import { createEnrollmentChallenge } from "@/lib/challenges";
import { errorResponse, HttpError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enrollmentChallengeSchema, parseJson } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "device-enrollment-challenge", principal.subject, 10);
    const input = await parseJson(request, enrollmentChallengeSchema);
    const account = await getOrCreateAccount(principal.subject);
    if (!account.stripe_customer_id) {
      throw new HttpError(403, "subscription_required", "No DMOFT Pro subscription is linked to this account.");
    }
    const challenge = await createEnrollmentChallenge(account.id, account.stripe_customer_id, input.device_public_key);
    return Response.json(challenge, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
