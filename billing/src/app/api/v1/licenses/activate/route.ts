import { getOrCreateAccount } from "@/lib/accounts";
import { authenticate } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { activateDevice } from "@/lib/license-service";
import { enforceRateLimit } from "@/lib/rate-limit";
import { activateSchema, parseJson } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "license-activate-ip", "global", 20);
    const input = await parseJson(request, activateSchema);
    await enforceRateLimit(request, "license-activate", input.checkout_session_id, 10);
    const account = await getOrCreateAccount(principal.subject);
    const license = await activateDevice({
      accountId: account.id,
      challengeId: input.challenge_id,
      checkoutSessionId: input.checkout_session_id,
      devicePublicKey: input.device_public_key,
      deviceName: input.device_name,
      signature: input.signature,
    });
    return Response.json(license, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
