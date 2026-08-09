import { getEnv } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { buildPublicKeyset } from "@/lib/license";

export async function GET(): Promise<Response> {
  try {
    const env = getEnv();
    const keyset = buildPublicKeyset({
      keyId: env.LICENSE_KEY_ID,
      publicKeyPem: env.LICENSE_ED25519_PUBLIC_KEY_PEM,
      configuredJson: env.LICENSE_PUBLIC_KEYSET_JSON,
    });
    return Response.json(keyset, {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
