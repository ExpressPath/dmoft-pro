import { timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { parseDevicePublicKey, verifyDeviceSignature, type ChallengePurpose } from "./device-crypto";
import { getEnv } from "./env";
import { HttpError } from "./errors";
import { getLicenseContext, type LicenseContext } from "./entitlements";
import { issueLicenseToken, licenseClaimsSchema, type LicenseClaims } from "./license";
import { CURRENT_TERMS_VERSION } from "./terms";

type ChallengeRow = {
  id: string;
  purpose: ChallengePurpose;
  account_id: string;
  stripe_customer_id: string;
  checkout_session_id: string | null;
  stripe_subscription_id: string | null;
  terms_version: string | null;
  device_id: string;
  device_public_key: Buffer;
  device_key_sha256: string;
  challenge: string;
  expires_at: Date;
  used_at: Date | null;
};

export type LicenseResponse = {
  license_token: string;
  status: "active" | "grace";
  refresh_after: number;
};

function licenseTimes(context: LicenseContext, now: number): {
  exp: number;
  graceUntil: number;
  refreshAfter: number;
} {
  const env = getEnv();
  const configuredExpiry = now + env.LICENSE_TTL_DAYS * 86_400;
  const periodExpiry = context.currentPeriodEnd
    ? Math.floor(context.currentPeriodEnd.getTime() / 1000)
    : configuredExpiry;
  const exp = Math.min(configuredExpiry, periodExpiry);
  if (exp <= now) throw new HttpError(403, "subscription_period_ended", "The subscription period has ended.");
  const graceSeconds = context.offlineGracePermitted ? env.OFFLINE_GRACE_DAYS * 86_400 : 0;
  const graceUntil = exp + graceSeconds;
  const validity = exp - now;
  const desiredRefresh = env.LICENSE_REFRESH_AFTER_DAYS * 86_400;
  const refreshAfter = now + Math.max(1, Math.min(desiredRefresh, Math.floor(validity / 2)));
  return { exp, graceUntil, refreshAfter };
}

function signClaims(claims: LicenseClaims): string {
  const env = getEnv();
  return issueLicenseToken({
    privateKeyPem: env.LICENSE_ED25519_PRIVATE_KEY_PEM,
    keyId: env.LICENSE_KEY_ID,
    claims,
  }).token;
}

async function replayExistingLicense(
  client: PoolClient,
  challengeId: string,
): Promise<LicenseResponse | null> {
  const result = await client.query<{ claims: unknown }>(
    "SELECT claims FROM issued_licenses WHERE challenge_id = $1",
    [challengeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const claims = licenseClaimsSchema.parse(row.claims);
  const now = Math.floor(Date.now() / 1000);
  if (now > claims.grace_until) {
    throw new HttpError(409, "replayed_license_expired", "The previously issued license has expired.");
  }
  const configured = getEnv().LICENSE_REFRESH_AFTER_DAYS * 86_400;
  const desired = claims.iat + Math.max(1, Math.min(configured, Math.floor((claims.exp - claims.iat) / 2)));
  const refreshAfter = Math.min(claims.grace_until, Math.max(now, desired));
  const status = now <= claims.exp ? "active" : "grace";
  return { license_token: signClaims(claims), status, refresh_after: refreshAfter };
}

async function lockedChallenge(client: PoolClient, challengeId: string): Promise<ChallengeRow> {
  const result = await client.query<ChallengeRow>(
    `SELECT id, purpose, account_id, stripe_customer_id, checkout_session_id,
            stripe_subscription_id, terms_version, device_id, device_public_key,
            device_key_sha256, challenge, expires_at, used_at
       FROM license_challenges WHERE id = $1 FOR UPDATE`,
    [challengeId],
  );
  const challenge = result.rows[0];
  if (!challenge) throw new HttpError(404, "challenge_not_found", "License challenge was not found.");
  return challenge;
}

function validateChallengeBindings(input: {
  challenge: ChallengeRow;
  purpose: ChallengePurpose;
  rawPublicKey: Buffer;
  deviceId: string;
  checkoutSessionId?: string;
  signature: string;
}): void {
  if (
    input.challenge.purpose !== input.purpose
    || input.challenge.device_id !== input.deviceId
    || input.challenge.checkout_session_id !== (input.checkoutSessionId ?? null)
    || !timingSafeEqual(input.challenge.device_public_key, input.rawPublicKey)
  ) {
    throw new HttpError(409, "challenge_binding_mismatch", "Challenge does not match this request.");
  }
  if (!verifyDeviceSignature(input.rawPublicKey, input.challenge.challenge, input.signature)) {
    throw new HttpError(403, "invalid_device_signature", "Device signature verification failed.");
  }
}

function requireFreshChallenge(challenge: ChallengeRow): void {
  if (challenge.expires_at.getTime() <= Date.now()) {
    throw new HttpError(409, "challenge_expired", "License challenge has expired.");
  }
}

function claimsFor(
  context: LicenseContext,
  challenge: ChallengeRow,
  now: number,
  exp: number,
  graceUntil: number,
): Omit<LicenseClaims, "jti"> {
  return {
    v: 1,
    iss: getEnv().LICENSE_ISSUER,
    aud: "dmoft-pro",
    sub: context.stripeCustomerId,
    iat: now,
    nbf: now - 5,
    exp,
    grace_until: graceUntil,
    tier: context.tier,
    entitlements: context.entitlements,
    device_id: challenge.device_id,
    device_key_sha256: challenge.device_key_sha256,
    subscription_id: context.subscriptionId,
  };
}

async function persistIssuedLicense(
  client: PoolClient,
  challenge: ChallengeRow,
  context: LicenseContext,
  claims: LicenseClaims,
): Promise<void> {
  await client.query(
    `INSERT INTO issued_licenses
       (jti, challenge_id, account_id, stripe_customer_id, stripe_subscription_id,
        device_id, issued_at, expires_at, grace_until, claims)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), to_timestamp($9), $10::jsonb)`,
    [
      claims.jti,
      challenge.id,
      context.accountId,
      context.stripeCustomerId,
      context.subscriptionId,
      challenge.device_id,
      claims.iat,
      claims.exp,
      claims.grace_until,
      JSON.stringify(claims),
    ],
  );
  await client.query("UPDATE license_challenges SET used_at = now() WHERE id = $1", [challenge.id]);
}

export async function registerDevice(
  client: PoolClient,
  identity: ReturnType<typeof parseDevicePublicKey>,
  context: LicenseContext,
  deviceName: string,
): Promise<void> {
  // Serialize all enrollment decisions for the account so concurrent devices
  // cannot race past an entitlement-derived device limit.
  await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [context.accountId]);
  const existing = await client.query<{ account_id: string; status: string }>(
    "SELECT account_id, status FROM devices WHERE id = $1 FOR UPDATE",
    [identity.deviceId],
  );
  if (existing.rows[0] && existing.rows[0].account_id !== context.accountId) {
    throw new HttpError(409, "device_already_registered", "Device key is registered to another account.");
  }
  if (existing.rows[0]?.status === "revoked") {
    throw new HttpError(403, "device_revoked", "A revoked device key cannot be re-enrolled.");
  }
  if (!existing.rows[0] || existing.rows[0].status !== "active") {
    const count = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM devices WHERE account_id = $1 AND status = 'active'",
      [context.accountId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= context.deviceLimit) {
      throw new HttpError(403, "device_limit_reached", "The subscription device limit has been reached.");
    }
  }
  if (!existing.rows[0]) {
    await client.query(
      `INSERT INTO devices (id, account_id, public_key, public_key_sha256, display_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [identity.deviceId, context.accountId, identity.rawPublicKey, identity.publicKeySha256, deviceName],
    );
  } else {
    await client.query(
      `UPDATE devices SET status = 'active', revoked_at = NULL, display_name = $2, last_seen_at = now()
        WHERE id = $1`,
      [identity.deviceId, deviceName],
    );
  }
}

export async function activateDevice(input: {
  accountId: string;
  challengeId: string;
  checkoutSessionId: string;
  devicePublicKey: string;
  deviceName: string;
  signature: string;
}): Promise<LicenseResponse> {
  const identity = parseDevicePublicKey(input.devicePublicKey);
  return transaction(async (client) => {
    const challenge = await lockedChallenge(client, input.challengeId);
    if (
      challenge.account_id !== input.accountId
      || challenge.stripe_subscription_id === null
      || challenge.terms_version !== CURRENT_TERMS_VERSION
    ) {
      throw new HttpError(403, "account_binding_mismatch", "Challenge belongs to another account or terms version.");
    }
    validateChallengeBindings({
      challenge,
      purpose: "activate",
      rawPublicKey: identity.rawPublicKey,
      deviceId: identity.deviceId,
      checkoutSessionId: input.checkoutSessionId,
      signature: input.signature,
    });
    if (challenge.used_at) {
      const replay = await replayExistingLicense(client, challenge.id);
      if (replay) return replay;
      throw new HttpError(409, "challenge_already_used", "Challenge has already been consumed.");
    }
    requireFreshChallenge(challenge);
    const context = await getLicenseContext(
      challenge.stripe_customer_id,
      challenge.stripe_subscription_id,
      client,
    );
    if (context.accountId !== challenge.account_id) {
      throw new HttpError(403, "account_binding_mismatch", "Challenge account binding is invalid.");
    }
    if (context.subscriptionId !== challenge.stripe_subscription_id) {
      throw new HttpError(403, "subscription_binding_mismatch", "Checkout subscription is no longer eligible.");
    }
    const checkout = await client.query<{
      consumed_at: Date | null;
      stripe_subscription_id: string | null;
      terms_version: string | null;
    }>(
      `SELECT consumed_at, stripe_subscription_id, terms_version FROM checkout_activations
        WHERE stripe_checkout_session_id = $1 AND account_id = $2 FOR UPDATE`,
      [input.checkoutSessionId, context.accountId],
    );
    if (
      !checkout.rows[0]
      || checkout.rows[0].consumed_at
      || checkout.rows[0].stripe_subscription_id !== challenge.stripe_subscription_id
      || checkout.rows[0].terms_version !== CURRENT_TERMS_VERSION
    ) {
      throw new HttpError(409, "checkout_already_activated", "Checkout Session cannot activate another device.");
    }
    await registerDevice(client, identity, context, input.deviceName);
    const now = Math.floor(Date.now() / 1000);
    const times = licenseTimes(context, now);
    const issued = issueLicenseToken({
      privateKeyPem: getEnv().LICENSE_ED25519_PRIVATE_KEY_PEM,
      keyId: getEnv().LICENSE_KEY_ID,
      claims: claimsFor(context, challenge, now, times.exp, times.graceUntil),
    });
    await persistIssuedLicense(client, challenge, context, issued.claims);
    await client.query(
      `UPDATE checkout_activations SET consumed_at = now(), consumed_device_id = $2
        WHERE stripe_checkout_session_id = $1`,
      [input.checkoutSessionId, identity.deviceId],
    );
    return { license_token: issued.token, status: "active", refresh_after: times.refreshAfter };
  });
}

export async function enrollAdditionalDevice(input: {
  accountId: string;
  challengeId: string;
  devicePublicKey: string;
  deviceName: string;
  signature: string;
}): Promise<LicenseResponse> {
  const identity = parseDevicePublicKey(input.devicePublicKey);
  return transaction(async (client) => {
    const challenge = await lockedChallenge(client, input.challengeId);
    if (challenge.account_id !== input.accountId) {
      throw new HttpError(403, "account_binding_mismatch", "Challenge belongs to another account.");
    }
    validateChallengeBindings({
      challenge,
      purpose: "enroll",
      rawPublicKey: identity.rawPublicKey,
      deviceId: identity.deviceId,
      signature: input.signature,
    });
    if (challenge.used_at) {
      const replay = await replayExistingLicense(client, challenge.id);
      if (replay) return replay;
      throw new HttpError(409, "challenge_already_used", "Challenge has already been consumed.");
    }
    requireFreshChallenge(challenge);
    const context = await getLicenseContext(challenge.stripe_customer_id, undefined, client);
    if (context.accountId !== input.accountId) {
      throw new HttpError(403, "account_binding_mismatch", "Billing customer is not linked to this account.");
    }
    await registerDevice(client, identity, context, input.deviceName);
    const now = Math.floor(Date.now() / 1000);
    const times = licenseTimes(context, now);
    const issued = issueLicenseToken({
      privateKeyPem: getEnv().LICENSE_ED25519_PRIVATE_KEY_PEM,
      keyId: getEnv().LICENSE_KEY_ID,
      claims: claimsFor(context, challenge, now, times.exp, times.graceUntil),
    });
    await persistIssuedLicense(client, challenge, context, issued.claims);
    return { license_token: issued.token, status: "active", refresh_after: times.refreshAfter };
  });
}

export async function refreshDeviceLicense(input: {
  challengeId: string;
  deviceId: string;
  devicePublicKey: string;
  signature: string;
}): Promise<LicenseResponse> {
  const identity = parseDevicePublicKey(input.devicePublicKey);
  if (identity.deviceId !== input.deviceId) {
    throw new HttpError(400, "device_binding_mismatch", "Device identifier does not match the public key.");
  }
  return transaction(async (client) => {
    const challenge = await lockedChallenge(client, input.challengeId);
    validateChallengeBindings({
      challenge,
      purpose: "refresh",
      rawPublicKey: identity.rawPublicKey,
      deviceId: identity.deviceId,
      signature: input.signature,
    });
    const device = await client.query<{ account_id: string; status: string }>(
      "SELECT account_id, status FROM devices WHERE id = $1 FOR UPDATE",
      [identity.deviceId],
    );
    if (!device.rows[0] || device.rows[0].status !== "active" || device.rows[0].account_id !== challenge.account_id) {
      throw new HttpError(403, "device_revoked", "Device is not active.");
    }
    if (challenge.used_at) {
      const replay = await replayExistingLicense(client, challenge.id);
      if (replay) return replay;
      throw new HttpError(409, "challenge_already_used", "Challenge has already been consumed.");
    }
    requireFreshChallenge(challenge);
    const context = await getLicenseContext(challenge.stripe_customer_id, undefined, client);
    if (context.accountId !== challenge.account_id) {
      throw new HttpError(403, "account_binding_mismatch", "Challenge account binding is invalid.");
    }
    const now = Math.floor(Date.now() / 1000);
    const times = licenseTimes(context, now);
    const issued = issueLicenseToken({
      privateKeyPem: getEnv().LICENSE_ED25519_PRIVATE_KEY_PEM,
      keyId: getEnv().LICENSE_KEY_ID,
      claims: claimsFor(context, challenge, now, times.exp, times.graceUntil),
    });
    await persistIssuedLicense(client, challenge, context, issued.claims);
    await client.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [identity.deviceId]);
    return { license_token: issued.token, status: "active", refresh_after: times.refreshAfter };
  });
}
