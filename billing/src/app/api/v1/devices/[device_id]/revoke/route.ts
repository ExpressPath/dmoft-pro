import { getOrCreateAccount } from "@/lib/accounts";
import { authenticate } from "@/lib/auth";
import { revokeAccountDevice } from "@/lib/devices";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function POST(
  request: Request,
  context: { params: Promise<{ device_id: string }> },
): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "device-revoke", principal.subject, 20);
    const account = await getOrCreateAccount(principal.subject);
    const { device_id: deviceId } = await context.params;
    const result = await revokeAccountDevice(account.id, deviceId);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
