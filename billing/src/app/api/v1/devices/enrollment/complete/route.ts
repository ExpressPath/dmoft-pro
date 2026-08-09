import { getOrCreateAccount } from "@/lib/accounts";
import { authenticate } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { enrollAdditionalDevice } from "@/lib/license-service";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enrollDeviceSchema, parseJson } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "device-enrollment-complete", principal.subject, 10);
    const input = await parseJson(request, enrollDeviceSchema);
    const account = await getOrCreateAccount(principal.subject);
    const license = await enrollAdditionalDevice({
      accountId: account.id,
      challengeId: input.challenge_id,
      devicePublicKey: input.device_public_key,
      deviceName: input.device_name,
      signature: input.signature,
    });
    return Response.json(license, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
