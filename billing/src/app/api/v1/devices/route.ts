import { getOrCreateAccount } from "@/lib/accounts";
import { authenticate } from "@/lib/auth";
import { listAccountDevices } from "@/lib/devices";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(request: Request): Promise<Response> {
  try {
    const principal = await authenticate(request);
    await enforceRateLimit(request, "device-list", principal.subject, 30);
    const account = await getOrCreateAccount(principal.subject);
    const result = await listAccountDevices(account.id);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
