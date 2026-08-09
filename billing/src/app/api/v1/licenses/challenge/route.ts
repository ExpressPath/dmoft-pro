import { createActivationChallenge, createRefreshChallenge } from "@/lib/challenges";
import { getOrCreateAccount } from "@/lib/accounts";
import { authenticate } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { challengeSchema, parseJson } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  try {
    await enforceRateLimit(request, "license-challenge-ip", "global", 30);
    const input = await parseJson(request, challengeSchema);
    const discriminator = input.purpose === "activate" ? input.checkout_session_id : input.device_id;
    await enforceRateLimit(request, `license-challenge-${input.purpose}`, discriminator, 10);
    let challenge;
    if (input.purpose === "activate") {
      const principal = await authenticate(request);
      const account = await getOrCreateAccount(principal.subject);
      challenge = await createActivationChallenge(
        account.id,
        input.checkout_session_id,
        input.device_public_key,
      );
    } else {
      challenge = await createRefreshChallenge(input.device_id, input.device_public_key);
    }
    return Response.json(challenge, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
