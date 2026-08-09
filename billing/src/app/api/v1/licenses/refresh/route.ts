import { errorResponse } from "@/lib/errors";
import { refreshDeviceLicense } from "@/lib/license-service";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parseJson, refreshSchema } from "@/lib/schemas";

export async function POST(request: Request): Promise<Response> {
  try {
    await enforceRateLimit(request, "license-refresh-ip", "global", 30);
    const input = await parseJson(request, refreshSchema);
    await enforceRateLimit(request, "license-refresh", input.device_id, 10);
    const license = await refreshDeviceLicense({
      challengeId: input.challenge_id,
      deviceId: input.device_id,
      devicePublicKey: input.device_public_key,
      signature: input.signature,
    });
    return Response.json(license, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
