import { createRemoteJWKSet, jwtVerify } from "jose";
import { getEnv } from "./env";
import { HttpError } from "./errors";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export type Principal = { subject: string };

export async function authenticate(request: Request): Promise<Principal> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "authentication_required", "A bearer access token is required.");
  }
  const token = authorization.slice("Bearer ".length);
  const env = getEnv();
  jwks ??= createRemoteJWKSet(new URL(env.OIDC_JWKS_URL));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
      algorithms: ["RS256", "ES256", "EdDSA"],
      clockTolerance: 5,
    });
    if (!payload.sub || payload.sub.length > 255) throw new Error("Missing or invalid subject");
    return { subject: payload.sub };
  } catch {
    throw new HttpError(401, "invalid_access_token", "The access token is invalid or expired.");
  }
}
